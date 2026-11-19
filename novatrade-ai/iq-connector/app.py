"""Experimental, self-hosted IQ Option read-only connector.
Credentials are read from local environment variables, never accepted over HTTP unless explicitly passed by NovaTrade server vault.
Supports read-only account/balance/market/history inspection in PRACTICE or REAL mode without placing orders.
Never silently switches REAL to PRACTICE or returns PRACTICE balances under a REAL label.
"""
import contextlib
import json
import logging
import os
import ssl
import threading
import time
from typing import Any, Callable, Optional, Tuple, TypeVar
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

app = FastAPI(title='NovaTrade IQ Option experimental connector', version='0.4.2')

_LOCK_ACQUIRE_TIMEOUT = float(os.environ.get('IQ_LOCK_TIMEOUT_SECONDS', '2.0'))
_CONNECT_TIMEOUT = float(os.environ.get('IQ_CONNECT_TIMEOUT_SECONDS', '12.0'))
_BALANCE_TIMEOUT = float(os.environ.get('IQ_BALANCE_TIMEOUT_SECONDS', '6.0'))
_CANDLES_TIMEOUT = float(os.environ.get('IQ_CANDLES_TIMEOUT_SECONDS', '7.0'))
_MODE_TIMEOUT = float(os.environ.get('IQ_MODE_TIMEOUT_SECONDS', '5.0'))
_HISTORY_TIMEOUT = float(os.environ.get('IQ_HISTORY_TIMEOUT_SECONDS', '6.0'))
_ASSETS_TIMEOUT = float(os.environ.get('IQ_ASSETS_TIMEOUT_SECONDS', '8.0'))
_CLOSE_TIMEOUT = 1.5
_HTTP_TIMEOUT = 10.0

_lock = threading.RLock()
_client: Any = None
_last_error: Optional[str] = None
_connected_at: Optional[float] = None
_requested_mode: str = 'PRACTICE'
_confirmed_mode: str = 'PRACTICE'
_mode_verified: bool = False
_opcodes_updated: bool = False
_iqoptionapi_patched: bool = False

T = TypeVar('T')


def _sanitize_error(msg: str, extra_secrets: Tuple[Optional[str], ...] = ()) -> str:
    cleaned = str(msg or '')
    secrets = [
        (os.environ.get('IQ_PASSWORD') or '').strip(),
        (os.environ.get('IQ_CONNECTOR_TOKEN') or '').strip(),
    ]
    for s in extra_secrets:
        if s and str(s).strip():
            secrets.append(str(s).strip())
    for secret in secrets:
        if secret and secret in cleaned:
            cleaned = cleaned.replace(secret, '***')
    return cleaned[:300]


@app.exception_handler(Exception)
async def _unhandled_exception_handler(_request: Request, exc: Exception):
    return JSONResponse(
        status_code=502,
        content={
            'detail': f'IQ Option connector internal error ({type(exc).__name__}).',
            'orderExecutionSupported': False,
            'realTradingEnabled': False,
        },
    )


@contextlib.contextmanager
def _bounded_lock(timeout: Optional[float] = None):
    wait = _LOCK_ACQUIRE_TIMEOUT if timeout is None else timeout
    acquired = _lock.acquire(timeout=wait)
    if not acquired:
        raise HTTPException(
            503,
            'IQ Option connector is busy with an upstream broker operation; please retry shortly.',
        )
    try:
        yield
    finally:
        _lock.release()


def _run_with_timeout(fn: Callable[[], T], timeout_seconds: float, op_name: str) -> T:
    """Execute a potentially blocking broker call on a daemon thread with a strict wall-clock cap."""
    result_box: dict = {}
    error_box: dict = {}

    def _target():
        try:
            result_box['value'] = fn()
        except BaseException as exc:
            error_box['error'] = exc

    worker = threading.Thread(target=_target, name=f'iq-op-{op_name}', daemon=True)
    worker.start()
    worker.join(timeout=timeout_seconds)
    if worker.is_alive():
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


def _safe_close_client(client: Any, timeout_seconds: Optional[float] = None):
    """Best-effort, strictly bounded teardown of an IQ Option client and its WebSocket thread."""
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
        try:
            import iqoptionapi.global_value as global_value
            global_value.check_websocket_if_connect = 0
            global_value.ssl_Mutual_exclusion = False
            global_value.ssl_Mutual_exclusion_write = False
        except Exception:
            pass


