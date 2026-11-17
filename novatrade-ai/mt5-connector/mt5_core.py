"""Official MetaTrader 5 Python SDK service layer (supports DEMO and REAL MT5 accounts).

Requires a Windows host running the MetaTrader 5 Desktop Terminal (`terminal64.exe`) when used with
the official `MetaTrader5` PyPI package. Accepts an injectable `mt5_module` for deterministic unit testing.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math
import os
import threading
from typing import Any, Dict, List, Optional


class BridgeError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _as_float(val: Any, default: Optional[float] = None) -> Optional[float]:
    if val is None:
        return default
    try:
        num = float(val)
        return num if math.isfinite(num) else default
    except (TypeError, ValueError):
        return default


def _as_int(val: Any, default: Optional[int] = None) -> Optional[int]:
    if val is None:
        return default
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _iso_from_epoch(ts: Any) -> Optional[str]:
    sec = _as_int(ts)
    if sec is None or sec <= 0:
        return None
    return datetime.fromtimestamp(sec, tz=timezone.utc).isoformat()


def _trade_mode_label(mt5_mod: Any, trade_mode: Any) -> str:
    demo_const = getattr(mt5_mod, "ACCOUNT_TRADE_MODE_DEMO", 0)
    contest_const = getattr(mt5_mod, "ACCOUNT_TRADE_MODE_CONTEST", 1)
    real_const = getattr(mt5_mod, "ACCOUNT_TRADE_MODE_REAL", 2)
    if trade_mode == demo_const:
        return "DEMO"
    if trade_mode == real_const:
        return "REAL"
    if trade_mode == contest_const:
        return "CONTEST"
    return f"UNKNOWN({trade_mode})"


def load_official_mt5_module() -> Any:
    try:
        import MetaTrader5 as mt5  # type: ignore
        return mt5
    except ImportError as exc:
        raise BridgeError(
            503,
            "Official MetaTrader5 Python package is unavailable. Run this bridge on Windows x64 alongside an active MetaTrader 5 terminal.",
        ) from exc


class MT5BridgeService:
    def __init__(self, mt5_module: Any = None):
        self._injected_mt5 = mt5_module
        self._lock = threading.RLock()
        self._connected = False
        self._last_error: Optional[str] = None
        self._connected_at: Optional[float] = None

    def _mt5(self) -> Any:
        if self._injected_mt5 is not None:
            return self._injected_mt5
        return load_official_mt5_module()

    def _timeframe_map(self, mt5_mod: Any) -> Dict[int, Any]:
        return {
            60: getattr(mt5_mod, "TIMEFRAME_M1", 1),
            300: getattr(mt5_mod, "TIMEFRAME_M5", 5),
            900: getattr(mt5_mod, "TIMEFRAME_M15", 15),
            1800: getattr(mt5_mod, "TIMEFRAME_M30", 30),
            3600: getattr(mt5_mod, "TIMEFRAME_H1", 16385),
            14400: getattr(mt5_mod, "TIMEFRAME_H4", 16388),
            86400: getattr(mt5_mod, "TIMEFRAME_D1", 16408),
        }

    def ensure_authenticated_account(self, mt5_mod: Any) -> tuple[Any, str]:
        info = mt5_mod.account_info()
        if info is None:
            err = mt5_mod.last_error() if hasattr(mt5_mod, "last_error") else "account_info() returned None"
            self._connected = False
            self._last_error = f"MT5 terminal not logged into an account ({err})."
            raise BridgeError(503, self._last_error)

        trade_mode = _attr(info, "trade_mode")
        mode_label = _trade_mode_label(mt5_mod, trade_mode)
        return info, mode_label

    def ensure_demo_account(self, mt5_mod: Any) -> Any:
        info, mode_label = self.ensure_authenticated_account(mt5_mod)
        demo_const = getattr(mt5_mod, "ACCOUNT_TRADE_MODE_DEMO", 0)
        trade_mode = _attr(info, "trade_mode")
        if trade_mode != demo_const:
            self._last_error = f"Order execution blocked on non-DEMO MT5 account (trade_mode={mode_label}). Only DEMO accounts can execute trades."
            raise BridgeError(403, self._last_error)
        return info

    def _require_connected_account(self) -> tuple[Any, Any, str]:
        mt5_mod = self._mt5()
        if not self._connected:
            info = mt5_mod.account_info() if hasattr(mt5_mod, "account_info") else None
            if info is None:
                raise BridgeError(503, "MT5 bridge session is not connected. Call POST /connect first.")
            info, mode_label = self.ensure_authenticated_account(mt5_mod)
            self._connected = True
            return mt5_mod, info, mode_label
        info, mode_label = self.ensure_authenticated_account(mt5_mod)
        return mt5_mod, info, mode_label

    def _require_connected_for_environment(
        self, expected_environment: Optional[str] = None
    ) -> tuple[Any, Any, str]:
        mt5_mod, info, mode_label = self._require_connected_account()
        if mode_label not in ("DEMO", "REAL"):
            raise BridgeError(
                403,
                f"Order execution and bridge access require a DEMO or REAL MT5 account (current trade_mode={mode_label}).",
            )
        if expected_environment:
            expected_label = expected_environment.strip().upper()
            if expected_label not in ("DEMO", "REAL"):
                raise BridgeError(400, f"Invalid MT5 environment '{expected_environment}'. Expected 'demo' or 'real'.")
            if mode_label != expected_label:
                raise BridgeError(
                    403,
                    f"Environment mismatch: target environment is {expected_label}, but connected MT5 terminal is {mode_label}.",
                )
        return mt5_mod, info, mode_label

    def _require_connected_demo(self) -> tuple[Any, Any]:
        mt5_mod, info, mode_label = self._require_connected_account()
        demo_const = getattr(mt5_mod, "ACCOUNT_TRADE_MODE_DEMO", 0)
        if _attr(info, "trade_mode") != demo_const:
            raise BridgeError(403, f"Order execution blocked on {mode_label} account. DEMO account required.")
        return mt5_mod, info

    def health(self) -> Dict[str, Any]:
        with self._lock:
            try:
                mt5_mod = self._mt5()
            except BridgeError as exc:
                return {
                    "status": "standby",
                    "connected": False,
                    "tradeMode": None,
                    "accountLogin": None,
                    "server": None,
                    "realTradingEnabled": False,
                    "sdk": "MetaTrader5",
                    "sdkInstalled": False,
                    "lastError": exc.message,
                }

            info = None
            try:
                info = mt5_mod.account_info()
            except Exception:
                info = None

            if info is None:
                return {
                    "status": "running",
                    "connected": False,
                    "tradeMode": None,
                    "accountLogin": None,
                    "server": None,
                    "realTradingEnabled": False,
                    "sdk": "MetaTrader5",
                    "sdkInstalled": True,
                    "lastError": self._last_error,
                }

            mode_label = _trade_mode_label(mt5_mod, _attr(info, "trade_mode"))
            return {
                "status": "running",
                "connected": bool(self._connected),
                "tradeMode": mode_label,
                "accountLogin": _attr(info, "login"),
                "server": _attr(info, "server"),
                "realTradingEnabled": mode_label == "REAL",
                "sdk": "MetaTrader5",
                "sdkInstalled": True,
                "lastError": self._last_error,
            }

    def connect(
        self,
        login: Optional[str] = None,
        password: Optional[str] = None,
        server: Optional[str] = None,
        environment: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            mt5_mod = self._mt5()
            terminal_path = os.environ.get("MT5_TERMINAL_PATH", "").strip() or None
            env_login = os.environ.get("MT5_LOGIN", "").strip()
            env_password = os.environ.get("MT5_PASSWORD", "")
            env_server = os.environ.get("MT5_SERVER", "").strip()

            init_ok = mt5_mod.initialize(path=terminal_path) if terminal_path else mt5_mod.initialize()
            if not init_ok:
                err = mt5_mod.last_error() if hasattr(mt5_mod, "last_error") else "initialize() failed"
                self._connected = False
                self._last_error = f"mt5.initialize() failed: {err}"
                raise BridgeError(502, self._last_error)

            target_login = _as_int((login or env_login or "").strip())
            target_password = password if (password is not None and password != "") else env_password
            target_server = (server or env_server or "MetaQuotes-Demo").strip() or "MetaQuotes-Demo"
            if target_login and target_password:
                login_ok = mt5_mod.login(
                    target_login,
                    password=target_password,
                    server=target_server,
                )
                if not login_ok:
                    err = mt5_mod.last_error() if hasattr(mt5_mod, "last_error") else "login() failed"
                    self._connected = False
                    self._last_error = f"mt5.login() failed: {err}"
                    raise BridgeError(401, self._last_error)

            info, mode_label = self.ensure_authenticated_account(mt5_mod)
            if environment:
                expected_label = environment.strip().upper()
                if expected_label not in ("DEMO", "REAL"):
                    raise BridgeError(400, f"Invalid MT5 environment '{environment}'. Use 'demo' or 'real'.")
                if mode_label != expected_label:
                    self._connected = False
                    raise BridgeError(
                        403,
                        f"Selected account environment is {expected_label}, but MT5 terminal authenticated a {mode_label} account.",
                    )
            self._connected = True
            self._last_error = None
            return {
                "connected": True,
                "tradeMode": mode_label,
                "accountType": f"{mode_label} ({_attr(info, 'server', 'MT5')})",
                "login": _attr(info, "login"),
                "server": _attr(info, "server"),
                "balance": _as_float(_attr(info, "balance")),
                "equity": _as_float(_attr(info, "equity")),
                "margin": _as_float(_attr(info, "margin")),
                "marginFree": _as_float(_attr(info, "margin_free")),
                "currency": _attr(info, "currency", "USD"),
                "leverage": _as_int(_attr(info, "leverage")),
                "realTradingEnabled": mode_label == "REAL",
                "source": "MT5_OFFICIAL_PYTHON",
            }

    def disconnect(self) -> Dict[str, Any]:
        with self._lock:
            self._connected = False
            try:
                mt5_mod = self._mt5()
                mt5_mod.shutdown()
            except Exception:
                pass
            return {"connected": False, "message": "MT5 terminal session shut down."}

    def get_account(self) -> Dict[str, Any]:
        with self._lock:
            _, info, mode_label = self._require_connected_for_environment()
            return {
                "connected": True,
                "tradeMode": mode_label,
                "login": _attr(info, "login"),
                "server": _attr(info, "server"),
                "balance": _as_float(_attr(info, "balance")),
                "equity": _as_float(_attr(info, "equity")),
                "margin": _as_float(_attr(info, "margin")),
                "marginFree": _as_float(_attr(info, "margin_free")),
                "profit": _as_float(_attr(info, "profit"), 0.0),
                "leverage": _as_int(_attr(info, "leverage")),
                "currency": _attr(info, "currency", "USD"),
                "realTradingEnabled": mode_label == "REAL",
                "source": "MT5_OFFICIAL_PYTHON",
            }

    def get_symbols(self, limit: int = 200) -> Dict[str, Any]:
        with self._lock:
            mt5_mod, _, _ = self._require_connected_for_environment()
            raw = mt5_mod.symbols_get() or []
            symbols: List[Dict[str, Any]] = []
            for item in raw:
                name = str(_attr(item, "name", "")).strip()
                if not name:
                    continue
                visible = bool(_attr(item, "visible", True))
                trade_mode = _as_int(_attr(item, "trade_mode"), 4)
                # SYMBOL_TRADE_MODE_DISABLED == 0
                is_open = bool(visible and trade_mode != 0)
                symbols.append(
                    {
                        "symbol": name,
                        "brokerSymbol": name,
                        "name": str(_attr(item, "description", name) or name),
                        "category": str(_attr(item, "path", "MT5") or "MT5").split("\\")[0],
                        "open": is_open,
                        "digits": _as_int(_attr(item, "digits"), 5),
                        "volumeMin": _as_float(_attr(item, "volume_min"), 0.01),
                        "volumeMax": _as_float(_attr(item, "volume_max"), 100.0),
                        "volumeStep": _as_float(_attr(item, "volume_step"), 0.01),
                    }
                )
            symbols.sort(key=lambda s: (not s["open"], s["symbol"]))
            trimmed = symbols[:limit]
            return {"symbols": trimmed, "count": len(trimmed), "source": "MT5_OFFICIAL_PYTHON"}

    def _prepare_symbol(self, mt5_mod: Any, symbol: str) -> Any:
        clean = symbol.strip().upper()
        if not mt5_mod.symbol_select(clean, True):
            raise BridgeError(404, f"Symbol '{clean}' is not available in MT5 Market Watch.")
        sym_info = mt5_mod.symbol_info(clean)
        if sym_info is None:
            raise BridgeError(404, f"Unable to load MT5 symbol_info for '{clean}'.")
        return sym_info

    def get_price(self, symbol: str) -> Dict[str, Any]:
        with self._lock:
            mt5_mod, _, _ = self._require_connected_for_environment()
            sym_info = self._prepare_symbol(mt5_mod, symbol)
            clean = str(_attr(sym_info, "name", symbol)).upper()
            tick = mt5_mod.symbol_info_tick(clean)
            if tick is None:
                raise BridgeError(502, f"No live tick returned by MT5 for '{clean}'.")
            bid = _as_float(_attr(tick, "bid"))
            ask = _as_float(_attr(tick, "ask"))
            last = _as_float(_attr(tick, "last"))
            if (last is None or last == 0.0) and bid is not None and ask is not None:
                last = round((bid + ask) / 2.0, _as_int(_attr(sym_info, "digits"), 5) or 5)
            spread = round(ask - bid, 6) if (bid is not None and ask is not None) else None
            return {
                "symbol": clean,
                "bid": bid,
                "ask": ask,
                "last": last,
                "spread": spread,
                "time": _as_int(_attr(tick, "time")),
                "digits": _as_int(_attr(sym_info, "digits"), 5),
                "tradable": _as_int(_attr(sym_info, "trade_mode"), 4) != 0,
                "source": "MT5_OFFICIAL_PYTHON",
            }

    def get_candles(self, symbol: str, interval_seconds: int = 60, count: int = 100) -> Dict[str, Any]:
        with self._lock:
            mt5_mod, _, _ = self._require_connected_for_environment()
            sym_info = self._prepare_symbol(mt5_mod, symbol)
            clean = str(_attr(sym_info, "name", symbol)).upper()
            tf_map = self._timeframe_map(mt5_mod)
            if interval_seconds not in tf_map:
                raise BridgeError(400, f"Unsupported interval '{interval_seconds}s'. Use 60, 300, 900, 1800, 3600, 14400, or 86400.")
            rates = mt5_mod.copy_rates_from_pos(clean, tf_map[interval_seconds], 0, count)
            if rates is None:
                raise BridgeError(502, f"MT5 returned no historical rates for '{clean}'.")

            candles: List[Dict[str, Any]] = []
            for bar in rates:
                if isinstance(bar, dict):
                    t = _as_int(bar.get("time"), 0)
                    o = _as_float(bar.get("open"), 0.0)
                    h = _as_float(bar.get("high"), 0.0)
                    l = _as_float(bar.get("low"), 0.0)
                    c = _as_float(bar.get("close"), 0.0)
                    v = _as_float(bar.get("tick_volume") or bar.get("real_volume") or bar.get("volume"), 0.0)
                else:
                    # numpy structured array row or named object
                    try:
                        t = int(bar["time"])
                        o = float(bar["open"])
                        h = float(bar["high"])
                        l = float(bar["low"])
                        c = float(bar["close"])
                        v = float(bar["tick_volume"] if "tick_volume" in getattr(bar, "dtype", {}).names else 0.0)
                    except Exception:
                        t = _as_int(_attr(bar, "time"), 0) or 0
                        o = _as_float(_attr(bar, "open"), 0.0) or 0.0
                        h = _as_float(_attr(bar, "high"), 0.0) or 0.0
                        l = _as_float(_attr(bar, "low"), 0.0) or 0.0
                        c = _as_float(_attr(bar, "close"), 0.0) or 0.0
                        v = _as_float(_attr(bar, "tick_volume") or _attr(bar, "volume"), 0.0) or 0.0
                candles.append({"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v})

            return {
                "symbol": clean,
                "interval": interval_seconds,
                "candles": candles,
                "source": "MT5_OFFICIAL_PYTHON",
            }

    def get_positions(self, symbol: Optional[str] = None) -> Dict[str, Any]:
        with self._lock:
            mt5_mod, _, _ = self._require_connected_for_environment()
            raw = mt5_mod.positions_get(symbol=symbol.strip().upper()) if symbol else mt5_mod.positions_get()
            positions: List[Dict[str, Any]] = []
            buy_type = getattr(mt5_mod, "POSITION_TYPE_BUY", 0)
            for p in raw or []:
                p_type = _as_int(_attr(p, "type"), 0)
                positions.append(
                    {
                        "ticket": str(_attr(p, "ticket")),
                        "symbol": str(_attr(p, "symbol", "")),
                        "side": "BUY" if p_type == buy_type else "SELL",
                        "volume": _as_float(_attr(p, "volume"), 0.0),
                        "openPrice": _as_float(_attr(p, "price_open"), 0.0),
                        "currentPrice": _as_float(_attr(p, "price_current")),
                        "profit": _as_float(_attr(p, "profit"), 0.0),
                        "sl": _as_float(_attr(p, "sl"), 0.0),
                        "tp": _as_float(_attr(p, "tp"), 0.0),
                        "openedAt": _iso_from_epoch(_attr(p, "time")),
                        "comment": _attr(p, "comment", ""),
                    }
                )
            return {
                "supported": True,
                "positions": positions,
                "source": "MT5_OFFICIAL_PYTHON",
            }

    def get_history(self, days: int = 14) -> Dict[str, Any]:
        with self._lock:
            mt5_mod, _, mode_label = self._require_connected_for_environment()
            to_dt = datetime.now(timezone.utc) + timedelta(minutes=5)
            from_dt = to_dt - timedelta(days=max(1, min(90, days)))
            deals = mt5_mod.history_deals_get(from_dt, to_dt) or []
            buy_deal = getattr(mt5_mod, "DEAL_TYPE_BUY", 0)
            sell_deal = getattr(mt5_mod, "DEAL_TYPE_SELL", 1)
            trades: List[Dict[str, Any]] = []
            for d in deals:
                dtype = _as_int(_attr(d, "type"))
                if dtype not in (buy_deal, sell_deal):
                    continue
                trades.append(
                    {
                        "ticket": str(_attr(d, "ticket")),
                        "order": str(_attr(d, "order")),
                        "positionId": str(_attr(d, "position_id", "")),
                        "symbol": str(_attr(d, "symbol", "")),
                        "side": "BUY" if dtype == buy_deal else "SELL",
                        "volume": _as_float(_attr(d, "volume"), 0.0),
                        "price": _as_float(_attr(d, "price"), 0.0),
                        "profit": _as_float(_attr(d, "profit"), 0.0),
                        "commission": _as_float(_attr(d, "commission"), 0.0),
                        "swap": _as_float(_attr(d, "swap"), 0.0),
                        "time": _iso_from_epoch(_attr(d, "time")),
                        "comment": _attr(d, "comment", ""),
                    }
                )
            trades.reverse()
            return {
                "supported": True,
                "trades": trades[:150],
                "note": f"Synced {len(trades[:150])} MT5 {mode_label} deal(s) via history_deals_get().",
                "source": "MT5_OFFICIAL_PYTHON",
            }

    def _normalize_volume(self, sym_info: Any, requested_volume: float) -> float:
        vol_min = _as_float(_attr(sym_info, "volume_min"), 0.01) or 0.01
        vol_max = _as_float(_attr(sym_info, "volume_max"), 100.0) or 100.0
        vol_step = _as_float(_attr(sym_info, "volume_step"), 0.01) or 0.01
        clamped = max(vol_min, min(vol_max, float(requested_volume)))
        steps = round((clamped - vol_min) / vol_step)
        normalized = vol_min + steps * vol_step
        normalized = max(vol_min, min(vol_max, normalized))
        return round(normalized, 4)

    def _select_filling_mode(self, mt5_mod: Any, sym_info: Any) -> int:
        filling_mask = _as_int(_attr(sym_info, "filling_mode"), 0) or 0
        fok = getattr(mt5_mod, "ORDER_FILLING_FOK", 0)
        ioc = getattr(mt5_mod, "ORDER_FILLING_IOC", 1)
        ret = getattr(mt5_mod, "ORDER_FILLING_RETURN", 2)
        if filling_mask & 1:
            return fok
        if filling_mask & 2:
            return ioc
        return ret

    def _build_trade_request(
        self,
        mt5_mod: Any,
        sym_info: Any,
        symbol: str,
        side: str,
        order_type: str,
        volume: float,
        price: Optional[float],
        comment: str,
    ) -> tuple[Dict[str, Any], float, int]:
        clean_side = side.strip().upper()
        if clean_side not in ("BUY", "SELL"):
            raise BridgeError(400, f"Invalid side '{side}'. Expected BUY or SELL.")
        clean_type = order_type.strip().upper()
        if clean_type not in ("MARKET", "LIMIT"):
            raise BridgeError(400, f"MT5 does not support orderType '{order_type}'. Use MARKET or LIMIT.")

        sym_trade_mode = _as_int(_attr(sym_info, "trade_mode"), 4)
        if sym_trade_mode == 0:
            raise BridgeError(409, f"Symbol '{symbol}' trading is disabled by broker.")

        tick = mt5_mod.symbol_info_tick(symbol)
        if tick is None:
            raise BridgeError(502, f"Unable to obtain live tick for '{symbol}'.")

        norm_vol = self._normalize_volume(sym_info, volume)
        filling_mode = self._select_filling_mode(mt5_mod, sym_info)
        deviation = _as_int(os.environ.get("MT5_DEFAULT_DEVIATION", "20"), 20) or 20

        if clean_type == "MARKET":
            action = getattr(mt5_mod, "TRADE_ACTION_DEAL", 1)
            mt5_ord_type = (
                getattr(mt5_mod, "ORDER_TYPE_BUY", 0)
                if clean_side == "BUY"
                else getattr(mt5_mod, "ORDER_TYPE_SELL", 1)
            )
            exec_price = _as_float(_attr(tick, "ask") if clean_side == "BUY" else _attr(tick, "bid"))
            if not exec_price or exec_price <= 0:
                raise BridgeError(502, f"Invalid market tick price for '{symbol}'.")
        else:
            if price is None or price <= 0:
                raise BridgeError(400, "LIMIT orders require a positive entry price.")
            action = getattr(mt5_mod, "TRADE_ACTION_PENDING", 5)
            mt5_ord_type = (
                getattr(mt5_mod, "ORDER_TYPE_BUY_LIMIT", 2)
                if clean_side == "BUY"
                else getattr(mt5_mod, "ORDER_TYPE_SELL_LIMIT", 3)
            )
            exec_price = float(price)

        req: Dict[str, Any] = {
            "action": action,
            "symbol": symbol,
            "volume": norm_vol,
            "type": mt5_ord_type,
            "price": exec_price,
            "deviation": deviation,
            "magic": 20260501,
            "comment": (comment or "NovaTrade-Demo")[:31],
            "type_time": getattr(mt5_mod, "ORDER_TIME_GTC", 0),
            "type_filling": filling_mode,
        }
        return req, norm_vol, filling_mode

    def validate_order(
        self,
        *,
        environment: str,
        symbol: str,
        side: str,
        order_type: str,
        volume: float,
        price: Optional[float] = None,
        comment: str = "NovaTrade-Validate",
    ) -> Dict[str, Any]:
        with self._lock:
            env_clean = environment.strip().lower()
            if env_clean not in ("demo", "real"):
                raise BridgeError(400, f"Invalid environment '{environment}'. Use 'demo' or 'real'.")

            mt5_mod, acct, mode_label = self._require_connected_for_environment(env_clean)
            sym_info = self._prepare_symbol(mt5_mod, symbol)
            clean_symbol = str(_attr(sym_info, "name", symbol)).upper()
            req, norm_vol, filling_mode = self._build_trade_request(
                mt5_mod, sym_info, clean_symbol, side, order_type, volume, price, comment
            )

            check_res = mt5_mod.order_check(req)
            if check_res is None:
                err = mt5_mod.last_error() if hasattr(mt5_mod, "last_error") else "order_check returned None"
                return {
                    "valid": False,
                    "compatible": True,
                    "tradeMode": mode_label,
                    "mappedSymbol": clean_symbol,
                    "volume": norm_vol,
                    "fillingMode": filling_mode,
                    "estimatedMargin": None,
                    "freeMargin": _as_float(_attr(acct, "margin_free")),
                    "retcode": None,
                    "comment": f"mt5.order_check() failed: {err}",
                    "source": "MT5_OFFICIAL_ORDER_CHECK",
                }

            retcode = _as_int(_attr(check_res, "retcode"), -1)
            done_code = getattr(mt5_mod, "TRADE_RETCODE_DONE", 10009)
            # In MetaTrader5 Python SDK, order_check returns retcode == 0 or TRADE_RETCODE_DONE on valid request
            is_valid = retcode in (0, done_code)
            return {
                "valid": is_valid,
                "compatible": True,
                "tradeMode": mode_label,
                "mappedSymbol": clean_symbol,
                "volume": norm_vol,
                "fillingMode": filling_mode,
                "estimatedMargin": _as_float(_attr(check_res, "margin")),
                "freeMargin": _as_float(_attr(check_res, "margin_free")),
                "retcode": retcode,
                "comment": str(_attr(check_res, "comment", "Validated") or ("Order check passed" if is_valid else "Rejected")),
                "source": "MT5_OFFICIAL_ORDER_CHECK",
            }

    def place_order(
        self,
        *,
        environment: str,
        symbol: str,
        side: str,
        order_type: str,
        volume: float,
        price: Optional[float] = None,
        comment: str = "NovaTrade",
    ) -> Dict[str, Any]:
        with self._lock:
            env_clean = environment.strip().lower()
            if env_clean not in ("demo", "real"):
                raise BridgeError(400, f"Invalid environment '{environment}'. Use 'demo' or 'real'.")

            mt5_mod, _, mode_label = self._require_connected_for_environment(env_clean)
            sym_info = self._prepare_symbol(mt5_mod, symbol)
            clean_symbol = str(_attr(sym_info, "name", symbol)).upper()
            req, norm_vol, _ = self._build_trade_request(
                mt5_mod, sym_info, clean_symbol, side, order_type, volume, price, comment
            )

            # Mandatory pre-flight mt5.order_check() before order_send()
            check_res = mt5_mod.order_check(req)
            done_code = getattr(mt5_mod, "TRADE_RETCODE_DONE", 10009)
            placed_code = getattr(mt5_mod, "TRADE_RETCODE_PLACED", 10008)
            if check_res is None:
                raise BridgeError(409, "Pre-flight mt5.order_check() returned None; order aborted.")
            check_code = _as_int(_attr(check_res, "retcode"), -1)
            if check_code not in (0, done_code):
                raise BridgeError(
                    409,
                    f"MT5 order_check rejected order (retcode={check_code}): {_attr(check_res, 'comment', 'invalid order')}",
                )

            send_res = mt5_mod.order_send(req)
            if send_res is None:
                err = mt5_mod.last_error() if hasattr(mt5_mod, "last_error") else "order_send returned None"
                raise BridgeError(502, f"mt5.order_send() failed: {err}")

            retcode = _as_int(_attr(send_res, "retcode"), -1)
            accepted = retcode in (done_code, placed_code)
            status = "FILLED" if retcode == done_code else "SUBMITTED" if retcode == placed_code else "REJECTED"
            order_id = _attr(send_res, "order") or _attr(send_res, "deal") or "0"

            return {
                "accepted": accepted,
                "tradeMode": mode_label,
                "orderId": str(order_id),
                "dealId": str(_attr(send_res, "deal", "")),
                "status": status,
                "retcode": retcode,
                "filledPrice": _as_float(_attr(send_res, "price"), req["price"]),
                "volume": _as_float(_attr(send_res, "volume"), norm_vol),
                "message": str(_attr(send_res, "comment", status) or status),
                "source": "MT5_OFFICIAL_PYTHON",
            }

    def place_demo_order(self, **kwargs: Any) -> Dict[str, Any]:
        return self.place_order(**kwargs)

    def get_order_status(self, order_id: str) -> Dict[str, Any]:
        with self._lock:
            mt5_mod, _, mode_label = self._require_connected_for_environment()
            try:
                ticket = int(order_id)
            except ValueError:
                return {"found": False, "status": "UNKNOWN", "note": f"Non-numeric MT5 ticket: {order_id}"}

            open_pos = mt5_mod.positions_get(ticket=ticket) or []
            if open_pos:
                pos = open_pos[0]
                return {
                    "found": True,
                    "status": "FILLED",
                    "filledPrice": _as_float(_attr(pos, "price_open")),
                    "pnl": _as_float(_attr(pos, "profit")),
                    "note": f"Open MT5 {mode_label} position #{ticket}",
                }

            hist_orders = mt5_mod.history_orders_get(ticket=ticket) or []
            if hist_orders:
                ord_obj = hist_orders[0]
                state = _as_int(_attr(ord_obj, "state"), 0)
                filled_state = getattr(mt5_mod, "ORDER_STATE_FILLED", 4)
                canceled_state = getattr(mt5_mod, "ORDER_STATE_CANCELED", 2)
                rejected_state = getattr(mt5_mod, "ORDER_STATE_REJECTED", 5)
                status = (
                    "CLOSED"
                    if state == filled_state
                    else "CANCELLED"
                    if state == canceled_state
                    else "REJECTED"
                    if state == rejected_state
                    else "SUBMITTED"
                )
                return {
                    "found": True,
                    "status": status,
                    "filledPrice": _as_float(_attr(ord_obj, "price_current") or _attr(ord_obj, "price_open")),
                    "pnl": None,
                    "note": f"Historical MT5 {mode_label} order #{ticket} (state={state})",
                }

            return {"found": False, "status": "UNKNOWN", "note": f"Ticket #{ticket} not found in active or recent MT5 {mode_label} state."}
