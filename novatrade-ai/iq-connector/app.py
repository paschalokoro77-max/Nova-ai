"""Experimental, self-hosted IQ Option read-only connector.
Credentials are read from local environment variables, never accepted over HTTP unless explicitly passed by NovaTrade server vault.
Supports read-only account/balance/market/history inspection in PRACTICE or REAL mode without placing orders.
Never silently switches REAL to PRACTICE or returns PRACTICE balances under a REAL label.
"""
import asyncio
import base64
import contextlib
import json
import logging
import math
import os
import re
import socket
import ssl
import threading
import time
import urllib.parse
from typing import Any, Callable, Dict, List, Optional, Tuple, TypeVar
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

app = FastAPI(title='NovaTrade IQ Option connector', version='0.5.3')

_WS_PRIMARY_URL = 'wss://iqoption.com/echo/websocket'
_WS_FALLBACK_URL = 'wss://ws.iqoption.com/echo/websocket'
_WS_ORIGIN = 'https://iqoption.com'
_WS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
_AUTH_LOGIN_URL = 'https://auth.iqoption.com/api/v2/login'

_LOCK_ACQUIRE_TIMEOUT = float(os.environ.get('IQ_LOCK_TIMEOUT_SECONDS', '4.0'))
_WS_CONNECT_TIMEOUT = float(os.environ.get('IQ_WS_CONNECT_TIMEOUT_SECONDS', '6.0'))
_CONNECT_TIMEOUT = float(os.environ.get('IQ_CONNECT_TIMEOUT_SECONDS', '18.0'))
_BALANCE_TIMEOUT = float(os.environ.get('IQ_BALANCE_TIMEOUT_SECONDS', '6.0'))
_CANDLES_TIMEOUT = float(os.environ.get('IQ_CANDLES_TIMEOUT_SECONDS', '7.0'))
_MODE_TIMEOUT = float(os.environ.get('IQ_MODE_TIMEOUT_SECONDS', '5.0'))
_HISTORY_TIMEOUT = float(os.environ.get('IQ_HISTORY_TIMEOUT_SECONDS', '6.0'))
_ASSETS_TIMEOUT = float(os.environ.get('IQ_ASSETS_TIMEOUT_SECONDS', '8.0'))
_ORDER_TIMEOUT = float(os.environ.get('IQ_ORDER_TIMEOUT_SECONDS', '8.0'))
_POSITIONS_TIMEOUT = float(os.environ.get('IQ_POSITIONS_TIMEOUT_SECONDS', '6.0'))
_BALANCE_CACHE_TTL_SECONDS = float(os.environ.get('IQ_BALANCE_CACHE_TTL_SECONDS', '2.5'))
_CLOSE_TIMEOUT = 1.5
_HTTP_CONNECT_TIMEOUT = float(os.environ.get('IQ_HTTP_CONNECT_TIMEOUT_SECONDS', '6.0'))
_HTTP_TIMEOUT = float(os.environ.get('IQ_HTTP_READ_TIMEOUT_SECONDS', '10.0'))

_lock = threading.RLock()
_state_lock = threading.Lock()
_worker_ctx = threading.local()
_client: Any = None
_session_generation: int = 0
_inflight_connect: Optional['_InFlightConnect'] = None
_busy_operation: Optional[str] = None
_last_connect_stage: Optional[str] = None
_last_connect_duration_ms: Optional[float] = None
_last_error: Optional[str] = None
_connected_at: Optional[float] = None
_requested_mode: str = 'AUTO'
_confirmed_mode: str = 'UNVERIFIED'
_mode_verified: bool = False
_broker_wallet_confirmed: bool = False
_active_balance_id: Any = None
_active_currency: str = 'USD'
_mode_detection_diag: Optional[dict] = None
_active_ws_url: Optional[str] = None
_active_ws_via_proxy: bool = False
_last_ws_diagnostics: Optional[List[dict]] = None
_last_candle_check: Optional[dict] = None
_last_balance_cache: Optional[dict] = None
_tracked_orders: Dict[str, dict] = {}
_idempotency_index: Dict[str, str] = {}
_opcodes_updated: bool = False
_iqoptionapi_patched: bool = False


class _InFlightConnect:
    """Tracks a single active upstream connection attempt so concurrent callers coalesce safely."""

    def __init__(self, generation: int, target_mode: str):
        self.generation = generation
        self.target_mode = target_mode
        self.done = threading.Event()
        self.cancel_event = threading.Event()
        self.client_ref: Any = None
        self.result_client: Any = None
        self.error: Optional[BaseException] = None
        self.started_at = time.monotonic()


def _is_worker_cancelled() -> bool:
    """Return True if the current connect worker was cancelled or superseded by a newer session generation."""
    cancel_ev = getattr(_worker_ctx, 'cancel_event', None)
    if cancel_ev is not None and cancel_ev.is_set():
        return True
    worker_gen = getattr(_worker_ctx, 'generation', None)
    if worker_gen is not None and worker_gen != _session_generation:
        return True
    return False


def _remaining_connect_budget(fallback_seconds: float) -> float:
    """Cap an inner stage timeout to the shared connect wall-clock deadline when running inside connect()."""
    deadline = getattr(_worker_ctx, 'deadline', None)
    if deadline is None:
        return float(fallback_seconds)
    remaining = deadline - time.monotonic()
    return max(0.05, min(float(fallback_seconds), remaining))


def _set_connect_stage(stage: str) -> None:
    global _last_connect_stage
    if not _is_worker_cancelled():
        _last_connect_stage = stage


T = TypeVar('T')

_URL_USERINFO_RE = re.compile(r'((?:https?|wss?|socks5h?)://)([^@\s/]+)@', re.IGNORECASE)
_AUTH_HEADER_RE = re.compile(r'((?:proxy-)?authorization\s*[:=]\s*(?:basic|bearer)\s+)\S+', re.IGNORECASE)


def _parse_finite_float(val: Any) -> Optional[float]:
    """Return a finite float or None; rejects None, bool, NaN, Inf, and non-numeric values."""
    if val is None or isinstance(val, bool):
        return None
    try:
        num = float(val)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num):
        return None
    return num


def _normalize_candle_bar(raw: Any) -> Optional[dict]:
    """Validate and normalize a broker candle dict; returns None if timestamp or OHLCV is invalid."""
    if not isinstance(raw, dict):
        return None
    ts_raw = raw.get('from') if raw.get('from') is not None else (raw.get('time') if raw.get('time') is not None else raw.get('at'))
    ts_num = _parse_finite_float(ts_raw)
    if ts_num is None or ts_num <= 0:
        return None
    # Normalize millisecond timestamps down to Unix seconds if broker returns ms
    ts_sec = int(ts_num / 1000) if ts_num > 1e11 else int(ts_num)

    o = _parse_finite_float(raw.get('open'))
    h = _parse_finite_float(raw.get('max') if raw.get('max') is not None else raw.get('high'))
    l = _parse_finite_float(raw.get('min') if raw.get('min') is not None else raw.get('low'))
    c = _parse_finite_float(raw.get('close'))
    if o is None or h is None or l is None or c is None:
        return None
    if o <= 0 or h <= 0 or l <= 0 or c <= 0 or h < l:
        return None

    vol_raw = raw.get('volume')
    if vol_raw is None:
        vol = 0.0
    else:
        vol = _parse_finite_float(vol_raw)
        if vol is None or vol < 0:
            return None

    return {
        'time': ts_sec,
        'open': o,
        'high': h,
        'low': l,
        'close': c,
        'volume': vol,
    }


def _get_proxy_url() -> Optional[str]:
    """Return validated opt-in HTTP/HTTPS CONNECT proxy URL from IQ_PROXY_URL, or None when disabled."""
    raw = (os.environ.get('IQ_PROXY_URL') or '').strip()
    if not raw:
        return None
    parsed = urllib.parse.urlparse(raw)
    scheme = (parsed.scheme or '').lower()
    if scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError('Invalid IQ_PROXY_URL configuration; expected http:// or https:// URL with hostname.')
    return raw


def _get_ws_proxy_mode() -> str:
    """Return WebSocket proxy routing mode: 'direct' (default), 'proxy' (IQ_PROXY_WS=true), or 'auto' (fallback)."""
    try:
        if not _get_proxy_url():
            return 'direct'
    except ValueError:
        return 'direct'
    raw = (os.environ.get('IQ_PROXY_WS') or '').strip().lower()
    if raw in ('1', 'true', 'yes'):
        return 'proxy'
    if raw == 'auto':
        return 'auto'
    return 'direct'


def _is_ws_proxy_enabled() -> bool:
    """Keep WebSocket traffic direct by default unless IQ_PROXY_WS is explicitly enabled."""
    return _get_ws_proxy_mode() in ('proxy', 'auto')


def _redact_proxy_url(raw_url: Optional[str]) -> Optional[str]:
    """Return scheme://host[:port] with all embedded credentials stripped."""
    if not raw_url:
        return None
    try:
        parsed = urllib.parse.urlparse(str(raw_url).strip())
        if not parsed.scheme or not parsed.hostname:
            return None
        port_suffix = f':{parsed.port}' if parsed.port else ''
        return f'{parsed.scheme.lower()}://{parsed.hostname}{port_suffix}'
    except Exception:
        return None


def _get_requests_proxies() -> Optional[Dict[str, str]]:
    """Return requests proxy dict when IQ_PROXY_URL is configured, or None for direct connections."""
    proxy_url = _get_proxy_url()
    if not proxy_url:
        return None
    return {'http': proxy_url, 'https': proxy_url}


def _build_ws_proxy_kwargs_from_url(proxy_url: Optional[str]) -> Dict[str, Any]:
    """Build websocket-client HTTP CONNECT proxy kwargs (compatible with websocket-client 0.56.0 + Webshare)."""
    if not proxy_url:
        return {}
    parsed = urllib.parse.urlparse(proxy_url)
    scheme = (parsed.scheme or '').lower()
    if scheme != 'http' or not parsed.hostname:
        # websocket-client==0.56.0 proxy_type='http' opens plain TCP to the proxy then sends HTTP CONNECT + TLS to target
        return {}
    port = parsed.port or 8080
    kwargs: Dict[str, Any] = {
        'http_proxy_host': parsed.hostname,
        'http_proxy_port': int(port),
        'proxy_type': 'http',
    }
    if parsed.username is not None:
        kwargs['http_proxy_auth'] = (
            urllib.parse.unquote(parsed.username),
            urllib.parse.unquote(parsed.password or ''),
        )
    return kwargs


def _get_ws_proxy_kwargs() -> Dict[str, Any]:
    """Return websocket-client proxy kwargs ONLY when IQ_PROXY_WS=true and IQ_PROXY_URL is an http:// proxy."""
    if _get_ws_proxy_mode() != 'proxy':
        return {}
    return _build_ws_proxy_kwargs_from_url(_get_proxy_url())


def _sanitize_error(msg: str, extra_secrets: Tuple[Optional[str], ...] = ()) -> str:
    cleaned = str(msg or '')
    cleaned = _URL_USERINFO_RE.sub(r'\1***@', cleaned)
    cleaned = _AUTH_HEADER_RE.sub(r'\1***', cleaned)

    secrets: List[str] = [
        (os.environ.get('IQ_EMAIL') or '').strip(),
        (os.environ.get('IQ_PASSWORD') or '').strip(),
        (os.environ.get('IQ_CONNECTOR_TOKEN') or '').strip(),
    ]
    raw_proxy = (os.environ.get('IQ_PROXY_URL') or '').strip()
    if raw_proxy:
        secrets.append(raw_proxy)
        try:
            parsed = urllib.parse.urlparse(raw_proxy)
            for part in (parsed.username, parsed.password):
                if part:
                    secrets.append(part)
                    unquoted = urllib.parse.unquote(part)
                    if unquoted and unquoted != part:
                        secrets.append(unquoted)
            if parsed.username is not None:
                raw_auth = f'{urllib.parse.unquote(parsed.username)}:{urllib.parse.unquote(parsed.password or "")}'
                secrets.append(base64.b64encode(raw_auth.encode('utf-8')).decode('ascii'))
        except Exception:
            pass

    for s in extra_secrets:
        if s and str(s).strip():
            secrets.append(str(s).strip())

    # Replace longest secrets first to avoid partial remnants
    for secret in sorted(set(s for s in secrets if s), key=len, reverse=True):
        if secret in cleaned:
            cleaned = cleaned.replace(secret, '***')
    return cleaned[:480]


@app.exception_handler(Exception)
async def _unhandled_exception_handler(_request: Request, exc: Exception):
    return JSONResponse(
        status_code=502,
        content={
            'detail': f'IQ Option connector internal error ({type(exc).__name__}).',
            'orderExecutionSupported': True,
            'modeFollowsBroker': True,
        },
    )


@contextlib.contextmanager
def _bounded_lock(timeout: Optional[float] = None, op_name: str = 'operation'):
    global _busy_operation
    wait = _LOCK_ACQUIRE_TIMEOUT if timeout is None else timeout
    acquired = _lock.acquire(timeout=wait)
    if not acquired:
        raise HTTPException(
            503,
            'IQ Option connector is busy with an upstream broker operation; please retry shortly.',
        )
    prev_op = _busy_operation
    _busy_operation = op_name
    try:
        yield
    finally:
        _busy_operation = prev_op
        _lock.release()


def _run_with_timeout(
    fn: Callable[[], T],
    timeout_seconds: float,
    op_name: str,
    cancel_event: Optional[threading.Event] = None,
    generation: Optional[int] = None,
    deadline: Optional[float] = None,
) -> T:
    """Execute a potentially blocking broker call on a daemon thread with a strict wall-clock cap and cooperative cancellation."""
    result_box: dict = {}
    error_box: dict = {}

    def _target():
        _worker_ctx.cancel_event = cancel_event
        _worker_ctx.generation = generation
        _worker_ctx.deadline = deadline
        try:
            result_box['value'] = fn()
        except BaseException as exc:
            error_box['error'] = exc
        finally:
            _worker_ctx.cancel_event = None
            _worker_ctx.generation = None
            _worker_ctx.deadline = None

    worker = threading.Thread(target=_target, name=f'iq-op-{op_name}', daemon=True)
    worker.start()
    worker.join(timeout=timeout_seconds)
    if worker.is_alive():
        if cancel_event is not None:
            cancel_event.set()
        raise TimeoutError(f'{op_name} timed out after {timeout_seconds:.1f}s.')
    if 'error' in error_box:
        raise error_box['error']
    return result_box.get('value')


def _reset_iq_global_locks():
    """Clear leaked iqoptionapi global mutex flags if the package is loaded."""
    try:
        import iqoptionapi.global_value as global_value
        global_value.ssl_Mutual_exclusion = False
        global_value.ssl_Mutual_exclusion_write = False
    except Exception:
        pass


def _safe_close_client(client: Any, timeout_seconds: Optional[float] = None, reset_globals: bool = True):
    """Best-effort, strictly bounded teardown of an IQ Option client and its WebSocket thread.
    Pass reset_globals=False when closing an abandoned/superseded client so a newer session's global flags are untouched.
    """
    if client is None:
        return
    timeout = _CLOSE_TIMEOUT if timeout_seconds is None else timeout_seconds

    def _do_close():
        api = getattr(client, 'api', None)
        if api is not None:
            ws_client = getattr(api, 'websocket_client', None)
            wss = getattr(ws_client, 'wss', None) if ws_client is not None else None
            if wss is not None:
                try:
                    wss.close()
                except Exception:
                    pass
            ws_thread = getattr(api, 'websocket_thread', None)
            if ws_thread is not None and ws_thread is not threading.current_thread():
                try:
                    ws_thread.join(timeout=timeout)
                except Exception:
                    pass
            session = getattr(api, 'session', None)
            if session is not None:
                try:
                    session.close()
                except Exception:
                    pass
        elif hasattr(client, 'close'):
            try:
                client.close()
            except Exception:
                pass

    try:
        _run_with_timeout(_do_close, timeout + 0.5, 'close_client')
    except Exception:
        pass
    finally:
        if reset_globals:
            try:
                import iqoptionapi.global_value as global_value
                global_value.check_websocket_if_connect = 0
                global_value.ssl_Mutual_exclusion = False
                global_value.ssl_Mutual_exclusion_write = False
            except Exception:
                pass


def _invalidate_balance_cache():
    global _last_balance_cache
    with _state_lock:
        _last_balance_cache = None


def _invalidate_client(reason: Optional[str] = None, cancel_inflight: bool = False):
    global _client, _connected_at, _confirmed_mode, _mode_verified, _broker_wallet_confirmed, _active_balance_id, _mode_detection_diag
    global _active_ws_url, _active_ws_via_proxy, _opcodes_updated, _last_error, _session_generation, _last_balance_cache
    with _state_lock:
        _session_generation += 1
        old_client = _client
        _client = None
        _connected_at = None
        _confirmed_mode = 'UNVERIFIED'
        _mode_verified = False
        _broker_wallet_confirmed = False
        _active_balance_id = None
        _mode_detection_diag = None
        _active_ws_url = None
        _active_ws_via_proxy = False
        _opcodes_updated = False
        _last_balance_cache = None
        if reason:
            _last_error = _sanitize_error(reason)
        if cancel_inflight and _inflight_connect is not None:
            _inflight_connect.cancel_event.set()
            inflight_client = _inflight_connect.client_ref
        else:
            inflight_client = None
    if old_client is not None:
        _safe_close_client(old_client, reset_globals=True)
    if inflight_client is not None and inflight_client is not old_client:
        _safe_close_client(inflight_client, reset_globals=False)


def _get_ws_candidates(preferred_url: Optional[str] = None) -> List[str]:
    """Return ordered, deduplicated WebSocket endpoints (env override -> primary -> fallback)."""
    raw_list: List[str] = []
    env_override = (os.environ.get('IQ_WS_URL') or '').strip()
    if env_override:
        raw_list.append(env_override)
    if preferred_url and str(preferred_url).strip():
        raw_list.append(str(preferred_url).strip())
    raw_list.append(_WS_PRIMARY_URL)
    raw_list.append(_WS_FALLBACK_URL)
    deduped: List[str] = []
    for url in raw_list:
        if url and url not in deduped:
            deduped.append(url)
    return deduped


