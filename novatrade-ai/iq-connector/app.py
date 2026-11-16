"""Experimental, self-hosted IQ Option read-only connector.
Credentials are read from local environment variables, never accepted over HTTP.
This service stays locked to PRACTICE / read-only inspection and does not place real orders.
"""
import os
import time
import threading
from typing import Any, Optional
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title='NovaTrade IQ Option experimental connector', version='0.3.0')
_lock = threading.RLock()
_client: Any = None
_last_error: Optional[str] = None
_connected_at: Optional[float] = None


class CandlesQuery(BaseModel):
    symbol: str = Field(default='EURUSD', pattern=r'^[A-Z0-9_-]{3,25}$')
    interval: int = Field(default=60, ge=5, le=3600)
    count: int = Field(default=100, ge=1, le=500)


def _check_auth(x_connector_token: Optional[str]):
    expected = os.environ.get('IQ_CONNECTOR_TOKEN', '').strip()
    if expected and x_connector_token != expected:
        raise HTTPException(401, 'Invalid connector token.')


class ConnectBody(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = Field(default=None, repr=False)


def connect(email: Optional[str] = None, password: Optional[str] = None):
    global _client, _last_error, _connected_at
    with _lock:
        if _client is not None:
            try:
                if _client.check_connect():
                    return _client
            except Exception:
                _client = None
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
            client.change_balance('PRACTICE')
            _client = client
            _last_error = None
            _connected_at = time.time()
            return client
        except HTTPException:
            raise
        except Exception as exc:
            _last_error = f'{type(exc).__name__}: {exc}'
            raise HTTPException(502, f'Broker connection failed ({type(exc).__name__}); check connector logs locally.') from None


@app.get('/health')
def health():
    connected = False
    with _lock:
        if _client is not None:
            try:
                connected = bool(_client.check_connect())
            except Exception:
                connected = False
    return {
        'status': 'running',
        'connected': connected,
        'mode': 'PRACTICE_READ_ONLY',
        'realTradingEnabled': False,
        'credentialsConfigured': bool(os.getenv('IQ_EMAIL') and os.getenv('IQ_PASSWORD')),
        'lastError': _last_error,
        'connectedAt': _connected_at,
    }


@app.post('/connect')
def connect_route(body: Optional[ConnectBody] = None, x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    client = connect(email=body.email if body else None, password=body.password if body else None)
    return {
        'connected': bool(client.check_connect()),
        'mode': 'PRACTICE',
        'accountType': 'PRACTICE',
        'realTradingEnabled': False,
        'connectedAt': _connected_at,
    }


@app.get('/account')
def account(x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    with _lock:
        client = connect()
        client.change_balance('PRACTICE')
        balance = client.get_balance()
        balance_mode = 'PRACTICE'
        try:
            if hasattr(client, 'get_balance_mode'):
                balance_mode = client.get_balance_mode() or 'PRACTICE'
        except Exception:
            balance_mode = 'PRACTICE'
        return {
            'connected': True,
            'accountType': balance_mode,
            'balance': balance,
            'currency': 'Account currency (verify in IQ Option)',
            'realTradingEnabled': False,
            'source': 'IQ_OPTION_UNOFFICIAL',
        }


@app.get('/balance')
def balance(x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    with _lock:
        client = connect()
        client.change_balance('PRACTICE')
        return {'balance': client.get_balance(), 'mode': 'PRACTICE', 'source': 'IQ_OPTION_UNOFFICIAL'}


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
def latest_price(symbol: str, x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    clean = symbol.strip().upper()
    if not clean or len(clean) < 3 or len(clean) > 25:
        raise HTTPException(400, 'Invalid symbol format.')
    with _lock:
        client = connect()
        client.change_balance('PRACTICE')
        rows = client.get_candles(clean, 60, 2, int(time.time()))
        if not isinstance(rows, list) or len(rows) == 0 or not isinstance(rows[-1], dict):
            raise HTTPException(502, f'Broker did not return valid candle price for {clean}.')
        bar = rows[-1]
        close_price = bar.get('close')
        return {
            'symbol': clean,
            'bid': None,
            'ask': None,
            'last': close_price,
            'spread': None,
            'time': bar.get('from'),
            'source': 'IQ_OPTION_UNOFFICIAL',
            'note': 'Reference close price from unofficial 1m candles (iqoptionapi); live bid/ask stream is not exposed.',
        }


@app.post('/candles')
def candles(query: CandlesQuery, x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    with _lock:
        client = connect()
        client.change_balance('PRACTICE')
        rows = client.get_candles(query.symbol, query.interval, query.count, int(time.time()))
        if not isinstance(rows, list):
            raise HTTPException(502, 'Broker did not return valid candles.')
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
            if isinstance(c, dict)
        ]
        return {
            'symbol': query.symbol,
            'interval': query.interval,
            'candles': normalized,
            'source': 'IQ_OPTION_UNOFFICIAL',
            'note': 'Historical candles from unofficial WebSocket; verify latency before use.',
        }


@app.get('/history')
def history(x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    with _lock:
        client = connect()
        client.change_balance('PRACTICE')
        try:
            if hasattr(client, 'get_optioninfo_v2'):
                data = client.get_optioninfo_v2(20)
                closed = data.get('msg', {}).get('closed_options', []) if isinstance(data, dict) else []
                return {'supported': True, 'trades': closed, 'source': 'IQ_OPTION_UNOFFICIAL'}
            return {'supported': False, 'trades': [], 'note': 'Installed iqoptionapi fork does not support get_optioninfo_v2.'}
        except Exception as exc:
            return {'supported': False, 'trades': [], 'note': f'Trade history retrieval failed ({type(exc).__name__}).'}


@app.post('/disconnect')
def disconnect(x_connector_token: Optional[str] = Header(default=None)):
    _check_auth(x_connector_token)
    global _client, _connected_at
    with _lock:
        _client = None
        _connected_at = None
    return {'connected': False}
