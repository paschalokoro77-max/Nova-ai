"""FastAPI HTTP bridge wrapping NovaTrade's official MetaTrader 5 Python SDK service.

Run on Windows x64 alongside a logged-in MetaTrader 5 Desktop Terminal (DEMO account only):
    uvicorn app:app --host 127.0.0.1 --port 8765
"""
import hmac
import os
from typing import Optional
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from mt5_core import BridgeError, MT5BridgeService

app = FastAPI(title="NovaTrade Official MT5 Python Bridge", version="1.0.0")
service = MT5BridgeService()


def _check_auth(x_bridge_token: Optional[str]) -> None:
    expected = os.environ.get("MT5_BRIDGE_TOKEN", "").strip()
    if expected and not hmac.compare_digest((x_bridge_token or "").strip(), expected):
        raise HTTPException(status_code=401, detail="Invalid bridge token.")


def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except BridgeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from None


class ConnectBody(BaseModel):
    environment: str = Field(default="demo")
    login: Optional[str] = None
    password: Optional[str] = Field(default=None, repr=False)
    server: Optional[str] = Field(default="MetaQuotes-Demo")


class CandlesBody(BaseModel):
    symbol: str = Field(default="EURUSD", pattern=r"^[A-Za-z0-9._-]{2,25}$")
    interval: int = Field(default=60, ge=60, le=86400)
    count: int = Field(default=100, ge=1, le=500)


class OrderBody(BaseModel):
    environment: str = Field(default="demo")
    symbol: str = Field(..., pattern=r"^[A-Za-z0-9._-]{2,25}$")
    side: str = Field(..., pattern=r"^(BUY|SELL)$")
    orderType: str = Field(default="MARKET", pattern=r"^(MARKET|LIMIT)$")
    volume: float = Field(default=0.01, gt=0, le=50)
    price: Optional[float] = Field(default=None, gt=0)
    comment: str = Field(default="NovaTrade-Demo", max_length=31)


@app.get("/health")
def health(x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return service.health()


@app.post("/connect")
def connect(body: ConnectBody, x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    if body.environment.strip().lower() != "demo":
        raise HTTPException(status_code=403, detail="Only DEMO environment connections are permitted.")
    return _run(service.connect, login=body.login, password=body.password, server=body.server)


@app.post("/disconnect")
def disconnect(x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return service.disconnect()


@app.get("/account")
def account(x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return _run(service.get_account)


@app.get("/symbols")
def symbols(limit: int = 200, x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return _run(service.get_symbols, limit=max(1, min(500, limit)))


@app.get("/price/{symbol}")
def price(symbol: str, x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return _run(service.get_price, symbol)


@app.post("/candles")
def candles(body: CandlesBody, x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return _run(service.get_candles, body.symbol, body.interval, body.count)


@app.get("/positions")
def positions(symbol: Optional[str] = None, x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return _run(service.get_positions, symbol)


@app.get("/history")
def history(days: int = 14, x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return _run(service.get_history, days)


@app.post("/order/validate")
def validate_order(body: OrderBody, x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return _run(
        service.validate_order,
        environment=body.environment,
        symbol=body.symbol,
        side=body.side,
        order_type=body.orderType,
        volume=body.volume,
        price=body.price,
        comment=body.comment,
    )


@app.post("/order")
def place_order(body: OrderBody, x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return _run(
        service.place_demo_order,
        environment=body.environment,
        symbol=body.symbol,
        side=body.side,
        order_type=body.orderType,
        volume=body.volume,
        price=body.price,
        comment=body.comment,
    )


@app.get("/orders/{order_id}")
def order_status(order_id: str, x_bridge_token: Optional[str] = Header(default=None)):
    _check_auth(x_bridge_token)
    return _run(service.get_order_status, order_id)