def _probe_ws_endpoint(
    ws_url: str,
    timeout_seconds: Optional[float] = None,
    include_upgrade: bool = False,
    verify_tls: bool = False,
) -> dict:
    """Run bounded DNS -> TCP -> TLS (-> optional HTTP/1.1 WS Upgrade) diagnostics on an endpoint URL."""
    budget = _WS_CONNECT_TIMEOUT if timeout_seconds is None else float(timeout_seconds)
    deadline = time.monotonic() + budget
    parsed = urllib.parse.urlparse(ws_url)
    scheme = (parsed.scheme or 'wss').lower()
    host = parsed.hostname or ''
    port = parsed.port or (443 if scheme in ('wss', 'https') else 80)
    path = parsed.path or '/echo/websocket'
    if parsed.query:
        path = f'{path}?{parsed.query}'

    diag: dict = {
        'url': ws_url,
        'host': host,
        'port': port,
        'ok': False,
        'stage': 'dns',
        'resolvedIps': [],
        'dnsMs': None,
        'tcpMs': None,
        'tlsMs': None,
        'upgradeMs': None,
        'tlsVersion': None,
        'httpStatus': None,
        'error': None,
    }
    if not host:
        diag['error'] = 'Invalid WebSocket URL (missing hostname).'
        return diag

    # Stage 1: DNS resolution
    t_dns = time.monotonic()
    try:
        addr_infos = _run_with_timeout(
            lambda: socket.getaddrinfo(host, port, type=socket.SOCK_STREAM),
            max(0.2, deadline - time.monotonic()),
            f'dns_{host}',
        )
        ipv4 = [info[4][0] for info in addr_infos if info[0] == socket.AF_INET]
        ipv6 = [info[4][0] for info in addr_infos if info[0] == socket.AF_INET6]
        ordered_ips = list(dict.fromkeys(ipv4 + ipv6))
        diag['dnsMs'] = round((time.monotonic() - t_dns) * 1000, 1)
        diag['resolvedIps'] = ordered_ips[:4]
        if not ordered_ips:
            diag['error'] = f'DNS returned no addresses for {host}.'
            return diag
    except TimeoutError:
        diag['dnsMs'] = round((time.monotonic() - t_dns) * 1000, 1)
        diag['error'] = f'DNS lookup timed out for {host} after {budget:.1f}s.'
        return diag
    except Exception as exc:
        diag['dnsMs'] = round((time.monotonic() - t_dns) * 1000, 1)
        diag['error'] = _sanitize_error(f'DNS lookup failed for {host}: {type(exc).__name__}: {exc}')
        return diag

    raw_sock: Optional[socket.socket] = None
    active_sock: Any = None
    try:
        # Stage 2: TCP connect
        diag['stage'] = 'tcp'
        remaining = deadline - time.monotonic()
        if remaining <= 0.05:
            diag['error'] = f'TCP connect budget exhausted ({budget:.1f}s) before connecting to {host}:{port}.'
            return diag
        t_tcp = time.monotonic()
        target_ip = ordered_ips[0]
        try:
            raw_sock = socket.create_connection((target_ip, port), timeout=remaining)
            diag['tcpMs'] = round((time.monotonic() - t_tcp) * 1000, 1)
        except socket.timeout:
            diag['tcpMs'] = round((time.monotonic() - t_tcp) * 1000, 1)
            diag['error'] = f'TCP connect timed out to {host} ({target_ip}:{port}) after {remaining:.1f}s.'
            return diag
        except Exception as exc:
            diag['tcpMs'] = round((time.monotonic() - t_tcp) * 1000, 1)
            diag['error'] = _sanitize_error(f'TCP connect failed to {host} ({target_ip}:{port}): {type(exc).__name__}: {exc}')
            return diag

        active_sock = raw_sock

        # Stage 3: TLS handshake
        if scheme in ('wss', 'https'):
            diag['stage'] = 'tls'
            remaining = deadline - time.monotonic()
            if remaining <= 0.05:
                diag['error'] = f'TLS handshake budget exhausted ({budget:.1f}s) for {host}.'
                return diag
            t_tls = time.monotonic()
            try:
                raw_sock.settimeout(remaining)
                if verify_tls:
                    ctx = ssl.create_default_context()
                else:
                    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                tls_sock = ctx.wrap_socket(raw_sock, server_hostname=host)
                diag['tlsMs'] = round((time.monotonic() - t_tls) * 1000, 1)
                diag['tlsVersion'] = tls_sock.version()
                active_sock = tls_sock
            except socket.timeout:
                diag['tlsMs'] = round((time.monotonic() - t_tls) * 1000, 1)
                diag['error'] = f'TLS handshake timed out for {host} after {remaining:.1f}s.'
                return diag
            except Exception as exc:
                diag['tlsMs'] = round((time.monotonic() - t_tls) * 1000, 1)
                diag['error'] = _sanitize_error(f'TLS handshake failed for {host}: {type(exc).__name__}: {exc}')
                return diag

        # Stage 4: Optional HTTP/1.1 WebSocket Upgrade probe
        if include_upgrade and scheme in ('ws', 'wss'):
            diag['stage'] = 'ws_upgrade'
            remaining = deadline - time.monotonic()
            if remaining <= 0.05:
                diag['error'] = f'WebSocket upgrade budget exhausted ({budget:.1f}s) for {host}.'
                return diag
            t_up = time.monotonic()
            try:
                active_sock.settimeout(remaining)
                ws_key = base64.b64encode(os.urandom(16)).decode('ascii')
                req_lines = [
                    f'GET {path} HTTP/1.1',
                    f'Host: {host}',
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    f'Sec-WebSocket-Key: {ws_key}',
                    'Sec-WebSocket-Version: 13',
                    f'Origin: {_WS_ORIGIN}',
                    f'User-Agent: {_WS_USER_AGENT}',
                    '',
                    '',
                ]
                active_sock.sendall('\r\n'.join(req_lines).encode('ascii'))
                resp_buf = b''
                while b'\r\n\r\n' not in resp_buf and len(resp_buf) < 4096:
                    chunk = active_sock.recv(1024)
                    if not chunk:
                        break
                    resp_buf += chunk
                diag['upgradeMs'] = round((time.monotonic() - t_up) * 1000, 1)
                status_line = resp_buf.split(b'\r\n', 1)[0].decode('latin1', errors='replace').strip()
                parts = status_line.split(' ', 2)
                status_code = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else None
                diag['httpStatus'] = status_code
                if status_code != 101:
                    diag['error'] = f'WebSocket upgrade rejected by {host}: {status_line or "empty response"}'
                    return diag
            except socket.timeout:
                diag['upgradeMs'] = round((time.monotonic() - t_up) * 1000, 1)
                diag['error'] = f'WebSocket upgrade timed out for {host} after {remaining:.1f}s.'
                return diag
            except Exception as exc:
                diag['upgradeMs'] = round((time.monotonic() - t_up) * 1000, 1)
                diag['error'] = _sanitize_error(f'WebSocket upgrade failed for {host}: {type(exc).__name__}: {exc}')
                return diag

        diag['stage'] = 'ok'
        diag['ok'] = True
        return diag
    finally:
        for sock_obj in (active_sock, raw_sock):
            if sock_obj is not None:
                try:
                    sock_obj.close()
                except Exception:
                    pass


def _probe_https_endpoint(url: str, timeout_seconds: Optional[float] = None) -> dict:
    """Read-only DNS -> TCP -> verified TLS probe for HTTPS endpoints such as auth.iqoption.com."""
    return _probe_ws_endpoint(url, timeout_seconds=timeout_seconds, include_upgrade=False, verify_tls=True)


def _probe_https_via_proxy(
    target_url: str,
    proxy_url: str,
    timeout_seconds: Optional[float] = None,
    include_upgrade: bool = False,
    verify_tls: bool = True,
) -> dict:
    """Read-only HTTP CONNECT tunnel + TLS (-> optional WS 101 upgrade) probe via proxy_url (sends zero IQ credentials)."""
    budget = _HTTP_CONNECT_TIMEOUT if timeout_seconds is None else float(timeout_seconds)
    deadline = time.monotonic() + budget
    t_parsed = urllib.parse.urlparse(target_url)
    p_parsed = urllib.parse.urlparse(proxy_url)
    target_host = t_parsed.hostname or ''
    target_port = t_parsed.port or 443
    target_path = t_parsed.path or '/echo/websocket'
    if t_parsed.query:
        target_path = f'{target_path}?{t_parsed.query}'
    proxy_host = p_parsed.hostname or ''
    proxy_port = p_parsed.port or (443 if (p_parsed.scheme or '').lower() == 'https' else 8080)

    diag: dict = {
        'url': target_url,
        'proxy': _redact_proxy_url(proxy_url),
        'target': f'{target_host}:{target_port}',
        'viaProxy': True,
        'ok': False,
        'stage': 'proxy_tcp',
        'proxyMs': None,
        'tlsMs': None,
        'upgradeMs': None,
        'tlsVersion': None,
        'tlsVerified': bool(verify_tls),
        'httpStatus': None,
        'upgradeStatus': None,
        'error': None,
    }
    if not proxy_host or not target_host:
        diag['error'] = 'Invalid proxy or target host.'
        return diag

    raw_sock: Optional[socket.socket] = None
    active_sock: Any = None
    try:
        t_proxy = time.monotonic()
        try:
            raw_sock = socket.create_connection((proxy_host, proxy_port), timeout=max(0.2, deadline - time.monotonic()))
        except socket.timeout:
            diag['proxyMs'] = round((time.monotonic() - t_proxy) * 1000, 1)
            diag['error'] = f'TCP connect to proxy timed out after {budget:.1f}s.'
            return diag
        except Exception as exc:
            diag['proxyMs'] = round((time.monotonic() - t_proxy) * 1000, 1)
            diag['error'] = _sanitize_error(f'TCP connect to proxy failed: {type(exc).__name__}: {exc}')
            return diag

        active_sock = raw_sock
        if (p_parsed.scheme or '').lower() == 'https':
            diag['stage'] = 'proxy_tls'
            remaining = deadline - time.monotonic()
            if remaining <= 0.05:
                diag['error'] = 'Proxy TLS budget exhausted.'
                return diag
            try:
                raw_sock.settimeout(remaining)
                p_ctx = ssl.create_default_context()
                active_sock = p_ctx.wrap_socket(raw_sock, server_hostname=proxy_host)
            except Exception as exc:
                diag['error'] = _sanitize_error(f'Proxy TLS handshake failed: {type(exc).__name__}: {exc}')
                return diag

        diag['stage'] = 'proxy_connect'
        remaining = deadline - time.monotonic()
        if remaining <= 0.05:
            diag['error'] = 'Proxy CONNECT tunnel budget exhausted.'
            return diag
        try:
            active_sock.settimeout(remaining)
            req_lines = [
                f'CONNECT {target_host}:{target_port} HTTP/1.1',
                f'Host: {target_host}:{target_port}',
                'Proxy-Connection: Keep-Alive',
            ]
            if p_parsed.username is not None:
                creds = f'{urllib.parse.unquote(p_parsed.username)}:{urllib.parse.unquote(p_parsed.password or "")}'
                b64 = base64.b64encode(creds.encode('utf-8')).decode('ascii')
                req_lines.append(f'Proxy-Authorization: Basic {b64}')
            req_lines.extend(['', ''])
            active_sock.sendall('\r\n'.join(req_lines).encode('ascii'))
            resp_buf = b''
            while b'\r\n\r\n' not in resp_buf and len(resp_buf) < 4096:
                chunk = active_sock.recv(1024)
                if not chunk:
                    break
                resp_buf += chunk
            diag['proxyMs'] = round((time.monotonic() - t_proxy) * 1000, 1)
            status_line = resp_buf.split(b'\r\n', 1)[0].decode('latin1', errors='replace').strip()
            parts = status_line.split(' ', 2)
            status_code = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else None
            diag['httpStatus'] = status_code
            if status_code != 200:
                diag['error'] = _sanitize_error(f'Proxy CONNECT rejected tunnel: HTTP {status_code or "unknown"}')
                return diag
        except socket.timeout:
            diag['proxyMs'] = round((time.monotonic() - t_proxy) * 1000, 1)
            diag['error'] = 'Proxy CONNECT handshake timed out.'
            return diag
        except Exception as exc:
            diag['proxyMs'] = round((time.monotonic() - t_proxy) * 1000, 1)
            diag['error'] = _sanitize_error(f'Proxy CONNECT failed: {type(exc).__name__}: {exc}')
            return diag

        diag['stage'] = 'tls'
        remaining = deadline - time.monotonic()
        if remaining <= 0.05:
            diag['error'] = 'Target TLS budget exhausted after proxy CONNECT.'
            return diag
        t_tls = time.monotonic()
        try:
            active_sock.settimeout(remaining)
            if verify_tls:
                ctx = ssl.create_default_context()
            else:
                ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            tls_sock = ctx.wrap_socket(active_sock, server_hostname=target_host)
            diag['tlsMs'] = round((time.monotonic() - t_tls) * 1000, 1)
            diag['tlsVersion'] = tls_sock.version()
            active_sock = tls_sock
        except socket.timeout:
            diag['tlsMs'] = round((time.monotonic() - t_tls) * 1000, 1)
            diag['error'] = f'TLS handshake through proxy timed out for {target_host}.'
            return diag
        except Exception as exc:
            diag['tlsMs'] = round((time.monotonic() - t_tls) * 1000, 1)
            diag['error'] = _sanitize_error(f'TLS verification through proxy failed for {target_host}: {type(exc).__name__}: {exc}')
            return diag

        if include_upgrade:
            diag['stage'] = 'ws_upgrade'
            remaining = deadline - time.monotonic()
            if remaining <= 0.05:
                diag['error'] = f'WebSocket upgrade through proxy budget exhausted for {target_host}.'
                return diag
            t_up = time.monotonic()
            try:
                active_sock.settimeout(remaining)
                ws_key = base64.b64encode(os.urandom(16)).decode('ascii')
                up_lines = [
                    f'GET {target_path} HTTP/1.1',
                    f'Host: {target_host}',
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    f'Sec-WebSocket-Key: {ws_key}',
                    'Sec-WebSocket-Version: 13',
                    f'Origin: {_WS_ORIGIN}',
                    f'User-Agent: {_WS_USER_AGENT}',
                    '',
                    '',
                ]
                active_sock.sendall('\r\n'.join(up_lines).encode('ascii'))
                resp_buf = b''
                while b'\r\n\r\n' not in resp_buf and len(resp_buf) < 4096:
                    chunk = active_sock.recv(1024)
                    if not chunk:
                        break
                    resp_buf += chunk
                diag['upgradeMs'] = round((time.monotonic() - t_up) * 1000, 1)
                status_line = resp_buf.split(b'\r\n', 1)[0].decode('latin1', errors='replace').strip()
                parts = status_line.split(' ', 2)
                up_code = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else None
                diag['upgradeStatus'] = up_code
                if up_code != 101:
                    diag['error'] = _sanitize_error(f'Proxied WebSocket upgrade rejected by {target_host}: {status_line or "empty response"}')
                    return diag
            except socket.timeout:
                diag['upgradeMs'] = round((time.monotonic() - t_up) * 1000, 1)
                diag['error'] = f'Proxied WebSocket upgrade timed out for {target_host}.'
                return diag
            except Exception as exc:
                diag['upgradeMs'] = round((time.monotonic() - t_up) * 1000, 1)
                diag['error'] = _sanitize_error(f'Proxied WebSocket upgrade failed for {target_host}: {type(exc).__name__}: {exc}')
                return diag

        diag['stage'] = 'ok'
        diag['ok'] = True
        return diag
    finally:
        for sock_obj in (active_sock, raw_sock):
            if sock_obj is not None:
                try:
                    sock_obj.close()
                except Exception:
                    pass


def _probe_ws_via_proxy(ws_url: str, proxy_url: str, timeout_seconds: Optional[float] = None) -> dict:
    """Read-only HTTP CONNECT + TLS + WebSocket 101 upgrade probe through proxy_url."""
    return _probe_https_via_proxy(
        ws_url,
        proxy_url,
        timeout_seconds=timeout_seconds,
        include_upgrade=True,
        verify_tls=True,
    )


def _is_client_alive(client: Any) -> bool:
    if client is None:
        return False
    try:
        if hasattr(client, 'check_connect') and not client.check_connect():
            return False
    except Exception:
        return False
    api = getattr(client, 'api', None)
    if api is not None:
        if hasattr(api, 'websocket_alive'):
            try:
                if not api.websocket_alive():
                    return False
            except Exception:
                return False
        else:
            ws_thread = getattr(api, 'websocket_thread', None)
            if ws_thread is not None and hasattr(ws_thread, 'is_alive') and not ws_thread.is_alive():
                return False
    return True


