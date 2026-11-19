"""Experimental, self-hosted IQ Option read-only connector.
Credentials are read from local environment variables, never accepted over HTTP unless explicitly passed by NovaTrade server vault.
Supports read-only account/balance/market/history inspection in PRACTICE or REAL mode without placing orders.
Never silently switches REAL to PRACTICE or returns PRACTICE balances under a REAL label.
"""
import os
import time
import threading
from typing import Any, Optional, Tuple
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

app = FastAPI(title='NovaTrade IQ Option experimental connector', version='0.4.1')
_lock = threading.RLock()
_client: Any = None
_last_error: Optional[str] = None
_connected_at: Optional[float] = None
_requested_mode: str = 'PRACTICE'
_opcodes_updated: bool = False


def _sanitize_error(msg: str) -> str:
    cleaned = str(msg or '')
    for secret_key in ('IQ_PASSWORD', 'IQ_CONNECTOR_TOKEN'):
        secret = (os.environ.get(secret_key) or '').strip()
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


def _ensure_balance_mode(client: Any, target_mode: str) -> Tuple[str, bool]:
    """Attempt to switch IQ Option balance mode and verify via get_balance_mode().
    Fails closed when REAL mode is requested unless get_balance_mode() explicitly confirms REAL.
    """
    global _last_error
    current_mode = None
    try:
        if hasattr(client, 'get_balance_mode'):
            raw_cur = client.get_balance_mode()
            if raw_cur:
                current_mode = str(raw_cur).strip().upper()
    except Exception:
        current_mode = None

    if current_mode != target_mode:
        try:
            client.change_balance(target_mode)
        except Exception as exc:
            _last_error = _sanitize_error(f'change_balance({target_mode}) failed: {type(exc).__name__}: {exc}')
            return ('UNVERIFIED', False)

    confirmed = 'UNVERIFIED'
    try:
        if hasattr(client, 'get_balance_mode'):
            raw_mode = client.get_balance_mode()
            if raw_mode:
                confirmed = str(raw_mode).strip().upper()
    except Exception as exc:
        _last_error = _sanitize_error(f'get_balance_mode() failed: {type(exc).__name__}: {exc}')
        return ('UNVERIFIED', False)

    if target_mode == 'REAL':
        verified = confirmed == 'REAL'
        if not verified:
            _last_error = f'Requested REAL account mode could not be verified (connector reported {confirmed}).'
        return (confirmed, verified)

    # PRACTICE mode: confirmed if client reports PRACTICE (or if fork omits get_balance_mode, do not misreport as REAL)
    if confirmed == 'REAL':
        _last_error = 'Requested PRACTICE account mode, but connector remained on REAL.'
        return (confirmed, False)
    if confirmed == 'UNVERIFIED':
        return ('PRACTICE', True)
    return (confirmed, confirmed == 'PRACTICE')


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
    global _client, _last_error, _connected_at, _requested_mode, _opcodes_updated
    resolved_mode = _normalize_mode(target_mode) or _requested_mode
    with _lock:
        if _client is not None and not force_reconnect:
            try:
                if _client.check_connect():
                    _requested_mode = resolved_mode
                    return _client
            except Exception:
                _client = None
        if force_reconnect:
            _client = None
            _opcodes_updated = False
        target_email = email or os.environ.get('IQ_EMAIL')
        target_password = password or os.environ.get('IQ_PASSWORD')
        if not target_email or not target_password:
            raise HTTPException(503, 'IQ Option email and password are required.')
        try:
            from iqoptionapi.stable_api import IQ_Option
            client = IQ_Option(target_email, target_password)
            result = client.connect()
            if not result or not result[0]:
                reason = result[1] if isinstance(result, (list, tuple)) and len(result) > 1 else 'Authentication failed or 2FA required.'
                raise RuntimeError(str(reason))
            _requested_mode = resolved_mode
            client.change_balance(resolved_mode)
            _client = client
            _last_error = None
            _connected_at = time.time()
            return client
        except HTTPException:
            raise
        except Exception as exc:
            _last_error = _sanitize_error(f'{type(exc).__name__}: {exc}')
            raise HTTPException(502, f'Broker connection failed ({type(exc).__name__}); check connector configuration.') from None


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
            client.update_ACTIVES_OPCODE()
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
    timeout_seconds: float = 7.0,
) -> list:
    global _last_error
    has_low_level_api = (
        hasattr(client, 'api')
        and hasattr(client.api, 'getcandles')
        and hasattr(client.api, 'candles')
    )

    if not has_low_level_api:
        try:
            rows = client.get_candles(clean_symbol, interval, count, int(time.time()))
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
            if hasattr(client, 'check_connect') and not client.check_connect():
                client = connect(target_mode=target_mode, force_reconnect=True)
                _ensure_balance_mode(client, target_mode)
            client.api.candles.candles_data = None
            client.api.getcandles(int(active_id), int(interval), int(count), int(time.time()))
            deadline = time.monotonic() + timeout_seconds
            while time.monotonic() < deadline:
                rows = getattr(client.api.candles, 'candles_data', None)
                if rows is not None:
                    if not isinstance(rows, list):
                        raise HTTPException(502, f'Broker returned invalid candle payload for {clean_symbol}.')
                    return rows
                if hasattr(client, 'check_connect') and not client.check_connect():
                    break
                time.sleep(0.05)
        except HTTPException:
            raise
        except Exception as exc:
            last_exc = exc
            _last_error = _sanitize_error(f'getcandles({clean_symbol}) failed: {type(exc).__name__}: {exc}')

        if attempt == 0:
            try:
                if os.environ.get('IQ_EMAIL') and os.environ.get('IQ_PASSWORD'):
                    client = connect(target_mode=target_mode, force_reconnect=True)
                    _ensure_balance_mode(client, target_mode)
                elif hasattr(client, 'connect'):
                    res = client.connect()
                    if isinstance(res, (list, tuple)) and res and res[0]:
                        _ensure_balance_mode(client, target_mode)
                    else:
                        break
                else:
                    break
            except HTTPException:
                break
            except Exception as exc:
                last_exc = exc
                _last_error = _sanitize_error(f'reconnect failed: {type(exc).__name__}: {exc}')

    if last_exc is not None:
        raise HTTPException(502, f'IQ Option upstream error retrieving candles for {clean_symbol} ({type(last_exc).__name__}).') from None
    _last_error = f'Timed out waiting for IQ Option candles for {clean_symbol}.'
    raise HTTPException(504, f'IQ Option upstream timed out returning candles for {clean_symbol}.')