def _invalidate_client(reason: Optional[str] = None):
    global _client, _connected_at, _mode_verified, _opcodes_updated, _last_error
    old_client = _client
    _client = None
    _connected_at = None
    _mode_verified = False
    _opcodes_updated = False
    if reason:
        _last_error = _sanitize_error(reason)
    if old_client is not None:
        _safe_close_client(old_client)


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

    # 1. Ensure WebsocketClient.on_message ALWAYS releases ssl_Mutual_exclusion on any exception
    orig_on_message = WebsocketClient.on_message

    def _safe_on_message(self, message):
        try:
            return orig_on_message(self, message)
        finally:
            global_value.ssl_Mutual_exclusion = False

    WebsocketClient.on_message = _safe_on_message

    # 2. Enforce HTTP timeout default on IQOptionAPI.session.request
    orig_api_init = IQOptionAPI.__init__

    def _safe_api_init(self, *args, **kwargs):
        orig_api_init(self, *args, **kwargs)
        orig_request = self.session.request

        def _timed_request(*r_args, **r_kwargs):
            r_kwargs.setdefault('timeout', _HTTP_TIMEOUT)
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

    # 4. Bounded close() so websocket_thread.join() can NEVER hang forever
    def _safe_api_close(self):
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
        global_value.check_websocket_if_connect = 0
        global_value.ssl_Mutual_exclusion = False
        global_value.ssl_Mutual_exclusion_write = False

    IQOptionAPI.close = _safe_api_close

    # 5. Bounded start_websocket() wait
    def _safe_start_websocket(self):
        global_value.check_websocket_if_connect = None
        global_value.check_websocket_if_error = False
        global_value.websocket_error_reason = None

        self.websocket_client = WebsocketClient(self)
        self.websocket_thread = threading.Thread(
            target=self.websocket.run_forever,
            kwargs={'sslopt': {'check_hostname': False, 'cert_reqs': ssl.CERT_NONE, 'ca_certs': 'cacert.pem'}},
            daemon=True,
        )
        self.websocket_thread.start()
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            if global_value.check_websocket_if_error:
                return False, global_value.websocket_error_reason
            if global_value.check_websocket_if_connect == 0:
                return False, 'Websocket connection closed.'
            if global_value.check_websocket_if_connect == 1:
                return True, None
            time.sleep(0.02)
        self.close()
        return False, 'Timed out opening IQ Option WebSocket.'

    IQOptionAPI.start_websocket = _safe_start_websocket

    # 6. Bounded send_ssid() wait
    def _safe_send_ssid(self):
        self.profile.msg = None
        self.ssid(global_value.SSID)
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            if self.profile.msg is not None:
                return self.profile.msg is not False
            if global_value.check_websocket_if_connect == 0 or global_value.check_websocket_if_error:
                return False
            time.sleep(0.02)
        return False

    IQOptionAPI.send_ssid = _safe_send_ssid

    # 7. Bounded IQOptionAPI.connect() (no infinite timesync spin, no atexit leak)
    def _safe_api_connect(self):
        global_value.ssl_Mutual_exclusion = False
        global_value.ssl_Mutual_exclusion_write = False
        try:
            self.close()
        except Exception:
            pass
        check_ws, ws_reason = self.start_websocket()
        if not check_ws:
            return check_ws, ws_reason

        if global_value.SSID is not None:
            check_ssid = self.send_ssid()
            if not check_ssid:
                response = self.get_ssid()
                try:
                    global_value.SSID = response.cookies['ssid']
                except Exception:
                    self.close()
                    return False, getattr(response, 'text', str(response))
                check_ws2, ws_reason2 = self.start_websocket()
                if not check_ws2:
                    return False, ws_reason2
                if not self.send_ssid():
                    self.close()
                    return False, 'IQ Option SSID authentication timed out.'
        else:
            response = self.get_ssid()
            try:
                global_value.SSID = response.cookies['ssid']
            except Exception:
                self.close()
                return False, getattr(response, 'text', str(response))
            if not self.send_ssid():
                self.close()
                return False, 'IQ Option SSID authentication timed out.'

        requests.utils.add_dict_to_cookiejar(self.session.cookies, {'ssid': global_value.SSID})
        self.timesync.server_timestamp = None
        deadline = time.monotonic() + 6.0
        while time.monotonic() < deadline:
            if self.timesync.server_timestamp is not None:
                return True, None
            if global_value.check_websocket_if_connect == 0 or global_value.check_websocket_if_error:
                self.close()
                return False, global_value.websocket_error_reason or 'WebSocket closed during timeSync.'
            time.sleep(0.02)
        self.close()
        return False, 'Timed out waiting for IQ Option timeSync.'

    IQOptionAPI.connect = _safe_api_connect

    # 8. Bounded IQ_Option.connect() (no infinite balance_id spin)
    def _safe_stable_connect(self):
        try:
            self.api.close()
        except Exception:
            pass
        global_value.balance_id = None
        self.api = IQOptionAPI('iqoption.com', self.email, self.password)
        self.api.set_session(headers=self.SESSION_HEADER, cookies=self.SESSION_COOKIE)
        check, reason = self.api.connect()
        if check is True:
            self.re_subscribe_stream()
            deadline = time.monotonic() + 6.0
            while global_value.balance_id is None and time.monotonic() < deadline:
                profile_msg = getattr(getattr(self.api, 'profile', None), 'msg', None)
                if isinstance(profile_msg, dict) and isinstance(profile_msg.get('balances'), list):
                    for bal in profile_msg['balances']:
                        if isinstance(bal, dict) and bal.get('type') == 4 and bal.get('id') is not None:
                            global_value.balance_id = bal['id']
                            break
                    if global_value.balance_id is None and profile_msg['balances']:
                        first = profile_msg['balances'][0]
                        if isinstance(first, dict) and first.get('id') is not None:
                            global_value.balance_id = first['id']
                if global_value.balance_id is not None:
                    break
                if global_value.check_websocket_if_connect == 0 or global_value.check_websocket_if_error:
                    self.api.close()
                    return False, global_value.websocket_error_reason or 'WebSocket closed awaiting balance profile.'
                time.sleep(0.02)
            if global_value.balance_id is None:
                self.api.close()
                return False, 'Timed out waiting for IQ Option balance profile.'
            self.position_change_all('subscribeMessage', global_value.balance_id)
            self.order_changed_all('subscribeMessage')
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