def _patch_iqoptionapi():
    """Harden upstream iqoptionapi against lock leaks, untimed HTTP/WS waits, and untimed close() joins."""
    global _iqoptionapi_patched
    if _iqoptionapi_patched:
        return
    try:
        import requests
        import iqoptionapi.global_value as global_value
        from iqoptionapi.api import IQOptionAPI
        from iqoptionapi.stable_api import IQ_Option
        from iqoptionapi.ws.client import WebsocketClient
    except Exception:
        return

    # 0a. Patch TimeSync.server_timestamp so reading while unset (None) NEVER raises TypeError: NoneType / int
    try:
        from iqoptionapi.ws.objects.timesync import TimeSync

        def _safe_get_server_timestamp(ts_self):
            raw = getattr(ts_self, '_TimeSync__server_timestamp', None)
            num = _parse_finite_float(raw)
            if num is None:
                return None
            return num / 1000.0

        def _safe_set_server_timestamp(ts_self, timestamp):
            ts_self._TimeSync__server_timestamp = timestamp

        TimeSync.server_timestamp = property(_safe_get_server_timestamp, _safe_set_server_timestamp)
    except Exception:
        pass

    # 0b. Patch websocket-client HTTP CONNECT tunnel to send HTTP/1.1 + Host header (Webshare & strict proxy compatible)
    try:
        import websocket._http as _ws_http

        if hasattr(_ws_http, '_tunnel') and not getattr(_ws_http._tunnel, '_novatrade_patched', False):
            def _safe_ws_tunnel(sock, host, port, auth):
                connect_header = f'CONNECT {host}:{int(port)} HTTP/1.1\r\nHost: {host}:{int(port)}\r\n'
                if auth and auth[0]:
                    auth_str = str(auth[0])
                    if len(auth) > 1 and auth[1] is not None:
                        auth_str += ':' + str(auth[1])
                    encoded_str = base64.b64encode(auth_str.encode('utf-8')).decode('ascii')
                    connect_header += f'Proxy-Authorization: Basic {encoded_str}\r\n'
                connect_header += 'Proxy-Connection: Keep-Alive\r\n\r\n'
                _ws_http.send(sock, connect_header)
                try:
                    status, _resp_headers, _status_msg = _ws_http.read_headers(sock)
                except Exception as exc:
                    raise _ws_http.WebSocketProxyException(_sanitize_error(str(exc)))
                if status != 200:
                    raise _ws_http.WebSocketProxyException(f'failed CONNECT via proxy status: {status!r}')
                return sock

            _safe_ws_tunnel._novatrade_patched = True
            _ws_http._tunnel = _safe_ws_tunnel
    except Exception:
        pass

    # 1. Ensure WebsocketClient.on_message ALWAYS releases ssl_Mutual_exclusion on any exception
    #    and captures live IQ Option user-settings / user-settings-changed frames for authoritative mode tracking.
    orig_on_message = WebsocketClient.on_message

    def _safe_on_message(self, message):
        try:
            raw_msg = json.loads(message) if isinstance(message, str) else message
            if isinstance(raw_msg, dict):
                msg_name = str(raw_msg.get('name') or '')
                req_id = str(raw_msg.get('request_id') or '')
                api_obj = getattr(self, 'api', None)
                if api_obj is not None:
                    pending_ids = getattr(api_obj, '_nt_pending_req_ids', None)
                    if req_id and isinstance(pending_ids, set) and req_id in pending_ids:
                        # IQ Option sends {"name": "result", "msg": {"success": true}} as a transport ACK
                        # BEFORE the actual async "user-settings" frame arrives. Do NOT let a success:true ACK
                        # short-circuit waiting for the real response frame!
                        inner_msg = raw_msg.get('msg')
                        is_success_ack = (
                            msg_name == 'result'
                            and isinstance(inner_msg, dict)
                            and inner_msg.get('success') is True
                        )
                        if is_success_ack:
                            ack_map = getattr(api_obj, '_nt_ws_acks', None)
                            if not isinstance(ack_map, dict):
                                ack_map = {}
                                api_obj._nt_ws_acks = ack_map
                            ack_map[req_id] = True
                        else:
                            resp_map = getattr(api_obj, '_nt_ws_responses', None)
                            if not isinstance(resp_map, dict):
                                resp_map = {}
                                api_obj._nt_ws_responses = resp_map
                            resp_map[req_id] = raw_msg
                    if msg_name in ('user-settings', 'user-settings-changed'):
                        api_obj._nt_user_settings_msg = raw_msg
                        api_obj._nt_user_settings_msg_at = time.time()
                        extracted_id = _extract_balance_id_from_user_settings(raw_msg)
                        if extracted_id is not None:
                            api_obj._nt_user_settings_balance_id = extracted_id
                            api_obj._nt_user_settings_source = msg_name
                            api_obj._nt_user_settings_at = time.time()
                            # Keep cached balance invalid when user switches mode inside IQ Option
                            _invalidate_balance_cache()
        except Exception:
            pass
        try:
            return orig_on_message(self, message)
        finally:
            global_value.ssl_Mutual_exclusion = False

    WebsocketClient.on_message = _safe_on_message

    # 2. Harden HTTP session: verified TLS, bounded pool/timeout, zero retry storms, optional opt-in CONNECT proxy
    orig_api_init = IQOptionAPI.__init__

    def _safe_api_init(self, *args, **kwargs):
        orig_api_init(self, *args, **kwargs)
        # Keep proxy strictly opt-in via IQ_PROXY_URL (never implicitly pick up ambient env vars)
        self.session.trust_env = False
        # Always enforce TLS certificate verification on HTTPS requests (including over CONNECT tunnels)
        self.session.verify = True
        proxies = _get_requests_proxies()
        self.proxies = proxies

        try:
            from requests.adapters import HTTPAdapter
            if hasattr(self.session, 'mount'):
                adapter = HTTPAdapter(pool_connections=4, pool_maxsize=4, max_retries=0)
                self.session.mount('https://', adapter)
                self.session.mount('http://', adapter)
        except Exception:
            pass

        orig_request = self.session.request

        def _timed_request(*r_args, **r_kwargs):
            if _is_worker_cancelled():
                raise TimeoutError('Connection attempt cancelled after timeout.')
            conn_t = _remaining_connect_budget(_HTTP_CONNECT_TIMEOUT)
            read_t = _remaining_connect_budget(_HTTP_TIMEOUT)
            r_kwargs.setdefault('timeout', (conn_t, read_t))
            r_kwargs['verify'] = True
            if proxies is not None and r_kwargs.get('proxies') is None:
                r_kwargs['proxies'] = proxies
            return orig_request(*r_args, **r_kwargs)

        self.session.request = _timed_request

    IQOptionAPI.__init__ = _safe_api_init

    # 3. Bound ssl_Mutual_exclusion wait and guarantee ssl_Mutual_exclusion_write release
    def _safe_send_ws_request(self, name, msg, request_id='', no_force_send=True):
        logger = logging.getLogger(__name__)
        data = json.dumps(dict(name=name, msg=msg, request_id=request_id))
        deadline = time.monotonic() + 3.0
        while (global_value.ssl_Mutual_exclusion or global_value.ssl_Mutual_exclusion_write) and no_force_send:
            if time.monotonic() >= deadline:
                global_value.ssl_Mutual_exclusion = False
                global_value.ssl_Mutual_exclusion_write = False
                break
            time.sleep(0.01)
        global_value.ssl_Mutual_exclusion_write = True
        try:
            self.websocket.send(data)
            logger.debug(data)
        finally:
            global_value.ssl_Mutual_exclusion_write = False

    IQOptionAPI.send_websocket_request = _safe_send_ws_request

    # 4. Bounded close() so websocket_thread.join() can NEVER hang forever, and cancelled workers never wipe newer globals
    def _safe_api_close(self, reset_globals: Optional[bool] = None):
        should_reset = (not _is_worker_cancelled()) if reset_globals is None else bool(reset_globals)
        ws_client = getattr(self, 'websocket_client', None)
        wss = getattr(ws_client, 'wss', None) if ws_client is not None else None
        if wss is not None:
            try:
                wss.close()
            except Exception:
                pass
        ws_thread = getattr(self, 'websocket_thread', None)
        if ws_thread is not None and ws_thread is not threading.current_thread():
            try:
                ws_thread.join(timeout=_CLOSE_TIMEOUT)
            except Exception:
                pass
        session = getattr(self, 'session', None)
        if session is not None and hasattr(session, 'close'):
            try:
                session.close()
            except Exception:
                pass
        if should_reset:
            global_value.check_websocket_if_connect = 0
            global_value.ssl_Mutual_exclusion = False
            global_value.ssl_Mutual_exclusion_write = False

    IQOptionAPI.close = _safe_api_close

    # 5. Hardened start_websocket() with 6s socket timeout, Origin/User-Agent headers, no cacert.pem, primary->fallback, and cooperative cancellation
    def _safe_start_websocket(self):
        global _active_ws_url, _active_ws_via_proxy, _last_ws_diagnostics
        if _is_worker_cancelled():
            return False, 'Connection attempt cancelled after timeout.'
        _set_connect_stage('ws_open')
        ws_timeout = _remaining_connect_budget(_WS_CONNECT_TIMEOUT)
        candidates = _get_ws_candidates(getattr(self, 'wss_url', None))
        attempt_diags: List[dict] = []

        try:
            import websocket as _ws_lib
            if hasattr(_ws_lib, 'setdefaulttimeout'):
                _ws_lib.setdefaulttimeout(ws_timeout)
        except Exception:
            pass

        ws_proxy_mode = _get_ws_proxy_mode()
        proxy_url: Optional[str] = None
        try:
            proxy_url = _get_proxy_url()
        except ValueError:
            proxy_url = None
        proxy_ws_kwargs = _build_ws_proxy_kwargs_from_url(proxy_url)

        # Build ordered (candidate_url, use_proxy) plan:
        # - 'direct' (default): direct only
        # - 'proxy': proxied only (falls back gracefully if proxy URL scheme is incompatible)
        # - 'auto': direct first, then proxied fallback if direct fails
        plan: List[Tuple[str, bool]] = []
        if ws_proxy_mode == 'proxy' and proxy_ws_kwargs:
            plan = [(u, True) for u in candidates]
        elif ws_proxy_mode == 'auto' and proxy_ws_kwargs:
            plan = [(u, False) for u in candidates] + [(u, True) for u in candidates]
        else:
            plan = [(u, False) for u in candidates]

        for candidate_url, use_proxy in plan:
            if _is_worker_cancelled():
                self.close(reset_globals=False)
                return False, 'Connection attempt cancelled after timeout.'
            step_timeout = _remaining_connect_budget(_WS_CONNECT_TIMEOUT)
            if use_proxy and proxy_url:
                probe = _probe_https_via_proxy(
                    candidate_url,
                    proxy_url,
                    timeout_seconds=step_timeout,
                    include_upgrade=False,
                    verify_tls=False,
                )
                if not probe.get('ok'):
                    attempt_diags.append(probe)
                    continue
            else:
                probe = _probe_ws_endpoint(candidate_url, timeout_seconds=step_timeout, include_upgrade=False)
                probe['viaProxy'] = False
                if not probe.get('ok'):
                    attempt_diags.append(probe)
                    continue

            if _is_worker_cancelled():
                self.close(reset_globals=False)
                return False, 'Connection attempt cancelled after timeout.'

            global_value.check_websocket_if_connect = None
            global_value.check_websocket_if_error = False
            global_value.websocket_error_reason = None

            self.wss_url = candidate_url
            self.websocket_client = WebsocketClient(self)
            wss_obj = getattr(self.websocket_client, 'wss', None)
            if wss_obj is not None:
                wss_obj.header = [f'User-Agent: {_WS_USER_AGENT}']

            run_kwargs: Dict[str, Any] = {
                'sslopt': {'check_hostname': False, 'cert_reqs': ssl.CERT_NONE},
                'origin': _WS_ORIGIN,
            }
            if use_proxy and proxy_ws_kwargs:
                run_kwargs.update(proxy_ws_kwargs)

            self.websocket_thread = threading.Thread(
                target=self.websocket.run_forever,
                kwargs=run_kwargs,
                daemon=True,
            )
            self.websocket_thread.start()

            t_open = time.monotonic()
            open_budget = _remaining_connect_budget(_WS_CONNECT_TIMEOUT)
            deadline = t_open + open_budget
            opened = False
            ws_err: Optional[str] = None

            while time.monotonic() < deadline:
                if _is_worker_cancelled():
                    self.close(reset_globals=False)
                    return False, 'Connection attempt cancelled after timeout.'
                if global_value.check_websocket_if_error:
                    ws_err = str(global_value.websocket_error_reason or 'WebSocket error callback triggered.')
                    break
                if global_value.check_websocket_if_connect == 0:
                    ws_err = 'WebSocket closed during upgrade handshake.'
                    break
                if global_value.check_websocket_if_connect == 1:
                    opened = True
                    break
                time.sleep(0.02)

            if opened:
                if _is_worker_cancelled():
                    self.close(reset_globals=False)
                    return False, 'Connection attempt cancelled after timeout.'
                probe['upgradeMs'] = round((time.monotonic() - t_open) * 1000, 1)
                probe['stage'] = 'ok'
                probe['ok'] = True
                attempt_diags.append(probe)
                _active_ws_url = candidate_url
                _active_ws_via_proxy = bool(use_proxy)
                _last_ws_diagnostics = attempt_diags
                return True, None

            self.close(reset_globals=not _is_worker_cancelled())
            probe['ok'] = False
            probe['stage'] = 'ws_upgrade'
            probe['upgradeMs'] = round((time.monotonic() - t_open) * 1000, 1)
            probe['error'] = _sanitize_error(
                ws_err or f'WebSocket upgrade timed out for {candidate_url} after {open_budget:.1f}s.'
            )
            attempt_diags.append(probe)

        if not _is_worker_cancelled():
            _active_ws_url = None
            _active_ws_via_proxy = False
            _last_ws_diagnostics = attempt_diags
        summary = '; '.join(
            f"{d.get('url')} [{d.get('stage')}: {d.get('error') or 'failed'}]"
            for d in attempt_diags
        )
        return False, _sanitize_error(summary or f'Timed out opening IQ Option WebSocket after {ws_timeout:.1f}s.')

    IQOptionAPI.start_websocket = _safe_start_websocket

    # 6. Bounded send_ssid() wait with cooperative cancellation
    def _safe_send_ssid(self):
        if _is_worker_cancelled():
            return False
        _set_connect_stage('send_ssid')
        self.profile.msg = None
        self.ssid(global_value.SSID)
        deadline = time.monotonic() + _remaining_connect_budget(8.0)
        while time.monotonic() < deadline:
            if _is_worker_cancelled():
                return False
            if self.profile.msg is not None:
                return self.profile.msg is not False
            if global_value.check_websocket_if_connect == 0 or global_value.check_websocket_if_error:
                return False
            time.sleep(0.02)
        return False

    IQOptionAPI.send_ssid = _safe_send_ssid

    # 6b. Patch get_ssid() so transport exceptions propagate cleanly without raw logger.error() secret leaks
    orig_get_ssid = getattr(IQOptionAPI, 'get_ssid', None)

    def _safe_get_ssid(self):
        if hasattr(self, 'login') and callable(self.login):
            return self.login(self.username, self.password)
        if orig_get_ssid is not None:
            return orig_get_ssid(self)
        raise RuntimeError('IQOptionAPI has neither login() nor get_ssid().')

    IQOptionAPI.get_ssid = _safe_get_ssid

    # 7. Bounded IQOptionAPI.connect() (no infinite timesync spin, safe TimeSync None handling, safe auth classification, cancellation fencing)
    def _classify_auth_exception(exc: BaseException, extra: Tuple[Optional[str], ...]) -> str:
        cls_name = type(exc).__name__
        low = f'{cls_name}: {exc}'.lower()
        if 'ssl' in low or 'certificate' in low:
            return _sanitize_error(f'IQ Option auth TLS verification failed ({cls_name}): {exc}', extra)
        if 'proxy' in low:
            return _sanitize_error(f'IQ Option auth proxy tunnel failed ({cls_name}): {exc}', extra)
        if 'connecttimeout' in low or 'connect timeout' in low:
            return _sanitize_error(f'IQ Option auth TCP connection timed out ({cls_name}): {exc}', extra)
        if 'readtimeout' in low or 'read timeout' in low or isinstance(exc, TimeoutError):
            return _sanitize_error(f'IQ Option auth read timed out ({cls_name}): {exc}', extra)
        return _sanitize_error(f'IQ Option auth request failed ({cls_name}): {exc}', extra)

    def _fetch_ssid_safely(api_self) -> Tuple[Optional[str], Optional[str]]:
        if _is_worker_cancelled():
            return None, 'Connection attempt cancelled after timeout.'
        _set_connect_stage('auth')
        extra = (getattr(api_self, 'username', None), getattr(api_self, 'password', None))
        try:
            response = api_self.get_ssid()
            if isinstance(response, BaseException):
                return None, _classify_auth_exception(response, extra)
        except Exception as exc:
            return None, _classify_auth_exception(exc, extra)

        if _is_worker_cancelled():
            return None, 'Connection attempt cancelled after timeout.'

        try:
            ssid_val = response.cookies['ssid']
            if ssid_val:
                return str(ssid_val), None
        except Exception:
            pass

        status_code = getattr(response, 'status_code', None)
        body_snippet = ''
        try:
            payload = response.json()
            if isinstance(payload, dict):
                code = payload.get('code') or payload.get('message')
                if code:
                    body_snippet = f' ({code})'
        except Exception:
            pass
        if status_code is not None:
            return None, _sanitize_error(
                f'IQ Option authentication rejected by auth.iqoption.com (HTTP {status_code}){body_snippet}.',
                extra,
            )
        return None, _sanitize_error(getattr(response, 'text', str(response)), extra)

    def _safe_api_connect(self):
        if _is_worker_cancelled():
            return False, 'Connection attempt cancelled after timeout.'
        global_value.ssl_Mutual_exclusion = False
        global_value.ssl_Mutual_exclusion_write = False
        try:
            self.close(reset_globals=False)
        except Exception:
            pass
        check_ws, ws_reason = self.start_websocket()
        if not check_ws:
            return check_ws, ws_reason

        if _is_worker_cancelled():
            self.close(reset_globals=False)
            return False, 'Connection attempt cancelled after timeout.'

        if global_value.SSID is not None:
            check_ssid = self.send_ssid()
            if not check_ssid:
                if _is_worker_cancelled():
                    self.close(reset_globals=False)
                    return False, 'Connection attempt cancelled after timeout.'
                ssid_val, auth_err = _fetch_ssid_safely(self)
                if not ssid_val:
                    self.close(reset_globals=not _is_worker_cancelled())
                    return False, auth_err or 'IQ Option authentication failed.'
                if _is_worker_cancelled():
                    self.close(reset_globals=False)
                    return False, 'Connection attempt cancelled after timeout.'
                global_value.SSID = ssid_val
                check_ws2, ws_reason2 = self.start_websocket()
                if not check_ws2:
                    return False, ws_reason2
                if not self.send_ssid():
                    self.close(reset_globals=not _is_worker_cancelled())
                    return False, 'IQ Option SSID authentication timed out.'
        else:
            ssid_val, auth_err = _fetch_ssid_safely(self)
            if not ssid_val:
                self.close(reset_globals=not _is_worker_cancelled())
                return False, auth_err or 'IQ Option authentication failed.'
            if _is_worker_cancelled():
                self.close(reset_globals=False)
                return False, 'Connection attempt cancelled after timeout.'
            global_value.SSID = ssid_val
            if not self.send_ssid():
                self.close(reset_globals=not _is_worker_cancelled())
                return False, 'IQ Option SSID authentication timed out.'

        if _is_worker_cancelled():
            self.close(reset_globals=False)
            return False, 'Connection attempt cancelled after timeout.'

        requests.utils.add_dict_to_cookiejar(self.session.cookies, {'ssid': global_value.SSID})
        _set_connect_stage('time_sync')
        self.timesync.server_timestamp = None
        deadline = time.monotonic() + _remaining_connect_budget(6.0)
        while time.monotonic() < deadline:
            if _is_worker_cancelled():
                self.close(reset_globals=False)
                return False, 'Connection attempt cancelled after timeout.'
            try:
                ts_val = self.timesync.server_timestamp
            except TypeError:
                # Upstream TimeSync.server_timestamp divides __server_timestamp / 1000 while None
                ts_val = None
            if ts_val is not None:
                return True, None
            if global_value.check_websocket_if_connect == 0 or global_value.check_websocket_if_error:
                self.close(reset_globals=not _is_worker_cancelled())
                return False, global_value.websocket_error_reason or 'WebSocket closed during timeSync.'
            time.sleep(0.02)
        self.close(reset_globals=not _is_worker_cancelled())
        return False, 'Timed out waiting for IQ Option timeSync.'

    IQOptionAPI.connect = _safe_api_connect

    # 8. Bounded IQ_Option.connect() (no infinite balance_id spin, cancellation fenced)
    def _safe_stable_connect(self):
        if _is_worker_cancelled():
            return False, 'Connection attempt cancelled after timeout.'
        try:
            self.api.close(reset_globals=False)
        except Exception:
            pass
        if _is_worker_cancelled():
            return False, 'Connection attempt cancelled after timeout.'
        global_value.balance_id = None
        self.api = IQOptionAPI('iqoption.com', self.email, self.password)
        self.api.set_session(headers=self.SESSION_HEADER, cookies=self.SESSION_COOKIE)
        check, reason = self.api.connect()
        if check is True:
            if _is_worker_cancelled():
                self.api.close(reset_globals=False)
                return False, 'Connection attempt cancelled after timeout.'
            self.re_subscribe_stream()
            _set_connect_stage('balance_profile')
            deadline = time.monotonic() + _remaining_connect_budget(6.0)
            while global_value.balance_id is None and time.monotonic() < deadline:
                if _is_worker_cancelled():
                    self.api.close(reset_globals=False)
                    return False, 'Connection attempt cancelled after timeout.'
                profile_msg = getattr(getattr(self.api, 'profile', None), 'msg', None)
                if isinstance(profile_msg, dict):
                    # NEVER blindly bind global_value.balance_id to legacy profile_msg['balance_id'] (which IQ Option
                    # sends as type==1 REAL even when the user is on PRACTICE in the traderoom!).
                    # Temporarily prefer PRACTICE (type==4) for initial stream subscription; authoritative mode detection
                    # in _detect_balance_mode() will resolve the true active balanceId from IQ Option user-settings.
                    balances_list = profile_msg.get('balances')
                    if isinstance(balances_list, list):
                        for bal in balances_list:
                            if isinstance(bal, dict) and bal.get('type') == 4 and bal.get('id') is not None:
                                global_value.balance_id = bal['id']
                                break
                        if global_value.balance_id is None and len(balances_list) == 1:
                            only_bal = balances_list[0]
                            if isinstance(only_bal, dict) and only_bal.get('id') is not None:
                                global_value.balance_id = only_bal['id']
                    if global_value.balance_id is None and profile_msg.get('balance_type') == 4 and profile_msg.get('balance_id') is not None:
                        global_value.balance_id = profile_msg.get('balance_id')
                if global_value.balance_id is not None:
                    break
                if global_value.check_websocket_if_connect == 0 or global_value.check_websocket_if_error:
                    self.api.close(reset_globals=not _is_worker_cancelled())
                    return False, global_value.websocket_error_reason or 'WebSocket closed awaiting balance profile.'
                time.sleep(0.02)
            if _is_worker_cancelled():
                self.api.close(reset_globals=False)
                return False, 'Connection attempt cancelled after timeout.'
            if global_value.balance_id is None:
                self.api.close(reset_globals=not _is_worker_cancelled())
                return False, 'Timed out waiting for IQ Option balance profile.'
            self.position_change_all('subscribeMessage', global_value.balance_id)
            self.order_changed_all('subscribeMessage')
            try:
                self.api.send_websocket_request('subscribeMessage', {'name': 'user-settings-changed', 'version': '1.0'})
                self.api.send_websocket_request('subscribeMessage', {'name': 'user-settings-changed', 'version': '2.0'})
            except Exception:
                pass
            self.api.setOptions(1, True)
            return True, None
        return False, reason

    IQ_Option.connect = _safe_stable_connect

    # 9. Bounded get_profile_ansyc() and get_balances()
    def _safe_get_profile_ansyc(self):
        deadline = time.monotonic() + _MODE_TIMEOUT
        while getattr(getattr(self.api, 'profile', None), 'msg', None) is None:
            if time.monotonic() >= deadline:
                raise TimeoutError('Timed out waiting for IQ Option profile.')
            if global_value.check_websocket_if_connect == 0:
                raise ConnectionError('IQ Option WebSocket disconnected.')
            time.sleep(0.02)
        return self.api.profile.msg

    def _safe_get_balances(self):
        self.api.balances_raw = None
        self.api.get_balances()
        deadline = time.monotonic() + _BALANCE_TIMEOUT
        while self.api.balances_raw is None:
            if time.monotonic() >= deadline:
                raise TimeoutError('Timed out waiting for IQ Option balances.')
            if global_value.check_websocket_if_connect == 0:
                raise ConnectionError('IQ Option WebSocket disconnected.')
            time.sleep(0.02)
        return self.api.balances_raw

    IQ_Option.get_profile_ansyc = _safe_get_profile_ansyc
    IQ_Option.get_balances = _safe_get_balances

    _iqoptionapi_patched = True


class CandlesQuery(BaseModel):
    symbol: str = Field(default='EURUSD', pattern=r'^[A-Z0-9_-]{3,25}$')
    interval: int = Field(default=60, ge=5, le=86400)
    count: int = Field(default=100, ge=1, le=500)

    @field_validator('symbol', mode='before')
    @classmethod
    def _normalize_symbol(cls, v: Any) -> str:
        return str(v or '').strip().upper().replace('/', '')


def _check_auth(x_connector_token: Optional[str]):
    expected = os.environ.get('IQ_CONNECTOR_TOKEN', '').strip()
    if expected and x_connector_token != expected:
        raise HTTPException(401, 'Invalid connector token.')