@app.get('/health')
def health(
    mode: Optional[str] = Query(default=None),
    x_iq_mode: Optional[str] = Header(default=None),
):
    target_mode = _resolve_target_mode(x_iq_mode=x_iq_mode, query_mode=mode)
    connected = False
    confirmed_mode = target_mode
    mode_verified = False
    busy = False
    acquired = _lock.acquire(timeout=1.5)
    if acquired:
        try:
            if _client is not None:
                try:
                    connected = bool(_client.check_connect())
                    if connected:
                        confirmed_mode, mode_verified = _ensure_balance_mode(_client, target_mode)
                except Exception:
                    connected = False
        finally:
            _lock.release()
    else:
        busy = True
        connected = _client is not None
        confirmed_mode = _requested_mode
        mode_verified = False

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
    with _lock:
        client = connect(
            email=body.email if body else None,
            password=body.password if body else None,
            target_mode=target_mode,
        )
        _requested_mode = target_mode
        is_connected = bool(client.check_connect())
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
    with _lock:
        client = connect(target_mode=target_mode)
        confirmed_mode, mode_verified = _require_verified_mode(client, target_mode)
        try:
            balance_val = client.get_balance()
        except Exception as exc:
            raise HTTPException(502, f'Failed to retrieve account balance ({type(exc).__name__}).') from None
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
    with _lock:
        client = connect(target_mode=target_mode)
        confirmed_mode, mode_verified = _require_verified_mode(client, target_mode)
        try:
            balance_val = client.get_balance()
        except Exception as exc:
            raise HTTPException(502, f'Failed to retrieve balance ({type(exc).__name__}).') from None
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
    with _lock:
        client = connect()
        try:
            open_time = client.get_all_open_time()
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
    with _lock:
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
    with _lock:
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
    with _lock:
        client = connect(target_mode=target_mode)
        confirmed_mode, mode_verified = _require_verified_mode(client, target_mode)
        try:
            if hasattr(client, 'get_optioninfo_v2'):
                data = client.get_optioninfo_v2(20)
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
    global _client, _connected_at, _requested_mode, _opcodes_updated
    with _lock:
        _client = None
        _connected_at = None
        _requested_mode = 'PRACTICE'
        _opcodes_updated = False
    return {'connected': False}