def _normalize_mode(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    val = str(raw).strip().upper()
    if not val:
        return None
    if val in ('REAL', 'LIVE'):
        return 'REAL'
    if val in ('PRACTICE', 'DEMO'):
        return 'PRACTICE'
    raise HTTPException(400, f'Unsupported IQ Option account mode "{raw}". Expected PRACTICE or REAL.')


def _resolve_target_mode(
    explicit_mode: Optional[str] = None,
    x_iq_mode: Optional[str] = None,
    query_mode: Optional[str] = None,
) -> str:
    return (
        _normalize_mode(x_iq_mode)
        or _normalize_mode(query_mode)
        or _normalize_mode(explicit_mode)
        or _requested_mode
    )


def _peek_balance_mode_nonblocking(client: Any, target_mode: str) -> Tuple[str, bool]:
    """Read current balance mode strictly from in-memory state (never triggers WS I/O or waits)."""
    if client is None:
        return (target_mode, False)

    api = getattr(client, 'api', None)
    if api is not None:
        profile_msg = getattr(getattr(api, 'profile', None), 'msg', None)
        if isinstance(profile_msg, dict) and isinstance(profile_msg.get('balances'), list):
            try:
                import iqoptionapi.global_value as global_value
                bal_id = getattr(global_value, 'balance_id', None)
            except Exception:
                bal_id = None
            if bal_id is not None:
                for bal in profile_msg['balances']:
                    if isinstance(bal, dict) and bal.get('id') == bal_id:
                        if bal.get('type') == 1:
                            return ('REAL', target_mode == 'REAL')
                        if bal.get('type') == 4:
                            return ('PRACTICE', target_mode == 'PRACTICE')
        return (_confirmed_mode, _mode_verified and (_confirmed_mode == target_mode))

    # Non-iqoptionapi mock client in unit tests
    if hasattr(client, 'get_balance_mode'):
        try:
            raw = client.get_balance_mode()
            if raw:
                confirmed = str(raw).strip().upper()
                if target_mode == 'REAL':
                    return (confirmed, confirmed == 'REAL')
                if confirmed == 'REAL':
                    return (confirmed, False)
                return (confirmed, confirmed == 'PRACTICE')
        except Exception:
            return ('UNVERIFIED', False)
    return (_confirmed_mode, _mode_verified)


def _ensure_balance_mode(client: Any, target_mode: str, timeout_seconds: Optional[float] = None) -> Tuple[str, bool]:
    """Attempt to switch IQ Option balance mode and verify via get_balance_mode() with bounded timeouts.
    Fails closed when REAL mode is requested unless get_balance_mode() explicitly confirms REAL.
    """
    global _last_error, _confirmed_mode, _mode_verified
    timeout = _MODE_TIMEOUT if timeout_seconds is None else timeout_seconds
    current_mode = None
    try:
        if hasattr(client, 'get_balance_mode'):
            raw_cur = _run_with_timeout(client.get_balance_mode, timeout, 'get_balance_mode')
            if raw_cur:
                current_mode = str(raw_cur).strip().upper()
    except Exception:
        current_mode = None

    if current_mode != target_mode:
        try:
            _run_with_timeout(lambda: client.change_balance(target_mode), timeout, 'change_balance')
        except Exception as exc:
            _last_error = _sanitize_error(f'change_balance({target_mode}) failed: {type(exc).__name__}: {exc}')
            _confirmed_mode = 'UNVERIFIED'
            _mode_verified = False
            return ('UNVERIFIED', False)

    confirmed = 'UNVERIFIED'
    try:
        if hasattr(client, 'get_balance_mode'):
            raw_mode = _run_with_timeout(client.get_balance_mode, timeout, 'get_balance_mode')
            if raw_mode:
                confirmed = str(raw_mode).strip().upper()
    except Exception as exc:
        _last_error = _sanitize_error(f'get_balance_mode() failed: {type(exc).__name__}: {exc}')
        _confirmed_mode = 'UNVERIFIED'
        _mode_verified = False
        return ('UNVERIFIED', False)

    if target_mode == 'REAL':
        verified = confirmed == 'REAL'
        if not verified:
            _last_error = f'Requested REAL account mode could not be verified (connector reported {confirmed}).'
        _confirmed_mode = confirmed
        _mode_verified = verified
        return (confirmed, verified)

    # PRACTICE mode: confirmed if client reports PRACTICE (or if fork omits get_balance_mode, do not misreport as REAL)
    if confirmed == 'REAL':
        _last_error = 'Requested PRACTICE account mode, but connector remained on REAL.'
        _confirmed_mode = confirmed
        _mode_verified = False
        return (confirmed, False)
    if confirmed == 'UNVERIFIED':
        _confirmed_mode = 'PRACTICE'
        _mode_verified = True
        return ('PRACTICE', True)
    verified = confirmed == 'PRACTICE'
    _confirmed_mode = confirmed
    _mode_verified = verified
    return (confirmed, verified)


def _require_verified_mode(client: Any, target_mode: str) -> Tuple[str, bool]:
    confirmed, verified = _ensure_balance_mode(client, target_mode)
    if target_mode == 'REAL' and not verified:
        raise HTTPException(
            409,
            f'IQ Option connector could not verify REAL account mode (active={confirmed}). Refusing to return PRACTICE data as REAL.',
        )
    return (confirmed, verified)


def connect(
    email: Optional[str] = None,
    password: Optional[str] = None,
    target_mode: Optional[str] = None,
    force_reconnect: bool = False,
):
    global _client, _last_error, _connected_at, _requested_mode, _confirmed_mode, _mode_verified, _opcodes_updated
    resolved_mode = _normalize_mode(target_mode) or _requested_mode
    with _bounded_lock():
        prior_email = getattr(_client, 'email', None) if _client is not None else None
        prior_password = getattr(_client, 'password', None) if _client is not None else None

        if _client is not None and not force_reconnect:
            if _is_client_alive(_client):
                _requested_mode = resolved_mode
                return _client
            _invalidate_client('IQ Option WebSocket session disconnected; reconnecting.')

        if force_reconnect and _client is not None:
            _invalidate_client()

        target_email = email or os.environ.get('IQ_EMAIL') or prior_email
        target_password = password or os.environ.get('IQ_PASSWORD') or prior_password
        if not target_email or not target_password:
            raise HTTPException(503, 'IQ Option email and password are required.')

        _patch_iqoptionapi()
        _reset_iq_global_locks()

        try:
            from iqoptionapi.stable_api import IQ_Option
            client = IQ_Option(target_email, target_password)
            result = _run_with_timeout(client.connect, _CONNECT_TIMEOUT, 'iq_connect')
            if not result or not result[0]:
                reason = result[1] if isinstance(result, (list, tuple)) and len(result) > 1 else 'Authentication failed or 2FA required.'
                _safe_close_client(client)
                raise RuntimeError(str(reason))
            _requested_mode = resolved_mode
            _run_with_timeout(lambda: client.change_balance(resolved_mode), _MODE_TIMEOUT, 'change_balance')
            _client = client
            _confirmed_mode = resolved_mode
            _mode_verified = resolved_mode == 'PRACTICE'
            _last_error = None
            _connected_at = time.time()
            return client
        except HTTPException:
            raise
        except TimeoutError as exc:
            _last_error = _sanitize_error(f'Connection timed out: {exc}', (target_password,))
            _invalidate_client()
            raise HTTPException(504, 'IQ Option broker connection timed out; please retry.') from None
        except Exception as exc:
            _last_error = _sanitize_error(f'{type(exc).__name__}: {exc}', (target_password,))
            raise HTTPException(502, f'Broker connection failed ({type(exc).__name__}); check connector configuration.') from None


def _try_reconnect_session(client: Any, target_mode: str) -> Optional[Any]:
    """Attempt a single safe reconnect if credentials are available."""
    email = os.environ.get('IQ_EMAIL') or getattr(client, 'email', None)
    password = os.environ.get('IQ_PASSWORD') or getattr(client, 'password', None)
    if email and password:
        new_client = connect(email=email, password=password, target_mode=target_mode, force_reconnect=True)
        _ensure_balance_mode(new_client, target_mode)
        return new_client
    if hasattr(client, 'connect'):
        res = _run_with_timeout(client.connect, _CONNECT_TIMEOUT, 'client_reconnect')
        if isinstance(res, (list, tuple)) and res and res[0]:
            _ensure_balance_mode(client, target_mode)
            return client
    return None


def _fetch_balance_safe(
    client: Any,
    target_mode: str,
    timeout_seconds: Optional[float] = None,
) -> Any:
    """Retrieve IQ Option balance with strict wall-clock timeout and safe reconnect on WS failure."""
    global _last_error
    timeout = _BALANCE_TIMEOUT if timeout_seconds is None else timeout_seconds
    has_low_level_api = hasattr(client, 'api') and hasattr(client.api, 'get_balances')

    if not has_low_level_api:
        try:
            return _run_with_timeout(client.get_balance, timeout, 'get_balance')
        except TimeoutError:
            _last_error = f'Timed out retrieving IQ Option balance after {timeout:.1f}s.'
            raise HTTPException(504, 'IQ Option upstream timed out retrieving account balance.') from None
        except HTTPException:
            raise
        except Exception as exc:
            _last_error = _sanitize_error(f'get_balance() failed: {type(exc).__name__}: {exc}')
            raise HTTPException(502, f'Failed to retrieve account balance ({type(exc).__name__}).') from None

    last_exc: Optional[Exception] = None
    for attempt in range(2):
        try:
            if not _is_client_alive(client):
                reconnected = _try_reconnect_session(client, target_mode)
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
                        target_id = getattr(global_value, 'balance_id', None)
                    except Exception:
                        target_id = None
                    expected_type = 1 if target_mode == 'REAL' else 4
                    for entry in msg_list:
                        if isinstance(entry, dict) and target_id is not None and entry.get('id') == target_id:
                            return entry.get('amount')
                    for entry in msg_list:
                        if isinstance(entry, dict) and entry.get('type') == expected_type:
                            return entry.get('amount')
                    raise RuntimeError(f'Balance entry for mode {target_mode} not found.')
                if not _is_client_alive(client):
                    break
                time.sleep(0.05)
        except HTTPException:
            raise
        except Exception as exc:
            last_exc = exc
            _last_error = _sanitize_error(f'get_balances failed: {type(exc).__name__}: {exc}')

        if attempt == 0:
            try:
                reconnected = _try_reconnect_session(client, target_mode)
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
    target_mode: str,
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
                reconnected = _try_reconnect_session(client, target_mode)
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

        if attempt == 0:
            try:
                reconnected = _try_reconnect_session(client, target_mode)
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


@app.get('/health')
async def health(
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
):
    """Non-blocking event-loop health endpoint; never blocks on threadpool or upstream WS I/O."""
    target_mode = _resolve_target_mode(x_iq_mode=x_iq_mode, query_mode=mode)
    connected = False
    confirmed_mode = target_mode
    mode_verified = False
    busy = False

    acquired = _lock.acquire(blocking=False)
    if acquired:
        try:
            if _client is not None:
                connected = _is_client_alive(_client)
                if connected:
                    confirmed_mode, mode_verified = _peek_balance_mode_nonblocking(_client, target_mode)
        finally:
            _lock.release()
    else:
        busy = True
        connected = _is_client_alive(_client)
        confirmed_mode = _confirmed_mode if connected else _requested_mode
        mode_verified = bool(_mode_verified and confirmed_mode == target_mode) if connected else False

    return {
        'status': 'running',
        'busy': busy,
        'connected': connected and (target_mode != 'REAL' or mode_verified),
        'mode': confirmed_mode,
        'requestedMode': target_mode,
        'accountType': confirmed_mode if connected else None,
        'modeVerified': mode_verified if connected else False,
        'orderExecutionSupported': False,
        'realTradingEnabled': False,
        'credentialsConfigured': bool(os.getenv('IQ_EMAIL') and os.getenv('IQ_PASSWORD')),
        'lastError': _last_error,
        'connectedAt': _connected_at,
    }


@app.post('/connect')
def connect_route(
    body: Optional[ConnectBody] = None,
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    global _requested_mode
    target_mode = _resolve_target_mode(
        explicit_mode=body.mode if body else None,
        x_iq_mode=x_iq_mode,
        query_mode=mode,
    )
    with _bounded_lock():
        client = connect(
            email=body.email if body else None,
            password=body.password if body else None,
            target_mode=target_mode,
        )
        _requested_mode = target_mode
        is_connected = _is_client_alive(client)
        confirmed_mode, mode_verified = _ensure_balance_mode(client, target_mode)

        if target_mode == 'REAL' and not mode_verified:
            return {
                'connected': False,
                'mode': confirmed_mode,
                'requestedMode': 'REAL',
                'accountType': confirmed_mode,
                'modeVerified': False,
                'orderExecutionSupported': False,
                'realTradingEnabled': False,
                'connectedAt': _connected_at,
                'detail': 'IQ Option connector could not verify REAL account mode; refusing to mask PRACTICE as REAL.',
            }

        return {
            'connected': is_connected and mode_verified,
            'mode': confirmed_mode,
            'requestedMode': target_mode,
            'accountType': confirmed_mode,
            'modeVerified': mode_verified,
            'orderExecutionSupported': False,
            'realTradingEnabled': False,
            'connectedAt': _connected_at,
        }


@app.get('/account')
def account(
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    target_mode = _resolve_target_mode(x_iq_mode=x_iq_mode, query_mode=mode)
    with _bounded_lock():
        client = connect(target_mode=target_mode)
        confirmed_mode, mode_verified = _require_verified_mode(client, target_mode)
        balance_val = _fetch_balance_safe(client, target_mode)
        return {
            'connected': True,
            'mode': confirmed_mode,
            'requestedMode': target_mode,
            'accountType': confirmed_mode,
            'modeVerified': mode_verified,
            'balance': balance_val,
            'currency': 'Account currency (verify in IQ Option)',
            'orderExecutionSupported': False,
            'realTradingEnabled': False,
            'source': 'IQ_OPTION_UNOFFICIAL',
        }


@app.get('/balance')
def balance(
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    target_mode = _resolve_target_mode(x_iq_mode=x_iq_mode, query_mode=mode)
    with _bounded_lock():
        client = connect(target_mode=target_mode)
        confirmed_mode, mode_verified = _require_verified_mode(client, target_mode)
        balance_val = _fetch_balance_safe(client, target_mode)
        return {
            'balance': balance_val,
            'mode': confirmed_mode,
            'requestedMode': target_mode,
            'accountType': confirmed_mode,
            'modeVerified': mode_verified,
            'orderExecutionSupported': False,
            'realTradingEnabled': False,
            'source': 'IQ_OPTION_UNOFFICIAL',
        }


@app.get('/assets')
def assets(x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    with _bounded_lock():
        client = connect()
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
    target_mode = _resolve_target_mode(x_iq_mode=x_iq_mode, query_mode=mode)
    clean = symbol.strip().upper().replace('/', '')
    if not clean or len(clean) < 3 or len(clean) > 25:
        raise HTTPException(400, 'Invalid symbol format.')
    with _bounded_lock():
        client = connect(target_mode=target_mode)
        confirmed_mode, _ = _require_verified_mode(client, target_mode)
        rows = _fetch_candles_safe(client, clean, 60, 2, target_mode)
        if not isinstance(rows, list) or len(rows) == 0 or not isinstance(rows[-1], dict):
            raise HTTPException(502, f'Broker did not return valid candle price for {clean}.')
        bar = rows[-1]
        close_price = bar.get('close')
        if close_price is None:
            raise HTTPException(502, f'Broker candle for {clean} did not include a close price.')
        return {
            'symbol': clean,
            'bid': None,
            'ask': None,
            'last': close_price,
            'spread': None,
            'time': bar.get('from'),
            'mode': confirmed_mode,
            'orderExecutionSupported': False,
            'realTradingEnabled': False,
            'source': 'IQ_OPTION_UNOFFICIAL',
            'note': 'Reference close price from unofficial 1m candles (iqoptionapi); live bid/ask stream is not exposed.',
        }


@app.post('/candles')
def candles(
    query: CandlesQuery,
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    target_mode = _resolve_target_mode(x_iq_mode=x_iq_mode, query_mode=mode)
    with _bounded_lock():
        client = connect(target_mode=target_mode)
        confirmed_mode, _ = _require_verified_mode(client, target_mode)
        rows = _fetch_candles_safe(client, query.symbol, query.interval, query.count, target_mode)
        normalized = [
            {
                'time': c.get('from'),
                'open': c.get('open'),
                'high': c.get('max'),
                'low': c.get('min'),
                'close': c.get('close'),
                'volume': c.get('volume', 0),
            }
            for c in rows
            if isinstance(c, dict) and c.get('close') is not None
        ]
        return {
            'symbol': query.symbol,
            'interval': query.interval,
            'candles': normalized,
            'mode': confirmed_mode,
            'orderExecutionSupported': False,
            'realTradingEnabled': False,
            'source': 'IQ_OPTION_UNOFFICIAL',
            'note': 'Historical candles from unofficial WebSocket; verify latency before use.',
        }


@app.get('/history')
def history(
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
    x_connector_token: Optional[str] = Header(default=None),
):
    _check_auth(x_connector_token)
    target_mode = _resolve_target_mode(x_iq_mode=x_iq_mode, query_mode=mode)
    with _bounded_lock():
        client = connect(target_mode=target_mode)
        confirmed_mode, mode_verified = _require_verified_mode(client, target_mode)
        try:
            if hasattr(client, 'get_optioninfo_v2'):
                data = _run_with_timeout(lambda: client.get_optioninfo_v2(20), _HISTORY_TIMEOUT, 'get_optioninfo_v2')
                closed = data.get('msg', {}).get('closed_options', []) if isinstance(data, dict) else []
                return {
                    'supported': True,
                    'mode': confirmed_mode,
                    'modeVerified': mode_verified,
                    'trades': closed,
                    'source': 'IQ_OPTION_UNOFFICIAL',
                }
            return {
                'supported': False,
                'mode': confirmed_mode,
                'modeVerified': mode_verified,
                'trades': [],
                'note': 'Installed iqoptionapi fork does not support get_optioninfo_v2.',
            }
        except TimeoutError:
            return {
                'supported': False,
                'mode': confirmed_mode,
                'modeVerified': mode_verified,
                'trades': [],
                'note': 'Trade history retrieval timed out.',
            }
        except Exception as exc:
            return {
                'supported': False,
                'mode': confirmed_mode,
                'modeVerified': mode_verified,
                'trades': [],
                'note': f'Trade history retrieval failed ({type(exc).__name__}).',
            }


@app.post('/order')
def order_locked(x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    raise HTTPException(
        423,
        'IQ Option order execution is strictly locked (read-only unofficial connector).',
    )


@app.post('/disconnect')
def disconnect(x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    global _requested_mode, _confirmed_mode
    with _bounded_lock():
        _invalidate_client()
        _requested_mode = 'PRACTICE'
        _confirmed_mode = 'PRACTICE'
    return {'connected': False}