class ConnectBody(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = Field(default=None, repr=False)
    mode: Optional[str] = None


class OrderRequest(BaseModel):
    symbol: str = Field(..., min_length=3, max_length=25)
    direction: str = Field(..., min_length=3, max_length=6)
    amount: float = Field(..., gt=0, le=100000)
    expirySeconds: int = Field(default=60, ge=30, le=86400)
    instrumentType: str = Field(default='auto')
    expectedMode: Optional[str] = None
    idempotencyKey: Optional[str] = None

    @field_validator('symbol', mode='before')
    @classmethod
    def _clean_symbol(cls, v: Any) -> str:
        return str(v or '').strip().upper().replace('/', '')

    @field_validator('direction', mode='before')
    @classmethod
    def _clean_direction(cls, v: Any) -> str:
        raw = str(v or '').strip().upper()
        if raw in ('CALL', 'BUY'):
            return 'CALL'
        if raw in ('PUT', 'SELL'):
            return 'PUT'
        raise ValueError('direction must be CALL/BUY or PUT/SELL.')

    @field_validator('instrumentType', mode='before')
    @classmethod
    def _clean_instrument(cls, v: Any) -> str:
        raw = str(v or 'auto').strip().lower()
        return raw if raw in ('auto', 'binary', 'digital') else 'auto'


def _normalize_mode(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    val = str(raw).strip().upper()
    if not val:
        return None
    if val in ('AUTO', 'FOLLOW', 'ACTIVE'):
        return 'AUTO'
    if val in ('REAL', 'LIVE'):
        return 'REAL'
    if val in ('PRACTICE', 'DEMO'):
        return 'PRACTICE'
    raise HTTPException(400, f'Unsupported IQ Option account mode "{raw}". Expected AUTO, PRACTICE, or REAL.')


def _resolve_target_mode(
    explicit_mode: Optional[str] = None,
    x_iq_mode: Optional[str] = None,
    query_mode: Optional[str] = None,
) -> str:
    return (
        _normalize_mode(explicit_mode)
        or _normalize_mode(query_mode)
        or _normalize_mode(x_iq_mode)
        or 'AUTO'
    )


def _coerce_balance_id(raw_val: Any) -> Any:
    if raw_val is None or isinstance(raw_val, bool):
        return None
    if isinstance(raw_val, int):
        return raw_val
    if isinstance(raw_val, float) and math.isfinite(raw_val) and raw_val.is_integer():
        return int(raw_val)
    s = str(raw_val).strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    return s


def _coerce_int(raw_val: Any) -> Optional[int]:
    if raw_val is None or isinstance(raw_val, bool):
        return None
    if isinstance(raw_val, int):
        return raw_val
    if isinstance(raw_val, float) and math.isfinite(raw_val) and raw_val.is_integer():
        return int(raw_val)
    s = str(raw_val).strip()
    if s and (s.isdigit() or (s.startswith('-') and s[1:].isdigit())):
        try:
            return int(s)
        except Exception:
            return None
    return None


_USER_SETTINGS_BALANCE_KEYS = (
    'balanceId',
    'balance_id',
    'activeBalanceId',
    'active_balance_id',
    'selectedBalanceId',
    'selected_balance_id',
    'currentBalanceId',
    'current_balance_id',
    'userBalanceId',
    'user_balance_id',
    'lastBalanceId',
    'last_balance_id',
)
_USER_SETTINGS_NESTED_BALANCE_OBJ_KEYS = ('balance', 'activeBalance', 'active_balance', 'selectedBalance', 'selected_balance')
_USER_SETTINGS_ENVELOPE_KEYS = ('msg', 'result', 'data', 'payload', 'settings', 'configs', 'items', 'value', 'values', 'config')


def _extract_balance_id_from_user_settings(
    payload: Any,
    known_balance_ids: Optional[set] = None,
    _depth: int = 0,
) -> Any:
    """Extract the user's currently selected traderoom balanceId from IQ Option user-settings / user-settings-changed.
    Supports nested JSON strings, versioned configs, and validates against known_balance_ids when supplied.
    """
    if payload is None or _depth > 8:
        return None
    if isinstance(payload, str):
        s = payload.strip()
        if not s or (not s.startswith('{') and not s.startswith('[')):
            return None
        try:
            payload = json.loads(s)
        except Exception:
            return None

    def _accept(val: Any) -> Any:
        norm = _coerce_balance_id(val)
        if norm is None:
            return None
        if known_balance_ids is not None and len(known_balance_ids) > 0:
            if str(norm) not in known_balance_ids:
                return None
        return norm

    def _from_config_obj(cfg: Any, depth: int) -> Any:
        if depth > 8 or cfg is None:
            return None
        if isinstance(cfg, str):
            s = cfg.strip()
            if not s or (not s.startswith('{') and not s.startswith('[')):
                return None
            try:
                cfg = json.loads(s)
            except Exception:
                return None
        if isinstance(cfg, dict):
            for key in _USER_SETTINGS_BALANCE_KEYS:
                if key in cfg:
                    val = _accept(cfg.get(key))
                    if val is not None:
                        return val
            for obj_key in _USER_SETTINGS_NESTED_BALANCE_OBJ_KEYS:
                nested_obj = cfg.get(obj_key)
                if isinstance(nested_obj, dict):
                    val = _accept(nested_obj.get('id') or nested_obj.get('balanceId') or nested_obj.get('balance_id'))
                    if val is not None:
                        return val
            for sub_key, sub_val in cfg.items():
                if isinstance(sub_val, (dict, list, str)):
                    if sub_key in _USER_SETTINGS_BALANCE_KEYS:
                        continue
                    val = _from_config_obj(sub_val, depth + 1)
                    if val is not None:
                        return val
        elif isinstance(cfg, list):
            for item in cfg:
                val = _from_config_obj(item, depth + 1)
                if val is not None:
                    return val
        return None

    if isinstance(payload, dict):
        # 1. Prioritize canonical traderoom_gl_common entry first
        if payload.get('name') == 'traderoom_gl_common' or payload.get('setting_name') == 'traderoom_gl_common':
            for container_key in ('config', 'data', 'value', 'values', 'settings'):
                if container_key in payload:
                    val = _from_config_obj(payload.get(container_key), _depth + 1)
                    if val is not None:
                        return val

        if 'traderoom_gl_common' in payload:
            val = _extract_balance_id_from_user_settings(payload.get('traderoom_gl_common'), known_balance_ids, _depth + 1)
            if val is not None:
                return val

        # 2. Unwrap standard WebSocket / user-settings envelope containers
        for env_key in ('msg', 'result', 'configs', 'settings', 'data', 'payload', 'items', 'value', 'values'):
            if env_key in payload and payload.get(env_key) is not None:
                inner = payload.get(env_key)
                if isinstance(inner, dict) and 'traderoom_gl_common' in inner:
                    val = _extract_balance_id_from_user_settings(inner.get('traderoom_gl_common'), known_balance_ids, _depth + 1)
                    if val is not None:
                        return val
                val = _extract_balance_id_from_user_settings(inner, known_balance_ids, _depth + 1)
                if val is not None:
                    return val

        # 3. Direct config / balance keys on current object
        if 'config' in payload:
            val = _from_config_obj(payload.get('config'), _depth + 1)
            if val is not None:
                return val

        direct = _from_config_obj(payload, _depth + 1)
        if direct is not None:
            return direct

    elif isinstance(payload, list):
        # Prefer explicit traderoom_gl_common entry first
        for entry in payload:
            if isinstance(entry, dict) and entry.get('name') == 'traderoom_gl_common':
                val = _extract_balance_id_from_user_settings(entry, known_balance_ids, _depth + 1)
                if val is not None:
                    return val
        for entry in payload:
            val = _extract_balance_id_from_user_settings(entry, known_balance_ids, _depth + 1)
            if val is not None:
                return val

    return None


def _summarize_user_settings_response(resp: Any) -> dict:
    """Build a strictly non-sensitive structural summary of an IQ Option user-settings WS frame.
    NEVER includes balance IDs, balances, emails, tokens, or raw setting values — ONLY status & key names.
    """
    if not isinstance(resp, dict):
        return {'type': type(resp).__name__}
    summary: dict = {
        'name': str(resp.get('name') or ''),
        'status': resp.get('status'),
    }
    msg = resp.get('msg')
    summary['msgType'] = type(msg).__name__
    if isinstance(msg, dict):
        summary['msgKeys'] = sorted(str(k) for k in list(msg.keys())[:15])
        if summary['name'] == 'result' and isinstance(msg.get('success'), bool):
            summary['resultSuccess'] = msg['success']
        status_int = _coerce_int(resp.get('status'))
        if status_int is not None and status_int >= 4000:
            err_hint = msg.get('code') or msg.get('message') or msg.get('error')
            if isinstance(err_hint, str) and err_hint.strip():
                summary['errorCode'] = _sanitize_error(err_hint.strip())[:100]
        # Extract non-sensitive setting bucket names & top-level config key names (never values)
        config_names: List[str] = []
        config_keys: List[str] = []
        target_container = msg.get('result') if isinstance(msg.get('result'), (dict, list)) else msg
        if isinstance(target_container, dict):
            cfgs = target_container.get('configs')
            if isinstance(cfgs, dict):
                config_names = sorted(str(k) for k in list(cfgs.keys())[:15])
                tr = cfgs.get('traderoom_gl_common')
                if isinstance(tr, dict):
                    tr_cfg = tr.get('config') if 'config' in tr else tr
                    if isinstance(tr_cfg, str):
                        try:
                            tr_cfg = json.loads(tr_cfg)
                        except Exception:
                            tr_cfg = None
                    if isinstance(tr_cfg, dict):
                        config_keys = sorted(str(k) for k in list(tr_cfg.keys())[:20])
            elif isinstance(cfgs, list):
                for item in cfgs[:15]:
                    if isinstance(item, dict) and item.get('name'):
                        config_names.append(str(item.get('name')))
                        if item.get('name') == 'traderoom_gl_common':
                            tr_cfg = item.get('config')
                            if isinstance(tr_cfg, str):
                                try:
                                    tr_cfg = json.loads(tr_cfg)
                                except Exception:
                                    tr_cfg = None
                            if isinstance(tr_cfg, dict):
                                config_keys = sorted(str(k) for k in list(tr_cfg.keys())[:20])
            elif 'config' in target_container:
                tr_cfg = target_container.get('config')
                if isinstance(tr_cfg, str):
                    try:
                        tr_cfg = json.loads(tr_cfg)
                    except Exception:
                        tr_cfg = None
                if isinstance(tr_cfg, dict):
                    config_keys = sorted(str(k) for k in list(tr_cfg.keys())[:20])
            if target_container.get('name') and not config_names:
                config_names.append(str(target_container.get('name')))
        elif isinstance(target_container, list):
            for item in target_container[:15]:
                if isinstance(item, dict) and item.get('name'):
                    config_names.append(str(item.get('name')))
        if config_names:
            summary['configNames'] = config_names
        if config_keys:
            summary['configKeys'] = config_keys
    elif isinstance(msg, list):
        summary['msgLen'] = len(msg)
        names = [str(item.get('name')) for item in msg[:15] if isinstance(item, dict) and item.get('name')]
        if names:
            summary['configNames'] = names
    return summary


def _resolve_mode_from_balances(
    balances: Any,
    target_balance_id: Any,
) -> Tuple[Optional[str], Any, Optional[str]]:
    """Map a specific balance_id to ('PRACTICE' | 'REAL', balance_id, currency) using IQ Option's balances list."""
    norm_target = _coerce_balance_id(target_balance_id)
    if norm_target is None or not isinstance(balances, list):
        return (None, None, None)
    for bal in balances:
        if not isinstance(bal, dict):
            continue
        bid = _coerce_balance_id(bal.get('id'))
        if bid is not None and str(bid) == str(norm_target):
            btype = _coerce_int(bal.get('type'))
            curr = str(bal.get('currency') or 'USD').upper()
            if btype == 1:
                return ('REAL', bid, curr)
            if btype == 4:
                return ('PRACTICE', bid, curr)
    return (None, None, None)


def _get_balances_list(client: Any, refresh: bool = False, timeout_seconds: float = 2.5) -> List[dict]:
    """Return list of IQ Option balance dicts from live get-balances (when refreshing) or profile.msg."""
    api = getattr(client, 'api', None)
    if api is None:
        return []
    if refresh and hasattr(api, 'get_balances') and _is_client_alive(client):
        try:
            _reset_iq_global_locks()
            api.balances_raw = None
            _run_with_timeout(api.get_balances, min(timeout_seconds, 2.0), 'mode_get_balances')
            deadline = time.monotonic() + min(timeout_seconds, 2.5)
            while time.monotonic() < deadline:
                raw = getattr(api, 'balances_raw', None)
                if isinstance(raw, dict) and isinstance(raw.get('msg'), list):
                    return [b for b in raw['msg'] if isinstance(b, dict)]
                if not _is_client_alive(client):
                    break
                time.sleep(0.03)
        except Exception:
            pass
    raw_cached = getattr(api, 'balances_raw', None)
    if isinstance(raw_cached, dict) and isinstance(raw_cached.get('msg'), list) and raw_cached['msg']:
        return [b for b in raw_cached['msg'] if isinstance(b, dict)]
    profile_msg = getattr(getattr(api, 'profile', None), 'msg', None)
    if isinstance(profile_msg, dict) and isinstance(profile_msg.get('balances'), list):
        return [b for b in profile_msg['balances'] if isinstance(b, dict)]
    return []


def _query_user_settings_balance_id(
    client: Any,
    timeout_seconds: float = 3.0,
    known_balance_ids: Optional[set] = None,
) -> Tuple[Any, Optional[str], dict]:
    """Read-only WebSocket query for IQ Option's traderoom_gl_common.config.balanceId.
    Tries versioned IQ Option get-user-settings payloads first, uses clean numeric request_ids,
    and records strictly non-sensitive structural diagnostics.
    NEVER calls set-user-settings or change_balance.
    """
    diag: dict = {
        'queried': False,
        'attempts': 0,
        'responseName': None,
        'responseStatus': None,
        'matchedQuery': None,
        'foundBalanceId': False,
        'attemptsSummary': [],
    }
    api = getattr(client, 'api', None)
    if api is None or not hasattr(api, 'send_websocket_request') or not _is_client_alive(client):
        return (None, None, diag)

    if not isinstance(getattr(api, '_nt_pending_req_ids', None), set):
        api._nt_pending_req_ids = set()
    if not isinstance(getattr(api, '_nt_ws_responses', None), dict):
        api._nt_ws_responses = {}
    if not isinstance(getattr(api, '_nt_ws_acks', None), dict):
        api._nt_ws_acks = {}

    queries: List[Tuple[str, dict]] = [
        ('traderoom_gl_common_v3', {'name': 'get-user-settings', 'version': '1.0', 'body': {'name': 'traderoom_gl_common', 'version': 3}}),
        ('traderoom_gl_common_v2', {'name': 'get-user-settings', 'version': '1.0', 'body': {'name': 'traderoom_gl_common', 'version': 2}}),
        ('traderoom_gl_common_v1', {'name': 'get-user-settings', 'version': '1.0', 'body': {'name': 'traderoom_gl_common', 'version': 1}}),
        ('traderoom_gl_common_v4', {'name': 'get-user-settings', 'version': '1.0', 'body': {'name': 'traderoom_gl_common', 'version': 4}}),
        ('traderoom_gl_common', {'name': 'get-user-settings', 'version': '1.0', 'body': {'name': 'traderoom_gl_common'}}),
        ('traderoom_gl_common_api_v2', {'name': 'get-user-settings', 'version': '2.0', 'body': {'name': 'traderoom_gl_common'}}),
        ('traderoom_common_v1', {'name': 'get-user-settings', 'version': '1.0', 'body': {'name': 'traderoom_common', 'version': 1}}),
        ('mobile_common_v1', {'name': 'get-user-settings', 'version': '1.0', 'body': {'name': 'mobile_common', 'version': 1}}),
        ('names_traderoom', {'name': 'get-user-settings', 'version': '1.0', 'body': {'names': ['traderoom_gl_common', 'traderoom_common', 'mobile_common']}}),
    ]
    total_deadline = time.monotonic() + max(1.0, min(timeout_seconds, 3.8))
    per_try_budget = 0.45
    req_base = int(time.time() * 1000) % 1000000000

    for idx, (label, msg_payload) in enumerate(queries):
        if not _is_client_alive(client) or time.monotonic() >= total_deadline:
            break
        diag['queried'] = True
        diag['attempts'] = idx + 1
        req_id = str(req_base + idx + 1)
        api._nt_pending_req_ids.add(req_id)
        api._nt_ws_acks.pop(req_id, None)
        before_unsolicited_at = float(getattr(api, '_nt_user_settings_msg_at', 0.0) or 0.0)
        try:
            _run_with_timeout(
                lambda p=msg_payload, rid=req_id: api.send_websocket_request('sendMessage', p, request_id=rid),
                min(per_try_budget, 1.0),
                'get_user_settings',
            )
            step_deadline = min(total_deadline, time.monotonic() + per_try_budget)
            got_resp = None
            while time.monotonic() < step_deadline:
                resp = api._nt_ws_responses.pop(req_id, None)
                if resp is not None:
                    # Also guard here in case a mock or direct writer inserted a result: {success: true} ACK
                    if (
                        isinstance(resp, dict)
                        and resp.get('name') == 'result'
                        and isinstance(resp.get('msg'), dict)
                        and resp['msg'].get('success') is True
                    ):
                        api._nt_ws_acks[req_id] = True
                        time.sleep(0.02)
                        continue
                    got_resp = resp
                    break
                # Fallback if broker replied with a user-settings frame without echoing request_id
                latest_at = float(getattr(api, '_nt_user_settings_msg_at', 0.0) or 0.0)
                if latest_at > before_unsolicited_at:
                    latest_frame = getattr(api, '_nt_user_settings_msg', None)
                    if isinstance(latest_frame, dict) and not latest_frame.get('request_id'):
                        got_resp = latest_frame
                        break
                if not _is_client_alive(client):
                    break
                time.sleep(0.025)

            ack_seen = bool(api._nt_ws_acks.pop(req_id, False))
            if got_resp is not None:
                diag['responseName'] = str(got_resp.get('name') or '')
                diag['responseStatus'] = got_resp.get('status')
                summary = _summarize_user_settings_response(got_resp)
                summary['query'] = label
                if ack_seen:
                    summary['ackReceived'] = True
                diag['attemptsSummary'].append(summary)
                bal_id = _extract_balance_id_from_user_settings(got_resp, known_balance_ids=known_balance_ids)
                if bal_id is not None:
                    api._nt_user_settings_balance_id = bal_id
                    api._nt_user_settings_source = 'user_settings'
                    api._nt_user_settings_at = time.time()
                    diag['foundBalanceId'] = True
                    diag['matchedQuery'] = label
                    return (bal_id, 'user_settings', diag)
            else:
                entry = {'query': label, 'timedOut': True}
                if ack_seen:
                    entry['ackReceived'] = True
                diag['attemptsSummary'].append(entry)
        except Exception as exc:
            diag['attemptsSummary'].append({'query': label, 'error': type(exc).__name__})
        finally:
            api._nt_pending_req_ids.discard(req_id)

    return (None, None, diag)


def _query_http_getprofile(client: Any, timeout_seconds: float = 1.5) -> Optional[dict]:
    """Read-only HTTP /api/getprofile cross-check using the already-authenticated session.
    NEVER alters broker state and NEVER assumes REAL on dual-wallet accounts.
    """
    api = getattr(client, 'api', None)
    if api is None or not hasattr(api, 'getprofile') or not callable(api.getprofile):
        return None
    try:
        resp = _run_with_timeout(api.getprofile, min(timeout_seconds, 2.0), 'http_getprofile')
        if resp is None:
            return None
        data = resp.json() if hasattr(resp, 'json') and callable(resp.json) else resp
        if isinstance(data, dict):
            result = data.get('result')
            if isinstance(result, dict):
                return result
            if 'balance_type' in data or 'balance_id' in data or 'balances' in data:
                return data
    except Exception:
        return None
    return None


def _sync_local_balance_id(client: Any, verified_balance_id: Any) -> None:
    """Align local iqoptionapi global_value.balance_id with the verified active balance_id from IQ Option.
    NEVER calls client.change_balance() or set_user_settings() on IQ Option.
    """
    norm_id = _coerce_balance_id(verified_balance_id)
    if norm_id is None:
        return
    try:
        import iqoptionapi.global_value as global_value
        prev_id = getattr(global_value, 'balance_id', None)
        global_value.balance_id = norm_id
        if prev_id != norm_id and client is not None and hasattr(client, 'position_change_all'):
            try:
                if prev_id is not None:
                    client.position_change_all('unsubscribeMessage', prev_id)
                client.position_change_all('subscribeMessage', norm_id)
            except Exception:
                pass
    except Exception:
        pass


def _extract_mode_from_profile(profile_msg: Any) -> Tuple[Optional[str], Any, Optional[str]]:
    """Inspect IQ Option profile payload conservatively.
    IMPORTANT: IQ Option's WebSocket `profile` message often returns legacy `balance_type: 1` (REAL) and
    the primary REAL `balance_id` EVEN WHEN the user has switched to PRACTICE inside IQ Option's traderoom.
    Therefore, on a dual-wallet account (both REAL type=1 and PRACTICE type=4 present), this function
    NEVER assumes REAL from legacy profile fields alone — it only returns a mode when unambiguous:
      1. Exactly one balance entry has an explicit `is_active` / `active` == True flag.
      2. The account has ONLY a single wallet type (only PRACTICE or only REAL).
      3. Profile explicitly indicates PRACTICE (balance_type == 4, balance_id -> type 4, or is_demo == True).
    Otherwise returns (None, None, None) so _detect_balance_mode() requires live user-settings verification.
    """
    if not isinstance(profile_msg, dict):
        return (None, None, None)

    balances = profile_msg.get('balances')
    bal_list = [b for b in balances if isinstance(b, dict)] if isinstance(balances, list) else []

    # 1. Explicit active balance flag on exactly one balance entry
    active_entries = [
        b
        for b in bal_list
        if any(b.get(flag) is True for flag in ('is_active', 'active', 'is_selected', 'selected', 'is_current', 'current'))
    ]
    if len(active_entries) == 1:
        b = active_entries[0]
        btype = _coerce_int(b.get('type'))
        curr = str(b.get('currency') or 'USD').upper()
        if btype == 1:
            return ('REAL', _coerce_balance_id(b.get('id')), curr)
        if btype == 4:
            return ('PRACTICE', _coerce_balance_id(b.get('id')), curr)

    real_entries = [b for b in bal_list if _coerce_int(b.get('type')) == 1]
    practice_entries = [b for b in bal_list if _coerce_int(b.get('type')) == 4]

    # 2. Single-wallet account (unambiguous)
    if practice_entries and not real_entries:
        b = practice_entries[0]
        return ('PRACTICE', _coerce_balance_id(b.get('id')), str(b.get('currency') or 'USD').upper())
    if real_entries and not practice_entries:
        b = real_entries[0]
        return ('REAL', _coerce_balance_id(b.get('id')), str(b.get('currency') or 'USD').upper())

    # 3. Explicit PRACTICE signal in profile (safe — never assumes REAL)
    prof_bal_id = _coerce_balance_id(profile_msg.get('balance_id'))
    if prof_bal_id is not None and bal_list:
        m, bid, curr = _resolve_mode_from_balances(bal_list, prof_bal_id)
        if m == 'PRACTICE':
            return ('PRACTICE', bid, curr)

    bal_type = _coerce_int(profile_msg.get('balance_type'))
    if bal_type == 4 or profile_msg.get('is_demo') is True:
        if practice_entries:
            b = practice_entries[0]
            return ('PRACTICE', _coerce_balance_id(b.get('id')), str(b.get('currency') or 'USD').upper())
        return ('PRACTICE', prof_bal_id, str(profile_msg.get('currency') or 'USD').upper())

    # 4. Dual-wallet account with legacy balance_type == 1: AMBIGUOUS — do NOT assume REAL!
    if real_entries and practice_entries:
        return (None, None, None)

    # 5. Profile without balances array: only trust explicit PRACTICE; never assume REAL without balances list
    return (None, None, None)


def _peek_balance_mode_nonblocking(client: Any, target_mode: str = 'AUTO') -> Tuple[str, bool]:
    """Read current IQ Option active balance mode strictly from in-memory verified state (never triggers WS I/O)."""
    global _confirmed_mode, _mode_verified, _broker_wallet_confirmed, _active_balance_id, _active_currency, _mode_detection_diag
    if client is None:
        return ('UNVERIFIED', False)

    api = getattr(client, 'api', None)
    if api is not None:
        # 1. Live user-settings / user-settings-changed balanceId captured on WebSocket
        settings_bal_id = getattr(api, '_nt_user_settings_balance_id', None)
        if settings_bal_id is not None:
            bal_list = _get_balances_list(client, refresh=False)
            mode, bid, curr = _resolve_mode_from_balances(bal_list, settings_bal_id)
            if mode in ('PRACTICE', 'REAL'):
                prev_mode = _confirmed_mode
                prev_confirmed = _broker_wallet_confirmed
                _confirmed_mode = mode
                _mode_verified = True
                _broker_wallet_confirmed = True
                if bid is not None:
                    _active_balance_id = bid
                    _sync_local_balance_id(client, bid)
                if curr:
                    _active_currency = curr
                if prev_mode != mode or not prev_confirmed:
                    _invalidate_balance_cache()
                    if isinstance(_mode_detection_diag, dict):
                        _mode_detection_diag = {
                            **_mode_detection_diag,
                            'source': getattr(api, '_nt_user_settings_source', None) or 'user_settings_changed',
                            'verified': True,
                            'brokerWalletConfirmed': True,
                            'realOrdersAllowed': mode == 'REAL',
                            'userSettingsMode': mode,
                            'lastCheckedAt': time.time(),
                        }
                matches = True if target_mode == 'AUTO' else (mode == target_mode)
                return (mode, matches)
        # 2. Previously verified session mode (never assume REAL from raw legacy profile!)
        if _mode_verified and _confirmed_mode in ('PRACTICE', 'REAL'):
            matches = True if target_mode == 'AUTO' else (_confirmed_mode == target_mode)
            return (_confirmed_mode, bool(matches))
        return ('UNVERIFIED', False)

    # Non-iqoptionapi mock client in unit tests
    if hasattr(client, 'get_balance_mode'):
        try:
            raw = client.get_balance_mode()
            if raw:
                confirmed = str(raw).strip().upper()
                if confirmed in ('PRACTICE', 'REAL'):
                    matches = True if target_mode == 'AUTO' else (confirmed == target_mode)
                    return (confirmed, matches)
        except Exception:
            return ('UNVERIFIED', False)
    if _mode_verified and _confirmed_mode in ('PRACTICE', 'REAL'):
        return (_confirmed_mode, bool(target_mode == 'AUTO' or _confirmed_mode == target_mode))
    return ('UNVERIFIED', False)


def _detect_balance_mode(
    client: Any,
    timeout_seconds: Optional[float] = None,
    refresh: bool = False,
) -> Tuple[str, bool]:
    """Detect whichever account mode (PRACTICE or REAL) is currently active inside IQ Option.
    NEVER calls client.change_balance(), NEVER silently switches modes, and NEVER assumes REAL when uncertain.
    If IQ Option user-settings does not expose an active wallet on a dual-wallet account (e.g., 4004 / balance_type=0),
    binds strictly to the verified PRACTICE (type=4) wallet only while keeping real-money orders strictly blocked.
    """
    global _confirmed_mode, _mode_verified, _broker_wallet_confirmed, _active_balance_id, _active_currency, _mode_detection_diag, _last_error
    timeout = _MODE_TIMEOUT if timeout_seconds is None else timeout_seconds

    if client is None:
        return ('UNVERIFIED', False)

    api = getattr(client, 'api', None)

    if api is not None:
        bal_list = _get_balances_list(client, refresh=refresh, timeout_seconds=min(timeout, 2.5))
        profile_msg = getattr(getattr(api, 'profile', None), 'msg', None)
        known_bal_ids = {
            str(_coerce_balance_id(b.get('id')))
            for b in bal_list
            if isinstance(b, dict) and _coerce_balance_id(b.get('id')) is not None
        }
        available_modes: List[str] = []
        if any(_coerce_int(b.get('type')) == 1 for b in bal_list):
            available_modes.append('REAL')
        if any(_coerce_int(b.get('type')) == 4 for b in bal_list):
            available_modes.append('PRACTICE')

        legacy_profile_mode: Optional[str] = None
        prof_btype_coerced: Optional[int] = None
        prof_bal_id_mode: Optional[str] = None
        if isinstance(profile_msg, dict):
            prof_btype_coerced = _coerce_int(profile_msg.get('balance_type'))
            if prof_btype_coerced == 1:
                legacy_profile_mode = 'REAL'
            elif prof_btype_coerced == 4:
                legacy_profile_mode = 'PRACTICE'
            raw_pbid = _coerce_balance_id(profile_msg.get('balance_id'))
            if raw_pbid is not None and bal_list:
                prof_bal_id_mode, _, _ = _resolve_mode_from_balances(bal_list, raw_pbid)

        bal_item_keys = sorted(
            {str(k) for b in bal_list[:4] if isinstance(b, dict) for k in b.keys()}
        )[:20]

        profile_diag: dict = {
            'hasProfileMsg': isinstance(profile_msg, dict),
            'hasBalanceType': isinstance(profile_msg, dict) and profile_msg.get('balance_type') is not None,
            'balanceTypeValue': prof_btype_coerced,
            'hasBalanceId': isinstance(profile_msg, dict) and _coerce_balance_id(profile_msg.get('balance_id')) is not None,
            'balanceIdMode': prof_bal_id_mode,
            'balancesCount': len(bal_list),
            'balanceItemKeys': bal_item_keys,
            'httpProfileChecked': False,
            'httpProfileBalanceType': None,
            'httpProfileBalanceIdMode': None,
        }

        # 1. Authoritative: IQ Option traderoom_gl_common user-settings (live push or fresh WS query)
        settings_bal_id = getattr(api, '_nt_user_settings_balance_id', None)
        settings_source = getattr(api, '_nt_user_settings_source', None)
        settings_age = time.time() - float(getattr(api, '_nt_user_settings_at', 0.0) or 0.0)
        us_diag: dict = {
            'queried': False,
            'attempts': 0,
            'responseName': None,
            'responseStatus': None,
            'matchedQuery': None,
            'foundBalanceId': settings_bal_id is not None,
            'attemptsSummary': [],
        }

        should_query_settings = refresh or settings_bal_id is None or settings_age > 30.0
        if should_query_settings:
            q_bal_id, q_src, q_diag = _query_user_settings_balance_id(
                client,
                timeout_seconds=min(timeout, 3.8),
                known_balance_ids=known_bal_ids or None,
            )
            us_diag = q_diag
            if q_bal_id is not None:
                settings_bal_id = q_bal_id
                settings_source = q_src or 'user_settings'

        if settings_bal_id is not None:
            us_mode, us_bid, us_curr = _resolve_mode_from_balances(bal_list, settings_bal_id)
            if us_mode in ('PRACTICE', 'REAL'):
                prev_mode = _confirmed_mode
                _active_balance_id = us_bid
                _sync_local_balance_id(client, us_bid)
                if us_curr:
                    _active_currency = us_curr
                _confirmed_mode = us_mode
                _mode_verified = True
                _broker_wallet_confirmed = True
                _last_error = None
                if prev_mode != us_mode:
                    _invalidate_balance_cache()
                _mode_detection_diag = {
                    'source': settings_source or 'user_settings',
                    'verified': True,
                    'brokerWalletConfirmed': True,
                    'realOrdersAllowed': us_mode == 'REAL',
                    'userSettingsQueried': us_diag.get('queried', False),
                    'userSettingsResponseName': us_diag.get('responseName'),
                    'userSettingsResponseStatus': us_diag.get('responseStatus'),
                    'userSettingsMatchedQuery': us_diag.get('matchedQuery'),
                    'userSettingsAttempts': us_diag.get('attemptsSummary', []),
                    'userSettingsMode': us_mode,
                    'profileLegacyMode': legacy_profile_mode,
                    'profileDiag': profile_diag,
                    'availableModes': available_modes,
                    'lastCheckedAt': time.time(),
                }
                return (us_mode, True)

        # 2. Unambiguous profile / balances signals (explicit active flag, single-wallet, or explicit PRACTICE)
        #    NEVER assumes REAL on dual-wallet accounts from legacy profile_msg['balance_type'] == 1 or 0!
        merged_profile = dict(profile_msg) if isinstance(profile_msg, dict) else {}
        if bal_list:
            merged_profile['balances'] = bal_list
        prof_mode, prof_bal_id, prof_curr = _extract_mode_from_profile(merged_profile)
        prof_source = 'single_wallet_or_explicit_profile'

        # 2b. Read-only HTTP /api/getprofile cross-check if WS profile & user-settings did not verify mode.
        #     Still obeys strict safety rule: NEVER assumes REAL on dual-wallet accounts!
        if prof_mode not in ('PRACTICE', 'REAL'):
            http_profile = _query_http_getprofile(client, timeout_seconds=1.5)
            profile_diag['httpProfileChecked'] = True
            if isinstance(http_profile, dict):
                http_btype = _coerce_int(http_profile.get('balance_type'))
                profile_diag['httpProfileBalanceType'] = http_btype
                http_bid = _coerce_balance_id(http_profile.get('balance_id'))
                if http_bid is not None and bal_list:
                    http_bid_mode, _, _ = _resolve_mode_from_balances(bal_list, http_bid)
                    profile_diag['httpProfileBalanceIdMode'] = http_bid_mode
                merged_http = dict(http_profile)
                if bal_list and not isinstance(merged_http.get('balances'), list):
                    merged_http['balances'] = bal_list
                h_mode, h_bal_id, h_curr = _extract_mode_from_profile(merged_http)
                if h_mode in ('PRACTICE', 'REAL'):
                    prof_mode, prof_bal_id, prof_curr = h_mode, h_bal_id, h_curr
                    prof_source = 'http_getprofile_explicit'

        if prof_mode in ('PRACTICE', 'REAL'):
            prev_mode = _confirmed_mode
            if prof_bal_id is not None:
                _active_balance_id = prof_bal_id
                _sync_local_balance_id(client, prof_bal_id)
            if prof_curr:
                _active_currency = prof_curr
            _confirmed_mode = prof_mode
            _mode_verified = True
            _broker_wallet_confirmed = True
            _last_error = None
            if prev_mode != prof_mode:
                _invalidate_balance_cache()
            _mode_detection_diag = {
                'source': prof_source,
                'verified': True,
                'brokerWalletConfirmed': True,
                'realOrdersAllowed': prof_mode == 'REAL',
                'userSettingsQueried': us_diag.get('queried', False),
                'userSettingsResponseName': us_diag.get('responseName'),
                'userSettingsResponseStatus': us_diag.get('responseStatus'),
                'userSettingsMatchedQuery': us_diag.get('matchedQuery'),
                'userSettingsAttempts': us_diag.get('attemptsSummary', []),
                'userSettingsMode': None,
                'profileLegacyMode': legacy_profile_mode,
                'profileDiag': profile_diag,
                'availableModes': available_modes,
                'lastCheckedAt': time.time(),
            }
            return (prof_mode, True)

        # 3. Dual-wallet account where IQ Option did NOT expose an active wallet (e.g., user-settings 4004 & balance_type=0):
        #    NEVER assume REAL and NEVER allow real-money orders!
        #    If a verified PRACTICE (type=4) wallet exists in balances, safely bind locally to PRACTICE (type=4) ONLY
        #    so the user can inspect Demo balance, stream candles/AI analysis, and practice trade without blanket lockout,
        #    while real-money orders remain strictly hard-blocked until IQ Option confirms an active REAL wallet.
        practice_entries = [b for b in bal_list if _coerce_int(b.get('type')) == 4 and _coerce_balance_id(b.get('id')) is not None]
        if practice_entries:
            practice_entry = practice_entries[0]
            practice_bal_id = _coerce_balance_id(practice_entry.get('id'))
            practice_curr = str(practice_entry.get('currency') or 'USD').upper()
            prev_mode = _confirmed_mode
            _active_balance_id = practice_bal_id
            _sync_local_balance_id(client, practice_bal_id)
            _active_currency = practice_curr
            _confirmed_mode = 'PRACTICE'
            _mode_verified = True
            _broker_wallet_confirmed = False
            _last_error = None
            if prev_mode != 'PRACTICE':
                _invalidate_balance_cache()
            _mode_detection_diag = {
                'source': 'safe_practice_fallback',
                'verified': True,
                'brokerWalletConfirmed': False,
                'realOrdersAllowed': False,
                'note': (
                    'IQ Option user-settings did not confirm an active wallet; safely bound locally to PRACTICE (type=4) '
                    'wallet without changing IQ Option settings. Real-money orders remain strictly blocked until IQ Option '
                    'confirms an active REAL wallet.'
                ),
                'userSettingsQueried': us_diag.get('queried', False),
                'userSettingsResponseName': us_diag.get('responseName'),
                'userSettingsResponseStatus': us_diag.get('responseStatus'),
                'userSettingsMatchedQuery': us_diag.get('matchedQuery'),
                'userSettingsAttempts': us_diag.get('attemptsSummary', []),
                'userSettingsMode': None,
                'profileLegacyMode': legacy_profile_mode,
                'profileDiag': profile_diag,
                'availableModes': available_modes,
                'lastCheckedAt': time.time(),
            }
            return ('PRACTICE', True)

        # 4. No verified PRACTICE wallet available AND active wallet is unknown: stay strictly UNVERIFIED & block ALL orders!
        _confirmed_mode = 'UNVERIFIED'
        _mode_verified = False
        _broker_wallet_confirmed = False
        _active_balance_id = None
        try:
            import iqoptionapi.global_value as _gv_clear
            _gv_clear.balance_id = None
        except Exception:
            pass
        _mode_detection_diag = {
            'source': 'unverified_ambiguous_profile',
            'verified': False,
            'brokerWalletConfirmed': False,
            'realOrdersAllowed': False,
            'userSettingsQueried': us_diag.get('queried', False),
            'userSettingsResponseName': us_diag.get('responseName'),
            'userSettingsResponseStatus': us_diag.get('responseStatus'),
            'userSettingsMatchedQuery': us_diag.get('matchedQuery'),
            'userSettingsAttempts': us_diag.get('attemptsSummary', []),
            'userSettingsMode': None,
            'profileLegacyMode': legacy_profile_mode,
            'profileDiag': profile_diag,
            'availableModes': available_modes,
            'lastCheckedAt': time.time(),
        }
        _last_error = (
            'IQ Option session authenticated, but active account mode could not be verified '
            '(no verified active wallet or PRACTICE wallet returned by broker); '
            'live orders are blocked.'
        )
        return ('UNVERIFIED', False)

    # Non-iqoptionapi mock/test client without `.api`: read-only query via client.get_balance_mode()
    if hasattr(client, 'get_balance_mode'):
        try:
            raw_cur = _run_with_timeout(client.get_balance_mode, timeout, 'get_balance_mode')
            if raw_cur:
                normalized = str(raw_cur).strip().upper()
                if normalized in ('PRACTICE', 'REAL'):
                    _confirmed_mode = normalized
                    _mode_verified = True
                    _broker_wallet_confirmed = True
                    _mode_detection_diag = {
                        'source': 'client_get_balance_mode',
                        'verified': True,
                        'brokerWalletConfirmed': True,
                        'realOrdersAllowed': normalized == 'REAL',
                        'userSettingsQueried': False,
                        'userSettingsResponseName': None,
                        'userSettingsMode': normalized,
                        'profileLegacyMode': None,
                        'availableModes': [normalized],
                        'lastCheckedAt': time.time(),
                    }
                    return (normalized, True)
        except Exception:
            if _is_client_alive(client) and _mode_verified and _confirmed_mode in ('PRACTICE', 'REAL'):
                return (_confirmed_mode, False if refresh else True)
            _confirmed_mode = 'UNVERIFIED'
            _mode_verified = False
            _broker_wallet_confirmed = False
            return ('UNVERIFIED', False)

    _confirmed_mode = 'UNVERIFIED'
    _mode_verified = False
    _broker_wallet_confirmed = False
    return ('UNVERIFIED', False)


def _ensure_balance_mode(
    client: Any,
    target_mode: str = 'AUTO',
    timeout_seconds: Optional[float] = None,
    refresh: bool = False,
) -> Tuple[str, bool]:
    """Detect IQ Option's live active account mode without EVER silently calling change_balance().
    If target_mode is 'AUTO', follows whichever mode (PRACTICE or REAL) IQ Option reports.
    If an explicit mode assertion ('PRACTICE' or 'REAL') is supplied and mismatches IQ Option's live mode,
    returns (actual_mode, False) without altering the user's IQ Option account mode.
    """
    global _last_error
    confirmed, verified = _detect_balance_mode(client, timeout_seconds=timeout_seconds, refresh=refresh)
    if not verified or confirmed not in ('PRACTICE', 'REAL'):
        return (confirmed, False)
    if target_mode in ('PRACTICE', 'REAL') and confirmed != target_mode:
        _last_error = (
            f'IQ Option active account mode is {confirmed}, which differs from expected {target_mode}. '
            'Switch account mode inside IQ Option directly; NovaTrade never switches modes silently.'
        )
        return (confirmed, False)
    return (confirmed, True)


def _require_verified_mode(
    client: Any,
    target_mode: str = 'AUTO',
    refresh: bool = False,
) -> Tuple[str, bool]:
    confirmed, verified = _ensure_balance_mode(client, target_mode=target_mode, refresh=refresh)
    if not verified or confirmed not in ('PRACTICE', 'REAL'):
        if target_mode in ('PRACTICE', 'REAL') and confirmed in ('PRACTICE', 'REAL') and confirmed != target_mode:
            raise HTTPException(
                409,
                f'IQ Option is currently in {confirmed} mode (expected {target_mode}). Switch mode inside IQ Option first; NovaTrade will never silently switch your account mode.',
            )
        raise HTTPException(
            409,
            f'IQ Option connector could not verify active account mode (reported {confirmed}).',
        )
    return (confirmed, verified)


def connect(
    email: Optional[str] = None,
    password: Optional[str] = None,
    target_mode: Optional[str] = None,
    force_reconnect: bool = False,
):
    """Single-flight, generation-fenced IQ Option session establishment.
    Reuses any existing healthy authenticated session without redundant reconnects,
    coalesces concurrent callers cleanly, and follows IQ Option's active account mode.
    """
    global _client, _last_error, _connected_at, _requested_mode, _confirmed_mode, _mode_verified, _broker_wallet_confirmed
    global _active_ws_url, _active_ws_via_proxy, _opcodes_updated, _last_balance_cache
    global _session_generation, _inflight_connect, _last_connect_stage, _last_connect_duration_ms

    resolved_mode = _normalize_mode(target_mode) or 'AUTO'
    existing_flight: Optional[_InFlightConnect] = None
    flight: Optional[_InFlightConnect] = None
    stale_client: Any = None
    superseded_client: Any = None
    target_email: Optional[str] = None
    target_password: Optional[str] = None

    with _state_lock:
        prior_email = getattr(_client, 'email', None) if _client is not None else None
        prior_password = getattr(_client, 'password', None) if _client is not None else None

        # Only force reconnect if a genuinely different email account is requested
        email_changed = bool(
            email
            and prior_email
            and str(email).strip().lower() != str(prior_email).strip().lower()
        )
        effective_force = force_reconnect or email_changed

        if _client is not None and not effective_force:
            if _is_client_alive(_client):
                _requested_mode = resolved_mode
                return _client
            stale_client = _client
            _client = None
            _connected_at = None
            _mode_verified = False
            _broker_wallet_confirmed = False
            _active_ws_url = None
            _active_ws_via_proxy = False
            _opcodes_updated = False
            _last_balance_cache = None
            _last_error = 'IQ Option WebSocket session disconnected; reconnecting.'

        if _inflight_connect is not None and not effective_force:
            existing_flight = _inflight_connect
        else:
            target_email = email or os.environ.get('IQ_EMAIL') or prior_email
            target_password = password or os.environ.get('IQ_PASSWORD') or prior_password
            if not target_email or not target_password:
                raise HTTPException(503, 'IQ Option email and password are required.')

            if effective_force and _client is not None:
                stale_client = _client
                _client = None
                _connected_at = None
                _mode_verified = False
                _broker_wallet_confirmed = False
                _active_ws_url = None
                _active_ws_via_proxy = False
                _opcodes_updated = False
                _last_balance_cache = None

            if _inflight_connect is not None:
                _inflight_connect.cancel_event.set()
                superseded_client = _inflight_connect.client_ref

            _session_generation += 1
            flight = _InFlightConnect(generation=_session_generation, target_mode=resolved_mode)
            _inflight_connect = flight
            _last_connect_stage = 'initializing'

    # Joiner path: wait for the single active connection leader without holding _lock
    if existing_flight is not None:
        wait_cap = max(2.0, _CONNECT_TIMEOUT + _MODE_TIMEOUT + 2.0)
        finished = existing_flight.done.wait(timeout=wait_cap)
        if not finished:
            raise HTTPException(504, 'IQ Option broker connection timed out; please retry.')
        if existing_flight.error is not None:
            raise existing_flight.error
        if existing_flight.result_client is not None and _is_client_alive(existing_flight.result_client):
            return existing_flight.result_client
        with _state_lock:
            if _client is not None and _is_client_alive(_client):
                return _client
        raise HTTPException(502, 'Broker connection did not establish an active session; please retry.')

    assert flight is not None
    my_gen = flight.generation
    client: Any = None
    try:
        if stale_client is not None:
            _safe_close_client(stale_client, reset_globals=True)
        if superseded_client is not None and superseded_client is not stale_client:
            _safe_close_client(superseded_client, reset_globals=False)

        _patch_iqoptionapi()
        _reset_iq_global_locks()

        from iqoptionapi.stable_api import IQ_Option
        client = IQ_Option(target_email, target_password)
        flight.client_ref = client

        deadline = time.monotonic() + _CONNECT_TIMEOUT
        result = _run_with_timeout(
            client.connect,
            _CONNECT_TIMEOUT,
            'iq_connect',
            cancel_event=flight.cancel_event,
            generation=my_gen,
            deadline=deadline,
        )
        if not result or not result[0]:
            reason = result[1] if isinstance(result, (list, tuple)) and len(result) > 1 else 'Authentication failed or 2FA required.'
            flight.cancel_event.set()
            _safe_close_client(client, reset_globals=False)
            raise RuntimeError(str(reason))

        # Fence before mutating shared state: if superseded or cancelled while finishing, discard safely
        with _state_lock:
            still_current = (not flight.cancel_event.is_set()) and (_session_generation == my_gen)
        if not still_current:
            _safe_close_client(client, reset_globals=False)
            err = HTTPException(409, 'Connection attempt was superseded by a newer session; please retry.')
            flight.error = err
            raise err

        _set_connect_stage('mode_detect')
        confirmed_mode, mode_verified = _detect_balance_mode(client, timeout_seconds=_MODE_TIMEOUT, refresh=False)

        with _state_lock:
            still_current = (not flight.cancel_event.is_set()) and (_session_generation == my_gen)
            if not still_current:
                discard_client = client
            else:
                discard_client = None
                _requested_mode = resolved_mode
                _client = client
                _confirmed_mode = confirmed_mode
                _mode_verified = mode_verified
                _last_error = None if mode_verified else _last_error
                _connected_at = time.time()
                _last_balance_cache = None
                _last_connect_stage = 'connected'
                _last_connect_duration_ms = round((time.monotonic() - flight.started_at) * 1000, 1)
                flight.result_client = client

        if discard_client is not None:
            _safe_close_client(discard_client, reset_globals=False)
            err = HTTPException(409, 'Connection attempt was superseded by a newer session; please retry.')
            flight.error = err
            raise err

        return client
    except HTTPException as http_exc:
        flight.cancel_event.set()
        if flight.error is None:
            flight.error = http_exc
        raise
    except TimeoutError as exc:
        flight.cancel_event.set()
        with _state_lock:
            if _session_generation == my_gen:
                _session_generation += 1
                _last_connect_stage = 'timeout'
                _last_connect_duration_ms = round((time.monotonic() - flight.started_at) * 1000, 1)
                _last_error = _sanitize_error(f'Connection timed out: {exc}', (target_email, target_password))
        if client is not None:
            _safe_close_client(client, reset_globals=False)
        err = HTTPException(504, 'IQ Option broker connection timed out; please retry.')
        flight.error = err
        raise err from None
    except Exception as exc:
        flight.cancel_event.set()
        with _state_lock:
            if _session_generation == my_gen:
                _session_generation += 1
                _last_connect_stage = 'failed'
                _last_connect_duration_ms = round((time.monotonic() - flight.started_at) * 1000, 1)
                _last_error = _sanitize_error(f'{type(exc).__name__}: {exc}', (target_email, target_password))
        if client is not None:
            _safe_close_client(client, reset_globals=False)
        err = HTTPException(502, f'Broker connection failed ({type(exc).__name__}); check connector configuration.')
        flight.error = err
        raise err from None
    finally:
        with _state_lock:
            if _inflight_connect is flight:
                _inflight_connect = None
        flight.done.set()


def _try_reconnect_session(client: Any, target_mode: str = 'AUTO') -> Optional[Any]:
    """Attempt a single safe, generation-fenced reconnect ONLY when the existing socket is genuinely dead."""
    if _is_client_alive(client):
        return client
    email = getattr(client, 'email', None) or os.environ.get('IQ_EMAIL')
    password = getattr(client, 'password', None) or os.environ.get('IQ_PASSWORD')
    if email and password:
        new_client = connect(email=email, password=password, target_mode=target_mode, force_reconnect=True)
        return new_client
    if hasattr(client, 'connect'):
        cancel_ev = threading.Event()
        with _state_lock:
            cur_gen = _session_generation
        res = _run_with_timeout(
            client.connect,
            _CONNECT_TIMEOUT,
            'client_reconnect',
            cancel_event=cancel_ev,
            generation=cur_gen,
            deadline=time.monotonic() + _CONNECT_TIMEOUT,
        )
        if isinstance(res, (list, tuple)) and res and res[0]:
            _detect_balance_mode(client, refresh=False)
            return client
    return None


def _fetch_balance_safe(
    client: Any,
    active_mode: str,
    timeout_seconds: Optional[float] = None,
    allow_cache: bool = True,
) -> Tuple[float, str]:
    """Retrieve IQ Option balance for the active mode with short cache coalescing and timeout resilience.
    Never tears down a healthy alive WebSocket session on a single transient read timeout.
    Returns (balance_float, currency_code).
    """
    global _last_error, _last_balance_cache, _active_currency
    if active_mode not in ('PRACTICE', 'REAL'):
        raise HTTPException(
            409,
            f'Cannot fetch IQ Option account balance while active mode is {active_mode}.',
        )
    timeout = _BALANCE_TIMEOUT if timeout_seconds is None else timeout_seconds

    if allow_cache and _BALANCE_CACHE_TTL_SECONDS > 0:
        with _state_lock:
            cached = _last_balance_cache
        if (
            cached is not None
            and cached.get('mode') == active_mode
            and (time.monotonic() - float(cached.get('ts', 0))) <= _BALANCE_CACHE_TTL_SECONDS
            and _is_client_alive(client)
        ):
            return (float(cached['balance']), str(cached.get('currency') or _active_currency or 'USD'))

    has_low_level_api = hasattr(client, 'api') and hasattr(client.api, 'get_balances')

    if not has_low_level_api:
        try:
            raw_bal = _run_with_timeout(client.get_balance, timeout, 'get_balance')
        except TimeoutError:
            _last_error = f'Timed out retrieving IQ Option balance after {timeout:.1f}s.'
            raise HTTPException(504, 'IQ Option upstream timed out retrieving account balance.') from None
        except HTTPException:
            raise
        except Exception as exc:
            _last_error = _sanitize_error(f'get_balance() failed: {type(exc).__name__}: {exc}')
            raise HTTPException(502, f'Failed to retrieve account balance ({type(exc).__name__}).') from None
        parsed_bal = _parse_finite_float(raw_bal)
        if parsed_bal is None:
            _last_error = 'Broker did not return a valid numeric account balance.'
            raise HTTPException(502, 'Broker did not return a valid numeric account balance.')
        curr = str(getattr(client, 'currency', None) or _active_currency or 'USD').upper()
        with _state_lock:
            _last_balance_cache = {'balance': parsed_bal, 'currency': curr, 'mode': active_mode, 'ts': time.monotonic()}
        return (parsed_bal, curr)

    last_exc: Optional[Exception] = None
    for attempt in range(2):
        try:
            if not _is_client_alive(client):
                reconnected = _try_reconnect_session(client, 'AUTO')
                if reconnected is None:
                    raise ConnectionError('IQ Option WebSocket session is disconnected.')
                client = reconnected
            _reset_iq_global_locks()
            client.api.balances_raw = None
            _run_with_timeout(client.api.get_balances, min(timeout, 4.0), 'send_get_balances')
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                raw = getattr(client.api, 'balances_raw', None)
                if raw is not None:
                    msg_list = raw.get('msg') if isinstance(raw, dict) else None
                    if not isinstance(msg_list, list):
                        raise RuntimeError('Invalid balances payload from broker.')
                    try:
                        import iqoptionapi.global_value as global_value
                        target_id = getattr(global_value, 'balance_id', None) or _active_balance_id
                    except Exception:
                        target_id = _active_balance_id
                    expected_type = 1 if active_mode == 'REAL' else 4
                    matched_amount = None
                    matched_currency = _active_currency or 'USD'
                    found_entry = False
                    # Match by active balance_id first, verifying type agrees with detected active_mode
                    for entry in msg_list:
                        if isinstance(entry, dict) and target_id is not None and entry.get('id') == target_id:
                            if entry.get('type') in (None, expected_type):
                                matched_amount = entry.get('amount')
                                if entry.get('currency'):
                                    matched_currency = str(entry.get('currency')).upper()
                                found_entry = True
                                break
                    if not found_entry:
                        for entry in msg_list:
                            if isinstance(entry, dict) and entry.get('type') == expected_type:
                                matched_amount = entry.get('amount')
                                if entry.get('currency'):
                                    matched_currency = str(entry.get('currency')).upper()
                                found_entry = True
                                break
                    if not found_entry:
                        raise RuntimeError(f'Balance entry for mode {active_mode} not found.')
                    parsed_amount = _parse_finite_float(matched_amount)
                    if parsed_amount is None:
                        raise RuntimeError('Broker returned missing or non-numeric balance amount.')
                    _active_currency = matched_currency
                    with _state_lock:
                        _last_balance_cache = {
                            'balance': parsed_amount,
                            'currency': matched_currency,
                            'mode': active_mode,
                            'ts': time.monotonic(),
                        }
                    return (parsed_amount, matched_currency)
                if not _is_client_alive(client):
                    break
                time.sleep(0.05)
        except HTTPException:
            raise
        except Exception as exc:
            last_exc = exc
            _last_error = _sanitize_error(f'get_balances failed: {type(exc).__name__}: {exc}')

        # Only reconnect if the WebSocket actually died; if still alive, retry read on the SAME healthy session
        if attempt == 0 and not _is_client_alive(client):
            try:
                reconnected = _try_reconnect_session(client, 'AUTO')
                if reconnected is None:
                    break
                client = reconnected
            except HTTPException:
                break
            except Exception as exc:
                last_exc = exc
                _last_error = _sanitize_error(f'balance reconnect failed: {type(exc).__name__}: {exc}')
                break

    if last_exc is not None:
        raise HTTPException(502, f'IQ Option upstream error retrieving balance ({type(last_exc).__name__}).') from None
    _last_error = 'Timed out waiting for IQ Option account balance.'
    raise HTTPException(504, 'IQ Option upstream timed out retrieving account balance.')


def _resolve_active_id(client: Any, clean_symbol: str) -> Optional[int]:
    global _opcodes_updated
    try:
        from iqoptionapi.constants import ACTIVES
    except Exception:
        return None

    if clean_symbol in ACTIVES:
        return int(ACTIVES[clean_symbol])

    upper_map = {str(k).upper(): v for k, v in ACTIVES.items()}
    if clean_symbol in upper_map:
        return int(upper_map[clean_symbol])

    if not _opcodes_updated and hasattr(client, 'update_ACTIVES_OPCODE'):
        _opcodes_updated = True
        try:
            _run_with_timeout(client.update_ACTIVES_OPCODE, 5.0, 'update_ACTIVES_OPCODE')
            if clean_symbol in ACTIVES:
                return int(ACTIVES[clean_symbol])
            upper_map = {str(k).upper(): v for k, v in ACTIVES.items()}
            if clean_symbol in upper_map:
                return int(upper_map[clean_symbol])
        except Exception:
            pass
    return None


def _fetch_candles_safe(
    client: Any,
    clean_symbol: str,
    interval: int,
    count: int,
    active_mode: str = 'AUTO',
    timeout_seconds: Optional[float] = None,
) -> list:
    global _last_error
    timeout = _CANDLES_TIMEOUT if timeout_seconds is None else timeout_seconds
    has_low_level_api = (
        hasattr(client, 'api')
        and hasattr(client.api, 'getcandles')
        and hasattr(client.api, 'candles')
    )

    if not has_low_level_api:
        try:
            rows = _run_with_timeout(
                lambda: client.get_candles(clean_symbol, interval, count, int(time.time())),
                timeout,
                f'get_candles_{clean_symbol}',
            )
        except TimeoutError:
            _last_error = f'Timed out waiting for IQ Option candles for {clean_symbol}.'
            raise HTTPException(504, f'IQ Option upstream timed out returning candles for {clean_symbol}.') from None
        except HTTPException:
            raise
        except Exception as exc:
            _last_error = _sanitize_error(f'get_candles({clean_symbol}) failed: {type(exc).__name__}: {exc}')
            raise HTTPException(502, f'Broker failed to retrieve candles for {clean_symbol} ({type(exc).__name__}).') from None
        if not isinstance(rows, list):
            raise HTTPException(502, f'Broker did not return valid candles for {clean_symbol}.')
        return rows

    active_id = _resolve_active_id(client, clean_symbol)
    if active_id is None:
        raise HTTPException(404, f'Unsupported or unknown IQ Option symbol "{clean_symbol}".')

    last_exc: Optional[Exception] = None
    for attempt in range(2):
        try:
            if not _is_client_alive(client):
                reconnected = _try_reconnect_session(client, 'AUTO')
                if reconnected is None:
                    raise ConnectionError('IQ Option WebSocket session is disconnected.')
                client = reconnected
            _reset_iq_global_locks()
            client.api.candles.candles_data = None
            _run_with_timeout(
                lambda: client.api.getcandles(int(active_id), int(interval), int(count), int(time.time())),
                min(timeout, 4.0),
                f'send_getcandles_{clean_symbol}',
            )
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                rows = getattr(client.api.candles, 'candles_data', None)
                if rows is not None:
                    if not isinstance(rows, list):
                        raise HTTPException(502, f'Broker returned invalid candle payload for {clean_symbol}.')
                    return rows
                if not _is_client_alive(client):
                    break
                time.sleep(0.05)
        except HTTPException:
            raise
        except Exception as exc:
            last_exc = exc
            _last_error = _sanitize_error(f'getcandles({clean_symbol}) failed: {type(exc).__name__}: {exc}')

        # Only reconnect if the WebSocket actually died; preserve healthy sessions on transient read timeouts
        if attempt == 0 and not _is_client_alive(client):
            try:
                reconnected = _try_reconnect_session(client, 'AUTO')
                if reconnected is None:
                    break
                client = reconnected
            except HTTPException:
                break
            except Exception as exc:
                last_exc = exc
                _last_error = _sanitize_error(f'reconnect failed: {type(exc).__name__}: {exc}')
                break

    if last_exc is not None:
        raise HTTPException(502, f'IQ Option upstream error retrieving candles for {clean_symbol} ({type(last_exc).__name__}).') from None
    _last_error = f'Timed out waiting for IQ Option candles for {clean_symbol}.'
    raise HTTPException(504, f'IQ Option upstream timed out returning candles for {clean_symbol}.')


def _format_iso_utc(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    try:
        t = float(ts)
        if t > 1e11:
            t = t / 1000.0
        return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))
    except Exception:
        return None


def _normalize_broker_position(raw: dict, default_mode: str, instrument_hint: str = 'binary') -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    pos_id = raw.get('id') or raw.get('external_id') or raw.get('order_id') or raw.get('position_id')
    if pos_id is None:
        return None
    raw_event = raw.get('raw_event') if isinstance(raw.get('raw_event'), dict) else {}
    symbol = str(
        raw.get('active')
        or raw.get('instrument_underlying')
        or raw_event.get('active')
        or raw.get('symbol')
        or 'UNKNOWN'
    ).strip().upper()
    raw_dir = str(
        raw.get('direction')
        or raw_event.get('direction')
        or raw.get('side')
        or 'CALL'
    ).strip().upper()
    side = 'BUY' if raw_dir in ('CALL', 'BUY') else 'SELL'
    stake = _parse_finite_float(
        raw.get('invest')
        if raw.get('invest') is not None
        else (raw.get('amount') if raw.get('amount') is not None else raw.get('volume'))
    ) or 0.0
    open_price = _parse_finite_float(
        raw.get('open_quote')
        if raw.get('open_quote') is not None
        else (raw.get('openPrice') if raw.get('openPrice') is not None else raw_event.get('value'))
    ) or 0.0
    curr_price = _parse_finite_float(
        raw.get('current_quote')
        if raw.get('current_quote') is not None
        else raw.get('currentPrice')
    )
    pnl = _parse_finite_float(
        raw.get('pnl_realized')
        if raw.get('pnl_realized') is not None
        else (raw.get('pnl') if raw.get('pnl') is not None else raw.get('profit'))
    )
    opened_at = raw.get('openedAt') or _format_iso_utc(_parse_finite_float(raw.get('open_time') or raw.get('created')))
    expires_at = raw.get('expiresAt') or _format_iso_utc(_parse_finite_float(raw.get('close_time') or raw.get('expired')))
    return {
        'ticket': str(pos_id),
        'symbol': symbol,
        'side': side,
        'volume': stake,
        'openPrice': open_price,
        'currentPrice': curr_price,
        'profit': pnl,
        'sl': None,
        'tp': None,
        'openedAt': opened_at,
        'expiresAt': expires_at,
        'instrumentType': str(raw.get('instrument_type') or raw.get('instrumentType') or instrument_hint),
        'mode': str(raw.get('mode') or default_mode).upper(),
        'canClose': True,
        'comment': f"IQ Option {str(raw.get('instrumentType') or instrument_hint).upper()} ({default_mode})",
    }


def _check_order_outcome_safe(client: Any, order_id: str, tracked: Optional[dict] = None) -> dict:
    """Inspect IQ Option order status / win-loss outcome with bounded non-blocking timeout."""
    now_iso = _format_iso_utc(time.time()) or ''
    instrument_type = (tracked or {}).get('instrumentType', 'binary')
    numeric_id: Any = int(order_id) if str(order_id).isdigit() else order_id

    # 1. Try digital position settlement check
    if instrument_type == 'digital' and hasattr(client, 'check_win_digital_v2'):
        try:
            res = _run_with_timeout(lambda: client.check_win_digital_v2(numeric_id), 2.5, 'check_win_digital_v2')
            if isinstance(res, (list, tuple)) and len(res) >= 2 and res[0]:
                pnl = _parse_finite_float(res[1])
                return {
                    'found': True,
                    'brokerOrderId': str(order_id),
                    'status': 'CLOSED',
                    'filledPrice': (tracked or {}).get('filledPrice'),
                    'realizedPnl': pnl,
                    'updatedAt': now_iso,
                    'note': f'IQ Option digital trade settled (P&L: {pnl}).',
                }
        except Exception:
            pass

    # 2. Try binary/turbo async order or optioninfo_v2 lookup (non-blocking — avoids check_win_v3 infinite wait!)
    if hasattr(client, 'get_async_order'):
        try:
            info = _run_with_timeout(lambda: client.get_async_order(numeric_id), 2.5, 'get_async_order')
            if isinstance(info, dict):
                pos_changed = info.get('position-changed') or info.get('option-closed')
                if isinstance(pos_changed, dict):
                    msg = pos_changed.get('msg') if isinstance(pos_changed.get('msg'), dict) else pos_changed
                    status_raw = str(msg.get('status') or '').lower()
                    pnl = _parse_finite_float(msg.get('pnl_realized') if msg.get('pnl_realized') is not None else msg.get('pnl'))
                    close_profit = _parse_finite_float(msg.get('close_profit'))
                    invest = _parse_finite_float(msg.get('invest')) or _parse_finite_float((tracked or {}).get('amount'))
                    if pnl is None and close_profit is not None and invest is not None:
                        pnl = round(close_profit - invest, 4)
                    open_quote = _parse_finite_float(msg.get('open_quote')) or (tracked or {}).get('filledPrice')
                    if status_raw == 'closed' or 'option-closed' in info or msg.get('close_time'):
                        return {
                            'found': True,
                            'brokerOrderId': str(order_id),
                            'status': 'CLOSED',
                            'filledPrice': open_quote,
                            'realizedPnl': pnl,
                            'updatedAt': now_iso,
                            'note': f'IQ Option trade settled (P&L: {pnl}).',
                        }
                    return {
                        'found': True,
                        'brokerOrderId': str(order_id),
                        'status': 'FILLED',
                        'filledPrice': open_quote,
                        'realizedPnl': pnl,
                        'updatedAt': now_iso,
                        'note': 'IQ Option trade currently open.',
                    }
        except Exception:
            pass

    if hasattr(client, 'get_optioninfo_v2'):
        try:
            hist = _run_with_timeout(lambda: client.get_optioninfo_v2(25), 3.0, 'get_optioninfo_v2_reconcile')
            closed_list = hist.get('msg', {}).get('closed_options', []) if isinstance(hist, dict) else []
            for item in closed_list:
                if not isinstance(item, dict):
                    continue
                item_ids = {str(item.get('id')), str(item.get('external_id'))}
                if str(order_id) in item_ids:
                    win_amount = _parse_finite_float(item.get('win_amount'))
                    invest = _parse_finite_float(item.get('amount')) or _parse_finite_float((tracked or {}).get('amount')) or 0.0
                    pnl = _parse_finite_float(item.get('pnl'))
                    if pnl is None and win_amount is not None:
                        pnl = round(win_amount - invest, 4)
                    return {
                        'found': True,
                        'brokerOrderId': str(order_id),
                        'status': 'CLOSED',
                        'filledPrice': _parse_finite_float(item.get('value')) or (tracked or {}).get('filledPrice'),
                        'realizedPnl': pnl,
                        'updatedAt': now_iso,
                        'note': f"IQ Option closed history match ({item.get('win') or 'settled'}).",
                    }
        except Exception:
            pass

    if tracked is not None:
        return {
            'found': True,
            'brokerOrderId': str(order_id),
            'status': tracked.get('status', 'FILLED'),
            'filledPrice': tracked.get('filledPrice'),
            'realizedPnl': tracked.get('realizedPnl'),
            'updatedAt': now_iso,
            'note': tracked.get('note') or 'Tracked active IQ Option order.',
        }

    return {
        'found': False,
        'brokerOrderId': str(order_id),
        'status': 'UNKNOWN',
        'filledPrice': None,
        'realizedPnl': None,
        'updatedAt': now_iso,
        'note': f'Order {order_id} not found on current IQ Option session.',
    }


def _normalize_history_item(item: Any, default_mode: str) -> Optional[dict]:
    if not isinstance(item, dict):
        return None
    item_id = item.get('id') or item.get('external_id') or item.get('order_id')
    symbol = str(item.get('active') or item.get('symbol') or item.get('instrument_underlying') or 'UNKNOWN').strip().upper()
    raw_dir = str(item.get('direction') or item.get('side') or '').strip().upper()
    direction = 'CALL' if raw_dir in ('CALL', 'BUY') else ('PUT' if raw_dir in ('PUT', 'SELL') else raw_dir or 'CALL')
    amount = _parse_finite_float(item.get('amount') if item.get('amount') is not None else item.get('invest'))
    win_amount = _parse_finite_float(item.get('win_amount'))
    pnl = _parse_finite_float(item.get('pnl') if item.get('pnl') is not None else item.get('pnl_realized'))
    if pnl is None and win_amount is not None and amount is not None:
        pnl = round(win_amount - amount, 4)
    outcome = str(item.get('win') or item.get('status') or ('win' if (pnl or 0) > 0 else 'loose' if (pnl or 0) < 0 else 'closed')).upper()
    return {
        'id': str(item_id) if item_id is not None else None,
        'symbol': symbol,
        'direction': direction,
        'amount': amount,
        'winAmount': win_amount,
        'pnl': pnl,
        'outcome': outcome,
        'openPrice': _parse_finite_float(item.get('value') if item.get('value') is not None else item.get('open_quote')),
        'closePrice': _parse_finite_float(item.get('close_value') if item.get('close_value') is not None else item.get('close_quote')),
        'openedAt': item.get('openedAt') or _format_iso_utc(_parse_finite_float(item.get('created') or item.get('open_time'))),
        'closedAt': item.get('closedAt') or _format_iso_utc(_parse_finite_float(item.get('expired') or item.get('close_time'))),
        'mode': str(item.get('mode') or default_mode).upper(),
    }


@app.get('/health')
async def health(
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
):
    """Non-blocking event-loop health endpoint; reports IQ Option's live detected active mode without mutating state."""
    target_mode = _resolve_target_mode(x_iq_mode=x_iq_mode, query_mode=mode)
    connected = False
    confirmed_mode = 'UNVERIFIED'
    mode_verified = False
    lock_busy = False
    connect_in_flight = _inflight_connect is not None

    acquired = _lock.acquire(blocking=False)
    if acquired:
        try:
            cur_client = _client
            if cur_client is not None:
                connected = _is_client_alive(cur_client)
                if connected:
                    confirmed_mode, mode_verified = _peek_balance_mode_nonblocking(cur_client, 'AUTO')
        finally:
            _lock.release()
    else:
        lock_busy = True
        cur_client = _client
        connected = _is_client_alive(cur_client)
        confirmed_mode = _confirmed_mode if connected else 'UNVERIFIED'
        mode_verified = bool(_mode_verified) if connected else False

    busy = bool(lock_busy or connect_in_flight)
    active_op = 'connect' if connect_in_flight else (_busy_operation if lock_busy else None)

    proxy_config_error: Optional[str] = None
    try:
        proxy_configured = bool(_get_proxy_url())
    except ValueError as exc:
        proxy_configured = False
        proxy_config_error = _sanitize_error(str(exc))

    mode_matches = True if target_mode == 'AUTO' else (confirmed_mode == target_mode)
    verified_connected = connected and mode_verified and mode_matches

    return {
        'status': 'running',
        'version': getattr(app, 'version', '0.5.3'),
        'serviceAvailable': True,
        'busy': busy,
        'connectInFlight': connect_in_flight,
        'busyOperation': active_op,
        'sessionGeneration': _session_generation,
        'lastConnectStage': _last_connect_stage,
        'lastConnectDurationMs': _last_connect_duration_ms,
        'authenticated': bool(connected),
        'connected': verified_connected,
        'mode': confirmed_mode if connected else None,
        'activeMode': confirmed_mode if connected else None,
        'requestedMode': target_mode,
        'accountType': confirmed_mode if connected else None,
        'modeVerified': mode_verified if connected else False,
        'brokerWalletConfirmed': bool(_broker_wallet_confirmed) if connected else False,
        'modeFollowsBroker': True,
        'modeDetection': _mode_detection_diag if connected else None,
        'activeWsUrl': _active_ws_url if connected else None,
        'activeWsViaProxy': _active_ws_via_proxy if connected else False,
        'proxyConfigured': proxy_configured,
        'proxyConfigError': proxy_config_error,
        'wsProxyMode': _get_ws_proxy_mode(),
        'wsProxyEnabled': _is_ws_proxy_enabled(),
        'candleRetrievalReady': bool(verified_connected),
        'lastCandleCheck': _last_candle_check,
        'orderExecutionSupported': True,
        'positionsSupported': True,
        'closePositionSupported': True,
        'realTradingEnabled': bool(connected and mode_verified and _broker_wallet_confirmed and confirmed_mode == 'REAL'),
        'credentialsConfigured': bool(os.getenv('IQ_EMAIL') and os.getenv('IQ_PASSWORD')),
        'lastError': _last_error,
        'connectedAt': _connected_at,
    }


@app.get('/network-check')
async def network_check(
    x_connector_token: Optional[str] = Header(default=None),
):
    """Secure, read-only DNS/TCP/TLS/WebSocket/Proxy diagnostic probe (never exposes credentials or modifies session)."""
    _check_auth(x_connector_token)
    ws_urls = _get_ws_candidates()
    ws_probes = await asyncio.gather(
        *(asyncio.to_thread(_probe_ws_endpoint, url, _WS_CONNECT_TIMEOUT, True) for url in ws_urls)
    )
    auth_probe = await asyncio.to_thread(_probe_https_endpoint, 'https://auth.iqoption.com', _WS_CONNECT_TIMEOUT)

    proxy_probe: Optional[dict] = None
    proxy_ws_probes: List[dict] = []
    proxy_configured = False
    proxy_config_error: Optional[str] = None
    try:
        proxy_url = _get_proxy_url()
        if proxy_url:
            proxy_configured = True
            proxy_probe, *proxy_ws_probes = await asyncio.gather(
                asyncio.to_thread(_probe_https_via_proxy, 'https://auth.iqoption.com', proxy_url, _HTTP_CONNECT_TIMEOUT),
                *(asyncio.to_thread(_probe_ws_via_proxy, url, proxy_url, _WS_CONNECT_TIMEOUT) for url in ws_urls),
            )
    except ValueError as exc:
        proxy_config_error = _sanitize_error(str(exc))
        proxy_probe = {
            'proxy': None,
            'target': 'auth.iqoption.com:443',
            'viaProxy': True,
            'ok': False,
            'stage': 'config',
            'error': proxy_config_error,
        }

    proxy_auth_verified = bool(proxy_probe and proxy_probe.get('ok'))
    proxy_ws_verified = any(bool(p.get('ok')) for p in proxy_ws_probes)
    alive_now = _is_client_alive(_client)

    return {
        'status': 'ok',
        'version': getattr(app, 'version', '0.5.3'),
        'serviceAvailable': True,
        'timeoutSeconds': _WS_CONNECT_TIMEOUT,
        'activeWsUrl': _active_ws_url,
        'activeWsViaProxy': _active_ws_via_proxy,
        'proxyConfigured': proxy_configured,
        'proxyConfigError': proxy_config_error,
        'proxyConnectivityVerified': proxy_auth_verified,
        'wsProxyMode': _get_ws_proxy_mode(),
        'wsProxyEnabled': _is_ws_proxy_enabled(),
        'wsProxyConnectivityVerified': proxy_ws_verified,
        'direct': {
            'wsEndpoints': ws_probes,
            'authEndpoint': auth_probe,
        },
        'proxied': {
            'configured': proxy_configured,
            'verified': proxy_auth_verified,
            'wsVerified': proxy_ws_verified,
            'authEndpoint': proxy_probe,
            'wsEndpoints': proxy_ws_probes,
        },
        'brokerSession': {
            'authenticated': alive_now,
            'connected': alive_now and _mode_verified,
            'connectInFlight': _inflight_connect is not None,
            'busyOperation': 'connect' if _inflight_connect is not None else _busy_operation,
            'sessionGeneration': _session_generation,
            'lastConnectStage': _last_connect_stage,
            'lastConnectDurationMs': _last_connect_duration_ms,
            'mode': _confirmed_mode if alive_now else None,
            'modeVerified': bool(_mode_verified) if alive_now else False,
            'brokerWalletConfirmed': bool(_broker_wallet_confirmed) if alive_now else False,
            'modeFollowsBroker': True,
            'modeDetection': _mode_detection_diag if alive_now else None,
            'candleRetrievalReady': bool(alive_now and _mode_verified),
            'lastCandleCheck': _last_candle_check,
            'lastError': _last_error,
        },
        'wsEndpoints': ws_probes,
        'authEndpoint': auth_probe,
        'proxyAuthEndpoint': proxy_probe,
        'proxyWsEndpoints': proxy_ws_probes,
        'lastConnectDiagnostics': _last_ws_diagnostics,
        'orderExecutionSupported': True,
        'realTradingEnabled': bool(alive_now and _mode_verified and _broker_wallet_confirmed and _confirmed_mode == 'REAL'),
    }


@app.post('/connect')
def connect_route(
    body: Optional[ConnectBody] = None,
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    client = connect(
        email=body.email if body else None,
        password=body.password if body else None,
        target_mode='AUTO',
    )
    with _bounded_lock(op_name='connect_verify'):
        is_connected = _is_client_alive(client)
        confirmed_mode, mode_verified = _detect_balance_mode(client, refresh=True)
        reported_mode = confirmed_mode if (is_connected and mode_verified) else ('UNVERIFIED' if is_connected else None)
        return {
            'authenticated': is_connected,
            'connected': is_connected and mode_verified,
            'mode': reported_mode,
            'activeMode': reported_mode,
            'requestedMode': _resolve_target_mode(
                explicit_mode=body.mode if body else None,
                x_iq_mode=x_iq_mode,
                query_mode=mode,
            ),
            'accountType': reported_mode,
            'modeVerified': mode_verified if is_connected else False,
            'brokerWalletConfirmed': bool(_broker_wallet_confirmed) if is_connected else False,
            'modeFollowsBroker': True,
            'modeDetection': _mode_detection_diag if is_connected else None,
            'orderExecutionSupported': True,
            'positionsSupported': True,
            'closePositionSupported': True,
            'realTradingEnabled': bool(is_connected and mode_verified and _broker_wallet_confirmed and confirmed_mode == 'REAL'),
            'detail': None if (is_connected and mode_verified) else _last_error,
            'connectedAt': _connected_at,
        }


@app.get('/account')
def account(
    fresh: bool = Query(default=False),
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='account'):
        confirmed_mode, mode_verified = _require_verified_mode(client, 'AUTO', refresh=fresh)
        balance_val, currency = _fetch_balance_safe(client, confirmed_mode, allow_cache=not fresh)
        return {
            'connected': True,
            'mode': confirmed_mode,
            'activeMode': confirmed_mode,
            'accountType': confirmed_mode,
            'modeVerified': mode_verified,
            'brokerWalletConfirmed': bool(_broker_wallet_confirmed),
            'modeFollowsBroker': True,
            'balance': balance_val,
            'currency': currency,
            'orderExecutionSupported': True,
            'positionsSupported': True,
            'closePositionSupported': True,
            'realTradingEnabled': bool(confirmed_mode == 'REAL' and _broker_wallet_confirmed),
            'source': 'IQ_OPTION_UNOFFICIAL',
        }


@app.get('/balance')
def balance(
    fresh: bool = Query(default=False),
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='balance'):
        confirmed_mode, mode_verified = _require_verified_mode(client, 'AUTO', refresh=fresh)
        balance_val, currency = _fetch_balance_safe(client, confirmed_mode, allow_cache=not fresh)
        return {
            'balance': balance_val,
            'currency': currency,
            'mode': confirmed_mode,
            'activeMode': confirmed_mode,
            'accountType': confirmed_mode,
            'modeVerified': mode_verified,
            'brokerWalletConfirmed': bool(_broker_wallet_confirmed),
            'modeFollowsBroker': True,
            'orderExecutionSupported': True,
            'realTradingEnabled': bool(confirmed_mode == 'REAL' and _broker_wallet_confirmed),
            'source': 'IQ_OPTION_UNOFFICIAL',
        }


@app.get('/assets')
def assets(x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='assets'):
        try:
            open_time = _run_with_timeout(client.get_all_open_time, _ASSETS_TIMEOUT, 'get_all_open_time')
            available = []
            if isinstance(open_time, dict):
                for category in ('binary', 'turbo', 'digital', 'forex', 'crypto'):
                    bucket = open_time.get(category)
                    if isinstance(bucket, dict):
                        for symbol, info in bucket.items():
                            is_open = bool(info.get('open')) if isinstance(info, dict) else False
                            if is_open:
                                available.append({'symbol': symbol, 'category': category, 'open': True})
            return {'assets': available[:200], 'count': len(available), 'source': 'IQ_OPTION_UNOFFICIAL'}
        except TimeoutError:
            raise HTTPException(504, 'IQ Option upstream timed out retrieving open assets.') from None
        except Exception as exc:
            raise HTTPException(502, f'Failed to retrieve open assets ({type(exc).__name__}).') from None


@app.get('/price/{symbol}')
def latest_price(
    symbol: str,
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    clean = symbol.strip().upper().replace('/', '')
    if not clean or len(clean) < 3 or len(clean) > 25:
        raise HTTPException(400, 'Invalid symbol format.')
    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='price'):
        confirmed_mode, _ = _require_verified_mode(client, 'AUTO', refresh=False)
        rows = _fetch_candles_safe(client, clean, 60, 2, confirmed_mode)
        if not isinstance(rows, list) or len(rows) == 0:
            raise HTTPException(502, f'Broker did not return valid candle price for {clean}.')
        normalized = [b for b in (_normalize_candle_bar(r) for r in rows) if b is not None]
        if not normalized:
            raise HTTPException(502, f'Broker candles for {clean} contained invalid OHLCV or timestamp values.')
        bar = normalized[-1]
        return {
            'symbol': clean,
            'bid': None,
            'ask': None,
            'last': bar['close'],
            'spread': None,
            'time': bar['time'],
            'mode': confirmed_mode,
            'brokerWalletConfirmed': bool(_broker_wallet_confirmed),
            'orderExecutionSupported': True,
            'realTradingEnabled': bool(confirmed_mode == 'REAL' and _broker_wallet_confirmed),
            'source': 'IQ_OPTION_UNOFFICIAL',
            'note': f'Live 1m reference price from IQ Option ({confirmed_mode}).',
        }


@app.post('/candles')
def candles(
    query: CandlesQuery,
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    global _last_candle_check
    _check_auth(x_connector_token)
    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='candles'):
        confirmed_mode, _ = _require_verified_mode(client, 'AUTO', refresh=False)
        rows = _fetch_candles_safe(client, query.symbol, query.interval, query.count, confirmed_mode)
        normalized = [b for b in (_normalize_candle_bar(c) for c in rows) if b is not None]
        if not normalized:
            _last_candle_check = {
                'ok': False,
                'symbol': query.symbol,
                'count': 0,
                'checkedAt': time.time(),
                'error': f'Broker returned no valid candles for {query.symbol}.',
            }
            raise HTTPException(502, f'Broker returned no valid candles for {query.symbol}.')
        _last_candle_check = {
            'ok': True,
            'symbol': query.symbol,
            'count': len(normalized),
            'checkedAt': time.time(),
            'error': None,
        }
        return {
            'symbol': query.symbol,
            'interval': query.interval,
            'candles': normalized,
            'mode': confirmed_mode,
            'brokerWalletConfirmed': bool(_broker_wallet_confirmed),
            'orderExecutionSupported': True,
            'realTradingEnabled': bool(confirmed_mode == 'REAL' and _broker_wallet_confirmed),
            'source': 'IQ_OPTION_UNOFFICIAL',
            'note': f'Live candles from IQ Option ({confirmed_mode}).',
        }


@app.post('/order')
def place_order(
    req: OrderRequest,
    x_connector_token: Optional[str] = Header(default=None),
):
    """Execute an IQ Option trade strictly on the live active account mode verified directly from IQ Option.
    Never silently changes the user's IQ Option account mode.
    """
    _check_auth(x_connector_token)
    expected_mode = _normalize_mode(req.expectedMode) if req.expectedMode else 'AUTO'

    # Idempotency check
    if req.idempotencyKey:
        with _state_lock:
            existing_id = _idempotency_index.get(req.idempotencyKey)
            existing = _tracked_orders.get(existing_id) if existing_id else None
        if existing:
            return {
                'accepted': True,
                'duplicatePrevented': True,
                'brokerOrderId': existing['brokerOrderId'],
                'status': existing['status'],
                'mappedSymbol': existing['symbol'],
                'direction': existing['direction'],
                'amount': existing['amount'],
                'expirySeconds': existing['expirySeconds'],
                'instrumentType': existing['instrumentType'],
                'mode': existing['mode'],
                'accountType': existing['mode'],
                'modeVerified': True,
                'filledPrice': existing.get('filledPrice'),
                'message': 'Duplicate order prevented via idempotency key.',
                'submittedAt': existing['submittedAt'],
            }

    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='place_order'):
        # Mandatory fresh live mode verification before every single order (never silently calls change_balance)
        confirmed_mode, mode_verified = _require_verified_mode(client, expected_mode, refresh=True)

        # HARD SAFETY INVARIANT: NEVER submit a real-money (REAL) order unless IQ Option explicitly confirmed
        # that the user's active wallet is REAL (_broker_wallet_confirmed == True).
        if (confirmed_mode == 'REAL' or expected_mode == 'REAL') and not _broker_wallet_confirmed:
            raise HTTPException(
                409,
                'Real-money order blocked: IQ Option did not confirm an active REAL wallet (active wallet unconfirmed).',
            )

        # Strict pre-buy wallet-mode cross-check: guarantee iqoptionapi's bound balance_id matches confirmed_mode
        if getattr(client, 'api', None) is not None:
            bal_list = _get_balances_list(client, refresh=False)
            bound_id = _active_balance_id
            try:
                import iqoptionapi.global_value as global_value
                gv_id = _coerce_balance_id(getattr(global_value, 'balance_id', None))
            except Exception:
                gv_id = bound_id
            if bound_id is None or gv_id is None or str(gv_id) != str(bound_id):
                raise HTTPException(
                    409,
                    'IQ Option active balance_id is unverified or mismatched with detected account mode; order blocked.',
                )
            resolved_mode, _rbid, _rcurr = _resolve_mode_from_balances(bal_list, bound_id)
            if resolved_mode != confirmed_mode:
                raise HTTPException(
                    409,
                    f'IQ Option wallet verification mismatch (bound wallet resolves to {resolved_mode}, expected {confirmed_mode}); order blocked.',
                )
            if not _broker_wallet_confirmed and resolved_mode != 'PRACTICE':
                raise HTTPException(
                    409,
                    'Real-money order blocked: bound wallet is not PRACTICE while broker active wallet is unconfirmed.',
                )

        action = 'call' if req.direction == 'CALL' else 'put'
        duration_min = max(1, int(round(req.expirySeconds / 60.0)))
        clean_symbol = req.symbol

        # Fetch latest reference entry price (non-fatal if unavailable)
        ref_price: Optional[float] = None
        try:
            rows = _fetch_candles_safe(client, clean_symbol, 60, 2, confirmed_mode, timeout_seconds=3.0)
            norm = [b for b in (_normalize_candle_bar(r) for r in rows) if b is not None]
            if norm:
                ref_price = norm[-1]['close']
        except Exception:
            ref_price = None

        order_id: Any = None
        used_instrument = 'binary'
        last_reason: Optional[str] = None

        # FINAL PRE-SUBMISSION INVARIANT (immediately before client.buy / client.buy_digital_spot):
        # Re-verify no real-money order can ever be submitted when active broker wallet is unconfirmed.
        if (confirmed_mode == 'REAL' or expected_mode == 'REAL') and not _broker_wallet_confirmed:
            raise HTTPException(
                409,
                'Real-money order blocked immediately before submission: active REAL wallet is unconfirmed.',
            )
        if getattr(client, 'api', None) is not None:
            try:
                import iqoptionapi.global_value as _gv_final
                final_gv_id = _coerce_balance_id(getattr(_gv_final, 'balance_id', None))
            except Exception:
                final_gv_id = _active_balance_id
            final_mode, _, _ = _resolve_mode_from_balances(
                _get_balances_list(client, refresh=False),
                final_gv_id,
            )
            if final_gv_id is None or str(final_gv_id) != str(_active_balance_id) or final_mode != confirmed_mode:
                raise HTTPException(
                    409,
                    'Order blocked immediately before submission: bound wallet changed or mismatched verified mode.',
                )
            if not _broker_wallet_confirmed and final_mode != 'PRACTICE':
                raise HTTPException(
                    409,
                    'Real-money order blocked immediately before submission: bound wallet is not PRACTICE while broker wallet is unconfirmed.',
                )

        try:
            if req.instrumentType in ('auto', 'binary') and hasattr(client, 'buy'):
                res = _run_with_timeout(
                    lambda: client.buy(float(req.amount), clean_symbol, action, duration_min),
                    _ORDER_TIMEOUT,
                    f'buy_{clean_symbol}',
                )
                if isinstance(res, (list, tuple)) and len(res) >= 2 and res[0]:
                    order_id = res[1]
                    used_instrument = 'binary'
                else:
                    last_reason = str(res[1]) if isinstance(res, (list, tuple)) and len(res) >= 2 else str(res)

            if order_id is None and req.instrumentType in ('auto', 'digital') and hasattr(client, 'buy_digital_spot'):
                res_dig = _run_with_timeout(
                    lambda: client.buy_digital_spot(clean_symbol, float(req.amount), action, duration_min),
                    _ORDER_TIMEOUT,
                    f'buy_digital_{clean_symbol}',
                )
                if isinstance(res_dig, (list, tuple)) and len(res_dig) >= 2 and res_dig[0]:
                    order_id = res_dig[1]
                    used_instrument = 'digital'
                elif not last_reason:
                    last_reason = str(res_dig[1]) if isinstance(res_dig, (list, tuple)) and len(res_dig) >= 2 else str(res_dig)
        except TimeoutError:
            raise HTTPException(504, f'IQ Option timed out placing {req.direction} order on {clean_symbol}.') from None
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, _sanitize_error(f'IQ Option order placement failed ({type(exc).__name__}): {exc}')) from None

        if order_id is None:
            raise HTTPException(
                409,
                _sanitize_error(
                    f'IQ Option rejected {req.direction} {clean_symbol} ({confirmed_mode}): {last_reason or "asset may be closed or payout unavailable."}'
                ),
            )

        now_ts = time.time()
        submitted_at = _format_iso_utc(now_ts) or ''
        expires_at = _format_iso_utc(now_ts + duration_min * 60)
        broker_order_id = str(order_id)

        record = {
            'brokerOrderId': broker_order_id,
            'symbol': clean_symbol,
            'direction': req.direction,
            'side': 'BUY' if req.direction == 'CALL' else 'SELL',
            'amount': float(req.amount),
            'expirySeconds': duration_min * 60,
            'instrumentType': used_instrument,
            'mode': confirmed_mode,
            'filledPrice': ref_price,
            'realizedPnl': None,
            'status': 'FILLED',
            'submittedAt': submitted_at,
            'openedAt': submitted_at,
            'expiresAt': expires_at,
            'expiresAtEpoch': now_ts + duration_min * 60,
            'note': f'Opened {req.direction} {clean_symbol} (${req.amount:.2f}, {duration_min}m {used_instrument}) on verified IQ Option {confirmed_mode} account.',
        }
        with _state_lock:
            _tracked_orders[broker_order_id] = record
            if req.idempotencyKey:
                _idempotency_index[req.idempotencyKey] = broker_order_id
        _invalidate_balance_cache()

        return {
            'accepted': True,
            'brokerOrderId': broker_order_id,
            'status': 'FILLED',
            'mappedSymbol': clean_symbol,
            'direction': req.direction,
            'amount': float(req.amount),
            'expirySeconds': duration_min * 60,
            'instrumentType': used_instrument,
            'mode': confirmed_mode,
            'accountType': confirmed_mode,
            'modeVerified': mode_verified,
            'filledPrice': ref_price,
            'filledUnits': float(req.amount),
            'rawStatus': 'OPEN',
            'message': record['note'],
            'submittedAt': submitted_at,
        }


@app.get('/positions')
def positions(x_connector_token: Optional[str] = Header(default=None)):
    """Retrieve active open IQ Option trades/positions on the verified active account."""
    _check_auth(x_connector_token)
    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='positions'):
        confirmed_mode, _ = _require_verified_mode(client, 'AUTO', refresh=False)
        open_positions: Dict[str, dict] = {}

        # 1. Poll broker open positions where iqoptionapi exposes them
        if hasattr(client, 'get_positions'):
            for inst in ('turbo-option', 'binary-option', 'digital-option'):
                try:
                    res = _run_with_timeout(lambda i=inst: client.get_positions(i), 2.5, f'get_positions_{inst}')
                    raw_list = None
                    if isinstance(res, (list, tuple)) and len(res) >= 2 and res[0] and isinstance(res[1], dict):
                        raw_list = res[1].get('positions') or res[1].get('msg', {}).get('positions')
                    elif isinstance(res, dict):
                        raw_list = res.get('positions')
                    elif isinstance(res, list):
                        raw_list = res
                    if isinstance(raw_list, list):
                        for item in raw_list:
                            if isinstance(item, dict) and str(item.get('status') or 'open').lower() in ('open', 'active', ''):
                                norm = _normalize_broker_position(item, confirmed_mode, 'digital' if 'digital' in inst else 'binary')
                                if norm:
                                    open_positions[norm['ticket']] = norm
                except Exception:
                    continue

        # 2. Merge still-active tracked orders and auto-reconcile any expired tracked orders
        now_ts = time.time()
        with _state_lock:
            tracked_snapshot = list(_tracked_orders.values())
        for rec in tracked_snapshot:
            if rec.get('status') in ('CLOSED', 'CANCELLED', 'REJECTED'):
                continue
            oid = rec['brokerOrderId']
            if now_ts >= float(rec.get('expiresAtEpoch', 0)):
                outcome = _check_order_outcome_safe(client, oid, rec)
                if outcome.get('status') == 'CLOSED':
                    with _state_lock:
                        if oid in _tracked_orders:
                            _tracked_orders[oid]['status'] = 'CLOSED'
                            _tracked_orders[oid]['realizedPnl'] = outcome.get('realizedPnl')
                            _tracked_orders[oid]['note'] = outcome.get('note')
                    _invalidate_balance_cache()
                    continue
            if oid not in open_positions and rec.get('mode') == confirmed_mode:
                open_positions[oid] = {
                    'ticket': oid,
                    'symbol': rec['symbol'],
                    'side': rec['side'],
                    'volume': rec['amount'],
                    'openPrice': rec.get('filledPrice') or 0.0,
                    'currentPrice': None,
                    'profit': rec.get('realizedPnl'),
                    'sl': None,
                    'tp': None,
                    'openedAt': rec.get('openedAt'),
                    'expiresAt': rec.get('expiresAt'),
                    'instrumentType': rec.get('instrumentType', 'binary'),
                    'mode': confirmed_mode,
                    'canClose': True,
                    'comment': rec.get('note'),
                }

        pos_list = list(open_positions.values())
        return {
            'supported': True,
            'mode': confirmed_mode,
            'accountType': confirmed_mode,
            'positions': pos_list,
            'count': len(pos_list),
            'source': 'IQ_OPTION_UNOFFICIAL',
            'note': f'Active IQ Option trades ({confirmed_mode}).',
        }


@app.get('/orders/{order_id}')
def order_status(
    order_id: str,
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='order_status'):
        confirmed_mode, _ = _require_verified_mode(client, 'AUTO', refresh=False)
        with _state_lock:
            tracked = _tracked_orders.get(str(order_id))
        outcome = _check_order_outcome_safe(client, str(order_id), tracked)
        if outcome.get('status') == 'CLOSED' and tracked is not None:
            with _state_lock:
                if str(order_id) in _tracked_orders:
                    _tracked_orders[str(order_id)]['status'] = 'CLOSED'
                    _tracked_orders[str(order_id)]['realizedPnl'] = outcome.get('realizedPnl')
                    _tracked_orders[str(order_id)]['note'] = outcome.get('note')
            _invalidate_balance_cache()
        outcome['mode'] = confirmed_mode
        return outcome


@app.post('/positions/{order_id}/close')
@app.post('/orders/{order_id}/close')
def close_position(
    order_id: str,
    x_connector_token: Optional[str] = Header(default=None),
):
    """Close / sell back an open IQ Option trade where supported by the broker API."""
    _check_auth(x_connector_token)
    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='close_position'):
        confirmed_mode, _ = _require_verified_mode(client, 'AUTO', refresh=True)
        with _state_lock:
            tracked = _tracked_orders.get(str(order_id))
        instrument_type = (tracked or {}).get('instrumentType', 'binary')
        numeric_id: Any = int(order_id) if str(order_id).isdigit() else order_id

        closed = False
        message = ''
        try:
            if instrument_type == 'digital' and hasattr(client, 'close_digital_option'):
                res = _run_with_timeout(lambda: client.close_digital_option(numeric_id), _ORDER_TIMEOUT, 'close_digital_option')
                closed = bool(res is True or (isinstance(res, (list, tuple)) and res and res[0]))
                message = 'Digital option closed on IQ Option.' if closed else f'IQ Option could not close digital option {order_id}.'
            elif hasattr(client, 'sell_option'):
                res = _run_with_timeout(lambda: client.sell_option(numeric_id), _ORDER_TIMEOUT, 'sell_option')
                if isinstance(res, dict):
                    closed = bool(res.get('msg') or res.get('result') or res.get('status') == 'ok')
                elif isinstance(res, (list, tuple)):
                    closed = bool(res and res[0])
                else:
                    closed = bool(res)
                message = 'Trade sold/closed early on IQ Option.' if closed else f'IQ Option sell_option rejected early close for {order_id} (may be expired or outside sellback window).'
            else:
                raise HTTPException(501, 'Installed iqoptionapi package does not expose sell_option/close_digital_option.')
        except TimeoutError:
            raise HTTPException(504, f'IQ Option timed out closing position {order_id}.') from None
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, _sanitize_error(f'Failed to close IQ Option position {order_id} ({type(exc).__name__}): {exc}')) from None

        if closed:
            outcome = _check_order_outcome_safe(client, str(order_id), tracked)
            pnl = outcome.get('realizedPnl')
            with _state_lock:
                if str(order_id) in _tracked_orders:
                    _tracked_orders[str(order_id)]['status'] = 'CLOSED'
                    _tracked_orders[str(order_id)]['realizedPnl'] = pnl
                    _tracked_orders[str(order_id)]['note'] = message
            _invalidate_balance_cache()
            return {
                'closed': True,
                'brokerOrderId': str(order_id),
                'status': 'CLOSED',
                'realizedPnl': pnl,
                'mode': confirmed_mode,
                'accountType': confirmed_mode,
                'message': message,
                'closedAt': _format_iso_utc(time.time()),
            }

        raise HTTPException(409, message or f'Unable to close IQ Option position {order_id}.')


@app.get('/history')
def history(
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    client = connect(target_mode='AUTO')
    with _bounded_lock(op_name='history'):
        confirmed_mode, mode_verified = _require_verified_mode(client, 'AUTO', refresh=False)
        normalized_trades: List[dict] = []
        seen_ids = set()
        note = f'Synchronized closed trade history from IQ Option ({confirmed_mode}).'
        supported = False

        try:
            if hasattr(client, 'get_optioninfo_v2'):
                supported = True
                data = _run_with_timeout(lambda: client.get_optioninfo_v2(30), _HISTORY_TIMEOUT, 'get_optioninfo_v2')
                closed = data.get('msg', {}).get('closed_options', []) if isinstance(data, dict) else []
                for item in closed:
                    norm = _normalize_history_item(item, confirmed_mode)
                    if norm:
                        if norm.get('id'):
                            seen_ids.add(norm['id'])
                        normalized_trades.append(norm)
        except TimeoutError:
            note = 'IQ Option history retrieval timed out; returning cached session records.'
        except Exception as exc:
            note = _sanitize_error(f'IQ Option history retrieval warning ({type(exc).__name__}): {exc}')

        # Include any settled tracked orders from the active session not yet present in closed_options
        with _state_lock:
            for rec in _tracked_orders.values():
                if rec.get('status') == 'CLOSED' and rec['brokerOrderId'] not in seen_ids:
                    normalized_trades.insert(0, {
                        'id': rec['brokerOrderId'],
                        'symbol': rec['symbol'],
                        'direction': rec['direction'],
                        'amount': rec['amount'],
                        'winAmount': None,
                        'pnl': rec.get('realizedPnl'),
                        'outcome': 'WIN' if (rec.get('realizedPnl') or 0) > 0 else ('LOSS' if (rec.get('realizedPnl') or 0) < 0 else 'CLOSED'),
                        'openPrice': rec.get('filledPrice'),
                        'closePrice': None,
                        'openedAt': rec.get('openedAt'),
                        'closedAt': _format_iso_utc(time.time()),
                        'mode': rec.get('mode', confirmed_mode),
                    })
                    supported = True

        return {
            'supported': supported,
            'mode': confirmed_mode,
            'activeMode': confirmed_mode,
            'accountType': confirmed_mode,
            'modeVerified': mode_verified,
            'trades': normalized_trades,
            'note': note,
            'source': 'IQ_OPTION_UNOFFICIAL',
        }


@app.post('/disconnect')
def disconnect(x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    global _requested_mode, _confirmed_mode, _mode_verified, _broker_wallet_confirmed, _mode_detection_diag
    with _bounded_lock(op_name='disconnect'):
        _invalidate_client(cancel_inflight=True)
        _requested_mode = 'AUTO'
        _confirmed_mode = 'UNVERIFIED'
        _mode_verified = False
        _broker_wallet_confirmed = False
        _mode_detection_diag = None
    return {'connected': False}

