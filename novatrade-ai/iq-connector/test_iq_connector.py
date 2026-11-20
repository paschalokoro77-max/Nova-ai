"""Unit tests for novatrade-ai/iq-connector/app.py.
Tests mode normalization, PRACTICE/REAL balance mode verification, fail-closed behavior, and order locking.
"""
import asyncio
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from types import ModuleType

# Provide lightweight stubs for fastapi & pydantic if not installed in current environment
if "fastapi" not in sys.modules:
    try:
        import fastapi
    except ModuleNotFoundError:
        class HTTPException(Exception):
            def __init__(self, status_code: int, detail: str = ""):
                self.status_code = status_code
                self.detail = detail
                super().__init__(f"HTTP {status_code}: {detail}")

        class FastAPI:
            def __init__(self, *args, **kwargs):
                pass
            def get(self, *args, **kwargs):
                return lambda fn: fn
            def post(self, *args, **kwargs):
                return lambda fn: fn
            def exception_handler(self, *args, **kwargs):
                return lambda fn: fn

        class Request:
            pass

        class JSONResponse:
            def __init__(self, status_code: int = 200, content=None):
                self.status_code = status_code
                self.content = content

        def Header(*args, **kwargs):
            return None
        def Query(*args, **kwargs):
            return None

        m_fastapi = ModuleType("fastapi")
        m_fastapi.FastAPI = FastAPI
        m_fastapi.Header = Header
        m_fastapi.HTTPException = HTTPException
        m_fastapi.Query = Query
        m_fastapi.Request = Request
        sys.modules["fastapi"] = m_fastapi

        m_fastapi_responses = ModuleType("fastapi.responses")
        m_fastapi_responses.JSONResponse = JSONResponse
        sys.modules["fastapi.responses"] = m_fastapi_responses

if "pydantic" not in sys.modules:
    try:
        import pydantic
    except ModuleNotFoundError:
        class BaseModel:
            def __init__(self, **kwargs):
                for k, v in kwargs.items():
                    setattr(self, k, v)
        def Field(*args, **kwargs):
            return kwargs.get("default", None)
        def field_validator(*args, **kwargs):
            return lambda fn: fn
        m_pydantic = ModuleType("pydantic")
        m_pydantic.BaseModel = BaseModel
        m_pydantic.Field = Field
        m_pydantic.field_validator = field_validator
        sys.modules["pydantic"] = m_pydantic

sys.path.insert(0, str(Path(__file__).resolve().parent))
import app  # noqa: E402


class FakeIqClient:
    def __init__(self, initial_mode="PRACTICE", allow_real_switch=True, candles_rows=None, raise_on_candles=None):
        self.mode = initial_mode
        self.allow_real_switch = allow_real_switch
        self.change_balance_called_with = None
        self.change_balance_calls = []
        self.candles_rows = candles_rows
        self.raise_on_candles = raise_on_candles
        self.buy_calls = []
        self.sell_calls = []
        self.closed_digital_calls = []
        self.open_positions = []
        self.option_outcomes = {}
        self._next_order_id = 50001

    def check_connect(self):
        return True

    def get_balance_mode(self):
        return self.mode

    def change_balance(self, target_mode):
        self.change_balance_called_with = target_mode
        self.change_balance_calls.append(target_mode)
        if target_mode == "REAL" and not self.allow_real_switch:
            self.mode = "PRACTICE"
            return
        self.mode = target_mode

    def get_balance(self):
        return 10000.0 if self.mode == "PRACTICE" else 250.0

    def get_candles(self, symbol, interval, count, endtime):
        if self.raise_on_candles is not None:
            raise self.raise_on_candles
        if self.candles_rows is not None:
            return self.candles_rows
        return [
            {"from": 1700000000, "open": 1.0840, "max": 1.0855, "min": 1.0835, "close": 1.0850, "volume": 12},
            {"from": 1700000060, "open": 1.0850, "max": 1.0862, "min": 1.0848, "close": 1.0860, "volume": 15},
        ]

    def get_currency(self):
        return "USD"

    def get_balances(self):
        return [
            {"id": 1, "type": 1, "amount": 250.0, "currency": "USD"},
            {"id": 2, "type": 4, "amount": 10000.0, "currency": "USD"},
        ]

    def get_profile_ansyc(self):
        return {
            "result": {
                "id": 998877,
                "email": "trader@example.com",
                "name": "Nova Trader",
                "currency": "USD",
                "balance_type": 4 if self.mode == "PRACTICE" else 1,
                "balance_id": 2 if self.mode == "PRACTICE" else 1,
                "is_activated": True,
            }
        }

    def buy(self, amount, symbol, direction, duration_min):
        oid = self._next_order_id
        self._next_order_id += 1
        self.buy_calls.append((amount, symbol, direction, duration_min, self.mode))
        self.open_positions.append({
            "id": oid,
            "active": symbol,
            "direction": direction,
            "amount": amount,
            "open_quote": 1.0860,
            "current_price": 1.0864,
            "pnl": 4.25,
            "open_time": int(time.time()),
            "expiration_time": int(time.time()) + duration_min * 60,
            "instrument_type": "turbo-option",
        })
        return True, oid

    def sell_option(self, order_id):
        self.sell_calls.append(order_id)
        self.open_positions = [p for p in self.open_positions if str(p.get("id")) != str(order_id)]
        return True

    def close_digital_option(self, order_id):
        self.closed_digital_calls.append(order_id)
        self.open_positions = [p for p in self.open_positions if str(p.get("id")) != str(order_id)]
        return True

    def get_positions(self, instrument_type):
        if instrument_type == "turbo-option":
            return True, {"positions": list(self.open_positions)}
        return True, {"positions": []}

    def get_optioninfo_v2(self, count):
        return {"msg": {"closed_options": list(self.option_outcomes.values())}}

    def get_option_history_v2(self, active, count):
        return (
            True,
            {
                "operations": [
                    {
                        "id": 101,
                        "raw_event": {
                            "active": "EURUSD",
                            "dir": "call",
                            "amount": 10.0,
                            "profit": 8.0,
                            "open_quote": 1.0850,
                            "close_quote": 1.0855,
                            "close_time": 1700000000,
                        },
                    }
                ]
            },
        )


class TestIqConnectorModes(unittest.TestCase):
    def setUp(self):
        app._client = None
        app._session_generation = 0
        app._inflight_connect = None
        app._busy_operation = None
        app._last_connect_stage = None
        app._last_connect_duration_ms = None
        app._requested_mode = "AUTO"
        app._confirmed_mode = "PRACTICE"
        app._mode_verified = False
        app._last_error = None
        app._connected_at = None
        app._active_ws_url = None
        app._active_ws_via_proxy = False
        app._last_ws_diagnostics = None
        app._last_candle_check = None
        app._opcodes_updated = False
        app._tracked_orders.clear()
        app._idempotency_index.clear()
        app._invalidate_balance_cache()

    def test_normalize_mode(self):
        self.assertEqual(app._normalize_mode("demo"), "PRACTICE")
        self.assertEqual(app._normalize_mode("practice"), "PRACTICE")
        self.assertEqual(app._normalize_mode("PRACTICE"), "PRACTICE")
        self.assertEqual(app._normalize_mode("real"), "REAL")
        self.assertEqual(app._normalize_mode("REAL"), "REAL")
        self.assertEqual(app._normalize_mode("live"), "REAL")
        self.assertIsNone(app._normalize_mode(None))
        with self.assertRaises(app.HTTPException):
            app._normalize_mode("unsupported_mode")

    def test_resolve_target_mode(self):
        # Default fallback is AUTO (follows live IQ Option active mode)
        self.assertEqual(app._resolve_target_mode(), "AUTO")

        # Header takes precedence
        self.assertEqual(app._resolve_target_mode(x_iq_mode="REAL"), "REAL")
        self.assertEqual(app._resolve_target_mode(x_iq_mode="DEMO"), "PRACTICE")
        self.assertEqual(app._resolve_target_mode(x_iq_mode="AUTO"), "AUTO")

        # Query param
        self.assertEqual(app._resolve_target_mode(query_mode="REAL"), "REAL")

        # Explicit mode param
        self.assertEqual(app._resolve_target_mode(explicit_mode="real"), "REAL")

    def test_ensure_balance_mode_practice(self):
        client = FakeIqClient(initial_mode="PRACTICE")
        active, ok = app._ensure_balance_mode(client, "PRACTICE")
        self.assertTrue(ok)
        self.assertEqual(active, "PRACTICE")
        self.assertEqual(client.change_balance_calls, [])

    def test_ensure_balance_mode_never_silently_switches_mode(self):
        # Even if REAL is expected, connector MUST NOT silently call change_balance()
        client = FakeIqClient(initial_mode="PRACTICE", allow_real_switch=True)
        active, ok = app._ensure_balance_mode(client, "REAL")
        self.assertFalse(ok)
        self.assertEqual(active, "PRACTICE")
        self.assertEqual(client.change_balance_calls, [])

        # When user already switched IQ Option to REAL, AUTO and REAL both verify REAL
        real_client = FakeIqClient(initial_mode="REAL", allow_real_switch=True)
        active_auto, ok_auto = app._ensure_balance_mode(real_client, "AUTO")
        self.assertTrue(ok_auto)
        self.assertEqual(active_auto, "REAL")
        self.assertEqual(real_client.change_balance_calls, [])

    def test_ensure_balance_mode_real_fail_closed(self):
        client = FakeIqClient(initial_mode="PRACTICE", allow_real_switch=False)
        active, ok = app._ensure_balance_mode(client, "REAL")
        self.assertFalse(ok)
        self.assertEqual(active, "PRACTICE")
        self.assertNotEqual(active, "REAL")

    def test_require_verified_mode_raises_on_unverified_real(self):
        client = FakeIqClient(initial_mode="PRACTICE", allow_real_switch=False)
        with self.assertRaises(app.HTTPException) as ctx:
            app._require_verified_mode(client, "REAL")
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("REAL", str(ctx.exception.detail))

    def test_require_verified_mode_passes_on_verified_real(self):
        client = FakeIqClient(initial_mode="REAL", allow_real_switch=True)
        active, ok = app._require_verified_mode(client, "REAL")
        self.assertEqual(active, "REAL")
        self.assertTrue(ok)

    def test_order_placement_in_practice_and_mode_mismatch_guard(self):
        client = FakeIqClient(initial_mode="PRACTICE")
        app._client = client
        req = app.OrderRequest(
            symbol="EURUSD",
            direction="CALL",
            amount=15.0,
            expirySeconds=180,
            expectedMode="PRACTICE",
            idempotencyKey="test-idem-1",
        )
        res = app.place_order(req, x_connector_token=None)
        self.assertTrue(res["accepted"])
        self.assertEqual(res["mode"], "PRACTICE")
        self.assertEqual(res["mappedSymbol"], "EURUSD")
        self.assertEqual(res["direction"], "CALL")
        self.assertEqual(len(client.buy_calls), 1)
        self.assertEqual(client.change_balance_calls, [])

        # Duplicate idempotencyKey returns cached order without double execution
        dup = app.place_order(req, x_connector_token=None)
        self.assertTrue(dup["duplicatePrevented"])
        self.assertEqual(dup["brokerOrderId"], res["brokerOrderId"])
        self.assertEqual(len(client.buy_calls), 1)

        # If caller expected REAL while IQ Option is in PRACTICE, fail closed with HTTP 409
        mismatch_req = app.OrderRequest(
            symbol="EURUSD",
            direction="CALL",
            amount=10.0,
            expirySeconds=180,
            expectedMode="REAL",
            idempotencyKey="test-idem-mismatch",
        )
        with self.assertRaises(app.HTTPException) as ctx:
            app.place_order(mismatch_req, x_connector_token=None)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(client.change_balance_calls, [])

    def test_price_endpoint_returns_latest_close_in_practice(self):
        app._client = FakeIqClient(initial_mode="PRACTICE")
        res = app.latest_price("EUR/USD", mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(res["symbol"], "EURUSD")
        self.assertEqual(res["last"], 1.0860)
        self.assertEqual(res["mode"], "PRACTICE")
        self.assertTrue(res["orderExecutionSupported"])
        self.assertFalse(res["realTradingEnabled"])

    def test_candles_endpoint_returns_normalized_bars(self):
        app._client = FakeIqClient(initial_mode="PRACTICE")
        query = app.CandlesQuery(symbol="EURUSD", interval=60, count=2)
        res = app.candles(query, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(res["symbol"], "EURUSD")
        self.assertEqual(len(res["candles"]), 2)
        self.assertEqual(res["candles"][-1]["close"], 1.0860)
        self.assertTrue(res["orderExecutionSupported"])
        self.assertFalse(res["realTradingEnabled"])

    def test_price_and_candles_handle_upstream_exception_as_json_http_exception(self):
        app._client = FakeIqClient(initial_mode="PRACTICE", raise_on_candles=RuntimeError("WebSocket closed"))
        with self.assertRaises(app.HTTPException) as price_ctx:
            app.latest_price("EURUSD", mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(price_ctx.exception.status_code, 502)

        query = app.CandlesQuery(symbol="EURUSD", interval=60, count=2)
        with self.assertRaises(app.HTTPException) as candle_ctx:
            app.candles(query, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(candle_ctx.exception.status_code, 502)

    def test_price_handles_empty_candles_with_502_json_error(self):
        app._client = FakeIqClient(initial_mode="PRACTICE", candles_rows=[])
        with self.assertRaises(app.HTTPException) as ctx:
            app.latest_price("EURUSD", mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(ctx.exception.status_code, 502)

    def test_health_reports_live_detected_mode_and_trading_capabilities(self):
        app._client = FakeIqClient(initial_mode="PRACTICE")
        res = asyncio.run(app.health(mode=None, x_iq_mode="AUTO"))
        self.assertEqual(res["status"], "running")
        self.assertFalse(res["busy"])
        self.assertTrue(res["connected"])
        self.assertEqual(res["mode"], "PRACTICE")
        self.assertTrue(res["modeFollowsBroker"])
        self.assertTrue(res["orderExecutionSupported"])
        self.assertFalse(res["realTradingEnabled"])

    def test_fetch_candles_safe_handles_unknown_symbol_and_bounded_timeout(self):
        class FakeLowLevelCandles:
            candles_data = None

        class FakeLowLevelApi:
            def __init__(self, populate_rows=False):
                self.candles = FakeLowLevelCandles()
                self.populate_rows = populate_rows

            def getcandles(self, active_id, interval, count, endtime):
                if self.populate_rows:
                    self.candles.candles_data = [
                        {"from": 1700000060, "open": 1.085, "max": 1.086, "min": 1.084, "close": 1.0858, "volume": 9}
                    ]

        class FakeLowLevelClient(FakeIqClient):
            def __init__(self, populate_rows=False):
                super().__init__(initial_mode="PRACTICE")
                self.api = FakeLowLevelApi(populate_rows=populate_rows)

        orig_iq = sys.modules.get("iqoptionapi")
        orig_iq_const = sys.modules.get("iqoptionapi.constants")
        m_iq = ModuleType("iqoptionapi")
        m_const = ModuleType("iqoptionapi.constants")
        m_const.ACTIVES = {"EURUSD": 1}
        sys.modules["iqoptionapi"] = m_iq
        sys.modules["iqoptionapi.constants"] = m_const
        try:
            ok_client = FakeLowLevelClient(populate_rows=True)
            rows = app._fetch_candles_safe(ok_client, "EURUSD", 60, 1, "PRACTICE", timeout_seconds=0.1)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["close"], 1.0858)

            with self.assertRaises(app.HTTPException) as unknown_ctx:
                app._fetch_candles_safe(ok_client, "NOTREALPAIR", 60, 1, "PRACTICE", timeout_seconds=0.05)
            self.assertEqual(unknown_ctx.exception.status_code, 404)

            timeout_client = FakeLowLevelClient(populate_rows=False)
            app._client = timeout_client
            with self.assertRaises(app.HTTPException) as timeout_ctx:
                app._fetch_candles_safe(timeout_client, "EURUSD", 60, 1, "PRACTICE", timeout_seconds=0.05)
            self.assertEqual(timeout_ctx.exception.status_code, 504)
        finally:
            if orig_iq is None:
                sys.modules.pop("iqoptionapi", None)
            else:
                sys.modules["iqoptionapi"] = orig_iq
            if orig_iq_const is None:
                sys.modules.pop("iqoptionapi.constants", None)
            else:
                sys.modules["iqoptionapi.constants"] = orig_iq_const

    def test_endpoints_remain_responsive_under_lock_contention(self):
        app._client = FakeIqClient(initial_mode="PRACTICE")
        app._confirmed_mode = "PRACTICE"
        app._mode_verified = True
        orig_lock_timeout = app._LOCK_ACQUIRE_TIMEOUT
        app._LOCK_ACQUIRE_TIMEOUT = 0.05

        lock_acquired = threading.Event()
        release_lock = threading.Event()

        def hold_lock():
            app._lock.acquire()
            try:
                lock_acquired.set()
                release_lock.wait(timeout=2.0)
            finally:
                app._lock.release()

        holder = threading.Thread(target=hold_lock, daemon=True)
        holder.start()
        self.assertTrue(lock_acquired.wait(timeout=1.0))
        try:
            # /health must return immediately (<0.2s) with busy=True even while _lock is held
            t0 = time.monotonic()
            health_res = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
            elapsed_health = time.monotonic() - t0
            self.assertLess(elapsed_health, 0.25)
            self.assertEqual(health_res["status"], "running")
            self.assertTrue(health_res["busy"])
            self.assertTrue(health_res["orderExecutionSupported"])
            self.assertFalse(health_res["realTradingEnabled"])

            # /balance, /price, and /candles must fail fast with HTTP 503 instead of hanging
            with self.assertRaises(app.HTTPException) as bal_ctx:
                app.balance(mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(bal_ctx.exception.status_code, 503)

            with self.assertRaises(app.HTTPException) as price_ctx:
                app.latest_price("EURUSD", mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(price_ctx.exception.status_code, 503)

            q = app.CandlesQuery(symbol="EURUSD", interval=60, count=2)
            with self.assertRaises(app.HTTPException) as candle_ctx:
                app.candles(q, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(candle_ctx.exception.status_code, 503)
        finally:
            release_lock.set()
            holder.join(timeout=1.0)
            app._LOCK_ACQUIRE_TIMEOUT = orig_lock_timeout

        # After lock release, all endpoints recover immediately
        bal_ok = app.balance(mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(bal_ok["balance"], 10000.0)
        self.assertTrue(bal_ok["orderExecutionSupported"])
        self.assertFalse(bal_ok["realTradingEnabled"])

    def test_hanging_balance_and_candles_timeout_and_release_lock(self):
        release_blocker = threading.Event()

        class HangingClient(FakeIqClient):
            def get_balance(self):
                release_blocker.wait(timeout=3.0)
                return 10000.0

            def get_candles(self, symbol, interval, count, endtime):
                release_blocker.wait(timeout=3.0)
                return []

        orig_bal_timeout = app._BALANCE_TIMEOUT
        orig_candle_timeout = app._CANDLES_TIMEOUT
        app._BALANCE_TIMEOUT = 0.08
        app._CANDLES_TIMEOUT = 0.08
        app._client = HangingClient(initial_mode="PRACTICE")
        try:
            t0 = time.monotonic()
            with self.assertRaises(app.HTTPException) as bal_ctx:
                app.balance(mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(bal_ctx.exception.status_code, 504)
            self.assertLess(time.monotonic() - t0, 1.0)

            t1 = time.monotonic()
            with self.assertRaises(app.HTTPException) as price_ctx:
                app.latest_price("EURUSD", mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(price_ctx.exception.status_code, 504)
            self.assertLess(time.monotonic() - t1, 1.0)

            t2 = time.monotonic()
            q = app.CandlesQuery(symbol="EURUSD", interval=60, count=2)
            with self.assertRaises(app.HTTPException) as candle_ctx:
                app.candles(q, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(candle_ctx.exception.status_code, 504)
            self.assertLess(time.monotonic() - t2, 1.0)

            # Confirm _lock is guaranteed released and /health responds immediately
            other_acquired = []

            def probe_lock():
                got = app._lock.acquire(blocking=False)
                if got:
                    app._lock.release()
                other_acquired.append(got)

            t = threading.Thread(target=probe_lock)
            t.start()
            t.join(timeout=1.0)
            self.assertEqual(other_acquired, [True])

            health_res = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
            self.assertEqual(health_res["status"], "running")
            self.assertFalse(health_res["busy"])
        finally:
            release_blocker.set()
            app._BALANCE_TIMEOUT = orig_bal_timeout
            app._CANDLES_TIMEOUT = orig_candle_timeout

    def test_dead_websocket_thread_detected_and_close_is_bounded(self):
        class DeadWsApi:
            def websocket_alive(self):
                return False

            class _WsClient:
                class _Wss:
                    def close(self):
                        pass
                wss = _Wss()

            websocket_client = _WsClient()

            class _HangingThread:
                def join(self, timeout=None):
                    if timeout is None:
                        time.sleep(5.0)
                    else:
                        time.sleep(min(timeout, 0.02))

            websocket_thread = _HangingThread()

        class DeadWsClient(FakeIqClient):
            def __init__(self):
                super().__init__(initial_mode="PRACTICE")
                self.api = DeadWsApi()

        dead_client = DeadWsClient()
        app._client = dead_client
        self.assertFalse(app._is_client_alive(dead_client))

        health_res = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
        self.assertEqual(health_res["status"], "running")
        self.assertFalse(health_res["connected"])

        t0 = time.monotonic()
        app._safe_close_client(dead_client, timeout_seconds=0.05)
        self.assertLess(time.monotonic() - t0, 0.5)

    def test_patch_iqoptionapi_prevents_ssl_lock_leaks_and_untimed_close(self):
        saved_modules = {}
        module_names = [
            "requests",
            "iqoptionapi",
            "iqoptionapi.global_value",
            "iqoptionapi.api",
            "iqoptionapi.stable_api",
            "iqoptionapi.ws",
            "iqoptionapi.ws.client",
        ]
        for name in module_names:
            saved_modules[name] = sys.modules.get(name)

        orig_patched = app._iqoptionapi_patched
        app._iqoptionapi_patched = False

        try:
            m_req = ModuleType("requests")
            m_req.utils = type("U", (), {"add_dict_to_cookiejar": staticmethod(lambda *a, **k: None)})()

            m_iq = ModuleType("iqoptionapi")
            m_gv = ModuleType("iqoptionapi.global_value")
            m_gv.ssl_Mutual_exclusion = False
            m_gv.ssl_Mutual_exclusion_write = False
            m_gv.check_websocket_if_connect = 1
            m_gv.check_websocket_if_error = False
            m_gv.websocket_error_reason = None
            m_gv.SSID = None
            m_gv.balance_id = None

            class StubWebsocketClient:
                def on_message(self, message):
                    m_gv.ssl_Mutual_exclusion = True
                    raise ValueError("Malformed frame")

            class StubIQOptionAPI:
                def __init__(self, *args, **kwargs):
                    self.session = type("S", (), {"request": lambda *_a, **_k: None})()
                    self.websocket_client = None
                    self.websocket_thread = None

                @property
                def websocket(self):
                    return self._wss

            class StubIQOption:
                def connect(self):
                    return True, None

            m_api = ModuleType("iqoptionapi.api")
            m_api.IQOptionAPI = StubIQOptionAPI
            m_stable = ModuleType("iqoptionapi.stable_api")
            m_stable.IQ_Option = StubIQOption
            m_ws = ModuleType("iqoptionapi.ws")
            m_ws_client = ModuleType("iqoptionapi.ws.client")
            m_ws_client.WebsocketClient = StubWebsocketClient

            sys.modules["requests"] = m_req
            sys.modules["iqoptionapi"] = m_iq
            sys.modules["iqoptionapi.global_value"] = m_gv
            sys.modules["iqoptionapi.api"] = m_api
            sys.modules["iqoptionapi.stable_api"] = m_stable
            sys.modules["iqoptionapi.ws"] = m_ws
            sys.modules["iqoptionapi.ws.client"] = m_ws_client

            app._patch_iqoptionapi()
            self.assertTrue(app._iqoptionapi_patched)

            # 1. on_message exception MUST still clear ssl_Mutual_exclusion
            ws_client = StubWebsocketClient()
            with self.assertRaises(ValueError):
                ws_client.on_message("bad")
            self.assertFalse(m_gv.ssl_Mutual_exclusion)

            # 2. send_websocket_request failure MUST still clear ssl_Mutual_exclusion_write
            api_inst = StubIQOptionAPI()

            class FailingWss:
                def send(self, _data):
                    raise OSError("Broken pipe")

                def close(self):
                    pass

            api_inst._wss = FailingWss()
            with self.assertRaises(OSError):
                api_inst.send_websocket_request("test", {})
            self.assertFalse(m_gv.ssl_Mutual_exclusion_write)

            # 3. close() MUST pass a finite timeout to websocket_thread.join and reset connect flag
            join_timeouts = []

            class SpyThread:
                def join(self, timeout=None):
                    join_timeouts.append(timeout)

            api_inst.websocket_client = type("WC", (), {"wss": FailingWss()})()
            api_inst.websocket_thread = SpyThread()
            m_gv.check_websocket_if_connect = 1
            api_inst.close()
            self.assertEqual(len(join_timeouts), 1)
            self.assertIsNotNone(join_timeouts[0])
            self.assertGreater(join_timeouts[0], 0)
            self.assertEqual(m_gv.check_websocket_if_connect, 0)
        finally:
            app._iqoptionapi_patched = orig_patched
            for name, mod in saved_modules.items():
                if mod is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = mod

    def _with_patched_ws_stubs(self, ws_behavior):
        """Helper context installing minimal iqoptionapi/websocket stubs and returning (api_inst, records)."""
        saved_modules = {}
        module_names = [
            "requests",
            "websocket",
            "iqoptionapi",
            "iqoptionapi.global_value",
            "iqoptionapi.api",
            "iqoptionapi.stable_api",
            "iqoptionapi.ws",
            "iqoptionapi.ws.client",
        ]
        for name in module_names:
            saved_modules[name] = sys.modules.get(name)

        records = {
            "setdefaulttimeout_calls": [],
            "ws_attempts": [],
            "close_calls": 0,
        }

        m_req = ModuleType("requests")
        m_req.utils = type("U", (), {"add_dict_to_cookiejar": staticmethod(lambda *a, **k: None)})()

        m_ws_lib = ModuleType("websocket")

        def _setdefaulttimeout(t):
            records["setdefaulttimeout_calls"].append(t)

        m_ws_lib.setdefaulttimeout = _setdefaulttimeout

        m_iq = ModuleType("iqoptionapi")
        m_gv = ModuleType("iqoptionapi.global_value")
        m_gv.ssl_Mutual_exclusion = False
        m_gv.ssl_Mutual_exclusion_write = False
        m_gv.check_websocket_if_connect = None
        m_gv.check_websocket_if_error = False
        m_gv.websocket_error_reason = None
        m_gv.SSID = None
        m_gv.balance_id = None

        class SpyWss:
            def __init__(self, url):
                self.url = url
                self.header = None
                self.closed = False

            def run_forever(self, **kwargs):
                records["ws_attempts"].append(
                    {
                        "url": self.url,
                        "header": list(self.header) if isinstance(self.header, list) else self.header,
                        "kwargs": dict(kwargs),
                    }
                )
                ws_behavior(self.url, m_gv, self)

            def close(self):
                self.closed = True
                records["close_calls"] += 1

        class StubWebsocketClient:
            def __init__(self, api):
                self.api = api
                self.wss = SpyWss(api.wss_url)

            def on_message(self, message):
                return None

        class StubIQOptionAPI:
            def __init__(self):
                self.session = type("S", (), {"request": lambda *_a, **_k: None})()
                self.wss_url = app._WS_PRIMARY_URL
                self.websocket_client = None
                self.websocket_thread = None

            @property
            def websocket(self):
                return self.websocket_client.wss

        class StubIQOption:
            def connect(self):
                return True, None

        m_api = ModuleType("iqoptionapi.api")
        m_api.IQOptionAPI = StubIQOptionAPI
        m_stable = ModuleType("iqoptionapi.stable_api")
        m_stable.IQ_Option = StubIQOption
        m_ws = ModuleType("iqoptionapi.ws")
        m_ws_client = ModuleType("iqoptionapi.ws.client")
        m_ws_client.WebsocketClient = StubWebsocketClient

        sys.modules["requests"] = m_req
        sys.modules["websocket"] = m_ws_lib
        sys.modules["iqoptionapi"] = m_iq
        sys.modules["iqoptionapi.global_value"] = m_gv
        sys.modules["iqoptionapi.api"] = m_api
        sys.modules["iqoptionapi.stable_api"] = m_stable
        sys.modules["iqoptionapi.ws"] = m_ws
        sys.modules["iqoptionapi.ws.client"] = m_ws_client

        orig_patched = app._iqoptionapi_patched
        app._iqoptionapi_patched = False
        app._patch_iqoptionapi()

        def cleanup():
            app._iqoptionapi_patched = orig_patched
            for name, mod in saved_modules.items():
                if mod is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = mod

        return StubIQOptionAPI(), records, cleanup

    def test_ws_primary_connection_success_headers_and_no_cacert(self):
        probe_calls = []
        orig_probe = app._probe_ws_endpoint
        orig_env_ws = os.environ.pop("IQ_WS_URL", None)

        def fake_probe(ws_url, timeout_seconds=None, include_upgrade=False):
            probe_calls.append(ws_url)
            return {
                "url": ws_url,
                "host": "iqoption.com",
                "port": 443,
                "ok": True,
                "stage": "ok",
                "resolvedIps": ["45.88.36.129"],
                "dnsMs": 10.0,
                "tcpMs": 12.0,
                "tlsMs": 15.0,
                "upgradeMs": None,
                "tlsVersion": "TLSv1.3",
                "httpStatus": None,
                "error": None,
            }

        def ws_open_immediately(_url, gv, _wss):
            gv.check_websocket_if_connect = 1

        api_inst, records, cleanup = self._with_patched_ws_stubs(ws_open_immediately)
        app._probe_ws_endpoint = fake_probe
        try:
            ok, reason = api_inst.start_websocket()
            self.assertTrue(ok)
            self.assertIsNone(reason)
            self.assertEqual(probe_calls, [app._WS_PRIMARY_URL])
            self.assertEqual(len(records["ws_attempts"]), 1)
            attempt = records["ws_attempts"][0]
            self.assertEqual(attempt["url"], app._WS_PRIMARY_URL)
            # Explicit Origin and User-Agent headers must be passed
            self.assertEqual(attempt["kwargs"].get("origin"), app._WS_ORIGIN)
            self.assertIn(f"User-Agent: {app._WS_USER_AGENT}", attempt["header"])
            # Nonexistent cacert.pem MUST NOT be passed in sslopt
            sslopt = attempt["kwargs"].get("sslopt") or {}
            self.assertNotIn("ca_certs", sslopt)
            self.assertFalse(sslopt.get("check_hostname"))
            self.assertEqual(app._active_ws_url, app._WS_PRIMARY_URL)
            self.assertEqual(records["setdefaulttimeout_calls"], [app._WS_CONNECT_TIMEOUT])
        finally:
            app._probe_ws_endpoint = orig_probe
            if orig_env_ws is not None:
                os.environ["IQ_WS_URL"] = orig_env_ws
            cleanup()

    def test_ws_fallback_succeeds_when_primary_fails(self):
        probe_calls = []
        orig_probe = app._probe_ws_endpoint
        orig_env_ws = os.environ.pop("IQ_WS_URL", None)

        def fake_probe(ws_url, timeout_seconds=None, include_upgrade=False):
            probe_calls.append(ws_url)
            if ws_url == app._WS_PRIMARY_URL:
                return {
                    "url": ws_url,
                    "host": "iqoption.com",
                    "port": 443,
                    "ok": False,
                    "stage": "tcp",
                    "resolvedIps": ["45.88.36.129"],
                    "dnsMs": 12.0,
                    "tcpMs": 6000.0,
                    "tlsMs": None,
                    "upgradeMs": None,
                    "tlsVersion": None,
                    "httpStatus": None,
                    "error": "TCP connect timed out to iqoption.com (45.88.36.129:443) after 6.0s.",
                }
            return {
                "url": ws_url,
                "host": "ws.iqoption.com",
                "port": 443,
                "ok": True,
                "stage": "ok",
                "resolvedIps": ["104.18.16.240"],
                "dnsMs": 5.0,
                "tcpMs": 4.0,
                "tlsMs": 8.0,
                "upgradeMs": None,
                "tlsVersion": "TLSv1.3",
                "httpStatus": None,
                "error": None,
            }

        def ws_open_on_fallback(url, gv, _wss):
            if url == app._WS_FALLBACK_URL:
                gv.check_websocket_if_connect = 1

        api_inst, records, cleanup = self._with_patched_ws_stubs(ws_open_on_fallback)
        app._probe_ws_endpoint = fake_probe
        try:
            ok, reason = api_inst.start_websocket()
            self.assertTrue(ok)
            self.assertIsNone(reason)
            self.assertEqual(probe_calls, [app._WS_PRIMARY_URL, app._WS_FALLBACK_URL])
            self.assertEqual(len(records["ws_attempts"]), 1)
            self.assertEqual(records["ws_attempts"][0]["url"], app._WS_FALLBACK_URL)
            self.assertEqual(api_inst.wss_url, app._WS_FALLBACK_URL)
            self.assertEqual(app._active_ws_url, app._WS_FALLBACK_URL)
            self.assertEqual(len(app._last_ws_diagnostics), 2)
            self.assertEqual(app._last_ws_diagnostics[0]["stage"], "tcp")
            self.assertEqual(app._last_ws_diagnostics[1]["stage"], "ok")
        finally:
            app._probe_ws_endpoint = orig_probe
            if orig_env_ws is not None:
                os.environ["IQ_WS_URL"] = orig_env_ws
            cleanup()

    def test_ws_both_endpoints_failing_reports_stage_diagnostics(self):
        orig_probe = app._probe_ws_endpoint
        orig_env_ws = os.environ.pop("IQ_WS_URL", None)

        def fake_probe(ws_url, timeout_seconds=None, include_upgrade=False):
            if ws_url == app._WS_PRIMARY_URL:
                return {
                    "url": ws_url,
                    "host": "iqoption.com",
                    "port": 443,
                    "ok": False,
                    "stage": "dns",
                    "resolvedIps": [],
                    "dnsMs": 15.0,
                    "tcpMs": None,
                    "tlsMs": None,
                    "upgradeMs": None,
                    "tlsVersion": None,
                    "httpStatus": None,
                    "error": "DNS lookup failed for iqoption.com: gaierror",
                }
            return {
                "url": ws_url,
                "host": "ws.iqoption.com",
                "port": 443,
                "ok": False,
                "stage": "tls",
                "resolvedIps": ["104.18.16.240"],
                "dnsMs": 5.0,
                "tcpMs": 6.0,
                "tlsMs": 20.0,
                "upgradeMs": None,
                "tlsVersion": None,
                "httpStatus": None,
                "error": "TLS handshake failed for ws.iqoption.com: SSLError",
            }

        api_inst, records, cleanup = self._with_patched_ws_stubs(lambda *_a: None)
        app._probe_ws_endpoint = fake_probe
        try:
            ok, reason = api_inst.start_websocket()
            self.assertFalse(ok)
            self.assertIsNotNone(reason)
            self.assertIn(app._WS_PRIMARY_URL, reason)
            self.assertIn("[dns:", reason)
            self.assertIn(app._WS_FALLBACK_URL, reason)
            self.assertIn("[tls:", reason)
            self.assertIsNone(app._active_ws_url)
            self.assertEqual(len(records["ws_attempts"]), 0)
            self.assertEqual(len(app._last_ws_diagnostics), 2)
        finally:
            app._probe_ws_endpoint = orig_probe
            if orig_env_ws is not None:
                os.environ["IQ_WS_URL"] = orig_env_ws
            cleanup()

    def test_ws_timeout_handling_and_six_second_default(self):
        # Default socket connect timeout must be strictly 6.0 seconds
        self.assertEqual(app._WS_CONNECT_TIMEOUT, 6.0)

        orig_ws_timeout = app._WS_CONNECT_TIMEOUT
        orig_close_timeout = app._CLOSE_TIMEOUT
        orig_probe = app._probe_ws_endpoint
        orig_env_ws = os.environ.pop("IQ_WS_URL", None)
        release_hang = threading.Event()

        def fake_probe(ws_url, timeout_seconds=None, include_upgrade=False):
            return {
                "url": ws_url,
                "host": "host",
                "port": 443,
                "ok": True,
                "stage": "ok",
                "resolvedIps": ["1.2.3.4"],
                "dnsMs": 2.0,
                "tcpMs": 2.0,
                "tlsMs": 2.0,
                "upgradeMs": None,
                "tlsVersion": "TLSv1.3",
                "httpStatus": None,
                "error": None,
            }

        def ws_hang_upgrade(_url, _gv, _wss):
            release_hang.wait(timeout=2.0)

        api_inst, records, cleanup = self._with_patched_ws_stubs(ws_hang_upgrade)
        app._probe_ws_endpoint = fake_probe
        app._WS_CONNECT_TIMEOUT = 0.08
        app._CLOSE_TIMEOUT = 0.05
        try:
            t0 = time.monotonic()
            ok, reason = api_inst.start_websocket()
            elapsed = time.monotonic() - t0
            self.assertFalse(ok)
            self.assertLess(elapsed, 1.0)
            self.assertIn("[ws_upgrade:", reason)
            self.assertIn("timed out", reason.lower())
            self.assertEqual(len(records["ws_attempts"]), 2)
            self.assertGreaterEqual(records["close_calls"], 2)
            self.assertEqual(records["setdefaulttimeout_calls"], [0.08])
        finally:
            release_hang.set()
            app._WS_CONNECT_TIMEOUT = orig_ws_timeout
            app._CLOSE_TIMEOUT = orig_close_timeout
            app._probe_ws_endpoint = orig_probe
            if orig_env_ws is not None:
                os.environ["IQ_WS_URL"] = orig_env_ws
            cleanup()

    def test_network_check_enforces_auth_and_returns_stage_diagnostics(self):
        orig_token = os.environ.get("IQ_CONNECTOR_TOKEN")
        orig_probe_ws = app._probe_ws_endpoint
        orig_probe_https = app._probe_https_endpoint
        os.environ["IQ_CONNECTOR_TOKEN"] = "secret-diag-token"

        def fake_ws_probe(url, timeout_seconds=None, include_upgrade=False):
            return {
                "url": url,
                "ok": url == app._WS_FALLBACK_URL,
                "stage": "ok" if url == app._WS_FALLBACK_URL else "tcp",
                "httpStatus": 101 if url == app._WS_FALLBACK_URL else None,
                "error": None if url == app._WS_FALLBACK_URL else "TCP connect timed out",
            }

        def fake_https_probe(url, timeout_seconds=None):
            return {"url": url, "ok": True, "stage": "ok", "tlsVersion": "TLSv1.3", "error": None}

        app._probe_ws_endpoint = fake_ws_probe
        app._probe_https_endpoint = fake_https_probe
        try:
            with self.assertRaises(app.HTTPException) as unauth_ctx:
                asyncio.run(app.network_check(x_connector_token="wrong-token"))
            self.assertEqual(unauth_ctx.exception.status_code, 401)

            res = asyncio.run(app.network_check(x_connector_token="secret-diag-token"))
            self.assertEqual(res["status"], "ok")
            self.assertEqual(res["timeoutSeconds"], app._WS_CONNECT_TIMEOUT)
            self.assertEqual(len(res["wsEndpoints"]), 2)
            self.assertEqual(res["wsEndpoints"][0]["url"], app._WS_PRIMARY_URL)
            self.assertEqual(res["wsEndpoints"][0]["stage"], "tcp")
            self.assertEqual(res["wsEndpoints"][1]["url"], app._WS_FALLBACK_URL)
            self.assertEqual(res["wsEndpoints"][1]["httpStatus"], 101)
            self.assertTrue(res["authEndpoint"]["ok"])
            self.assertTrue(res["orderExecutionSupported"])
            self.assertFalse(res["realTradingEnabled"])
        finally:
            app._probe_ws_endpoint = orig_probe_ws
            app._probe_https_endpoint = orig_probe_https
            if orig_token is None:
                os.environ.pop("IQ_CONNECTOR_TOKEN", None)
            else:
                os.environ["IQ_CONNECTOR_TOKEN"] = orig_token

    def _with_patched_http_auth_stubs(self, get_ssid_behavior=None):
        """Helper installing stubs for IQOptionAPI HTTP session, HTTPAdapter, and auth flow."""
        saved_modules = {}
        module_names = [
            "requests",
            "requests.adapters",
            "websocket",
            "iqoptionapi",
            "iqoptionapi.global_value",
            "iqoptionapi.api",
            "iqoptionapi.stable_api",
            "iqoptionapi.ws",
            "iqoptionapi.ws.client",
        ]
        for name in module_names:
            saved_modules[name] = sys.modules.get(name)

        records = {
            "request_calls": [],
            "mounted_adapters": {},
            "get_ssid_calls": 0,
            "ws_attempts": [],
            "close_calls": 0,
        }

        class StubHTTPAdapter:
            def __init__(self, pool_connections=10, pool_maxsize=10, max_retries=0):
                self.pool_connections = pool_connections
                self.pool_maxsize = pool_maxsize
                self.max_retries = max_retries

        m_req = ModuleType("requests")
        m_req.utils = type("U", (), {"add_dict_to_cookiejar": staticmethod(lambda *a, **k: None)})()
        m_req_adapters = ModuleType("requests.adapters")
        m_req_adapters.HTTPAdapter = StubHTTPAdapter
        m_req.adapters = m_req_adapters

        m_ws_lib = ModuleType("websocket")
        m_ws_lib.setdefaulttimeout = lambda _t: None

        m_iq = ModuleType("iqoptionapi")
        m_gv = ModuleType("iqoptionapi.global_value")
        m_gv.ssl_Mutual_exclusion = False
        m_gv.ssl_Mutual_exclusion_write = False
        m_gv.check_websocket_if_connect = None
        m_gv.check_websocket_if_error = False
        m_gv.websocket_error_reason = None
        m_gv.SSID = None
        m_gv.balance_id = None

        class StubSession:
            def __init__(self):
                self.verify = False  # Mirrors upstream iqoptionapi default
                self.trust_env = True
                self.cookies = {}

            def mount(self, prefix, adapter):
                records["mounted_adapters"][prefix] = adapter

            def request(self, *args, **kwargs):
                records["request_calls"].append({"args": args, "kwargs": dict(kwargs)})
                return {"ok": True}

        class SpyWss:
            def __init__(self, url):
                self.url = url
                self.header = None

            def run_forever(self, **kwargs):
                records["ws_attempts"].append({"url": self.url, "kwargs": dict(kwargs)})
                m_gv.check_websocket_if_connect = 1

            def close(self):
                records["close_calls"] += 1

        class StubWebsocketClient:
            def __init__(self, api):
                self.api = api
                self.wss = SpyWss(api.wss_url)

            def on_message(self, message):
                return None

        class StubIQOptionAPI:
            def __init__(self, host="iqoption.com", username="trader@example.com", password="iq-secret-password", proxies=None):
                self.host = host
                self.username = username
                self.password = password
                self.wss_url = app._WS_PRIMARY_URL
                self.session = StubSession()
                self.proxies = proxies
                self.websocket_client = None
                self.websocket_thread = None
                self.profile = type("P", (), {"msg": None})()
                self.timesync = type("T", (), {"server_timestamp": None})()

            @property
            def websocket(self):
                return self.websocket_client.wss

            def get_ssid(self):
                records["get_ssid_calls"] += 1
                if get_ssid_behavior is not None:
                    return get_ssid_behavior(self)
                return type("Resp", (), {"status_code": 200, "cookies": {"ssid": "sid-123"}, "text": "ok"})()

            def ssid(self, _val):
                self.profile.msg = {"balances": []}

        class StubIQOption:
            def connect(self):
                return True, None

        m_api = ModuleType("iqoptionapi.api")
        m_api.IQOptionAPI = StubIQOptionAPI
        m_stable = ModuleType("iqoptionapi.stable_api")
        m_stable.IQ_Option = StubIQOption
        m_ws = ModuleType("iqoptionapi.ws")
        m_ws_client = ModuleType("iqoptionapi.ws.client")
        m_ws_client.WebsocketClient = StubWebsocketClient

        sys.modules["requests"] = m_req
        sys.modules["requests.adapters"] = m_req_adapters
        sys.modules["websocket"] = m_ws_lib
        sys.modules["iqoptionapi"] = m_iq
        sys.modules["iqoptionapi.global_value"] = m_gv
        sys.modules["iqoptionapi.api"] = m_api
        sys.modules["iqoptionapi.stable_api"] = m_stable
        sys.modules["iqoptionapi.ws"] = m_ws
        sys.modules["iqoptionapi.ws.client"] = m_ws_client

        orig_patched = app._iqoptionapi_patched
        app._iqoptionapi_patched = False
        app._patch_iqoptionapi()

        def cleanup():
            app._iqoptionapi_patched = orig_patched
            for name, mod in saved_modules.items():
                if mod is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = mod

        return StubIQOptionAPI, m_gv, records, cleanup

    def test_proxy_disabled_by_default_and_direct_connection_preserved(self):
        saved_env = {k: os.environ.get(k) for k in ("IQ_PROXY_URL", "IQ_PROXY_WS", "HTTPS_PROXY")}
        os.environ.pop("IQ_PROXY_URL", None)
        os.environ.pop("IQ_PROXY_WS", None)
        # Even if ambient HTTPS_PROXY exists, proxy must remain opt-in/disabled by default
        os.environ["HTTPS_PROXY"] = "http://ambient-should-be-ignored.local:8080"

        api_cls, _gv, records, cleanup = self._with_patched_http_auth_stubs()
        try:
            self.assertIsNone(app._get_proxy_url())
            self.assertIsNone(app._get_requests_proxies())
            self.assertFalse(app._is_ws_proxy_enabled())
            self.assertEqual(app._get_ws_proxy_kwargs(), {})

            api_inst = api_cls()
            self.assertIsNone(api_inst.proxies)
            self.assertFalse(api_inst.session.trust_env)
            self.assertTrue(api_inst.session.verify)
            self.assertIn("https://", records["mounted_adapters"])
            self.assertEqual(records["mounted_adapters"]["https://"].max_retries, 0)

            api_inst.session.request("POST", app._AUTH_LOGIN_URL, verify=False)
            self.assertEqual(len(records["request_calls"]), 1)
            req_kw = records["request_calls"][0]["kwargs"]
            # Certificate verification must stay enforced even if caller passed verify=False
            self.assertTrue(req_kw["verify"])
            self.assertEqual(req_kw["timeout"], (app._HTTP_CONNECT_TIMEOUT, app._HTTP_TIMEOUT))
            self.assertNotIn("proxies", req_kw)

            health_res = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
            self.assertFalse(health_res["proxyConfigured"])
            self.assertFalse(health_res["wsProxyEnabled"])
            self.assertTrue(health_res["orderExecutionSupported"])
            self.assertFalse(health_res["realTradingEnabled"])
        finally:
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            cleanup()

    def test_proxy_opt_in_routes_http_with_verified_tls_and_keeps_ws_direct_by_default(self):
        saved_env = {k: os.environ.get(k) for k in ("IQ_PROXY_URL", "IQ_PROXY_WS", "IQ_WS_URL")}
        proxy_url = "http://eu_user:MyProxySecret123@eu-proxy.example:8443"
        os.environ["IQ_PROXY_URL"] = proxy_url
        os.environ.pop("IQ_PROXY_WS", None)
        os.environ.pop("IQ_WS_URL", None)

        orig_probe = app._probe_ws_endpoint
        api_cls, _gv, records, cleanup = self._with_patched_http_auth_stubs()
        app._probe_ws_endpoint = lambda ws_url, timeout_seconds=None, include_upgrade=False, verify_tls=False: {
            "url": ws_url,
            "host": "iqoption.com",
            "port": 443,
            "ok": True,
            "stage": "ok",
            "resolvedIps": ["45.88.36.129"],
            "dnsMs": 5.0,
            "tcpMs": 5.0,
            "tlsMs": 8.0,
            "upgradeMs": None,
            "tlsVersion": "TLSv1.3",
            "httpStatus": None,
            "error": None,
        }
        try:
            api_inst = api_cls()
            self.assertEqual(api_inst.proxies, {"http": proxy_url, "https": proxy_url})
            self.assertTrue(api_inst.session.verify)
            self.assertFalse(api_inst.session.trust_env)

            api_inst.session.request("POST", app._AUTH_LOGIN_URL)
            req_kw = records["request_calls"][0]["kwargs"]
            self.assertTrue(req_kw["verify"])
            self.assertEqual(req_kw["proxies"], {"http": proxy_url, "https": proxy_url})
            self.assertEqual(req_kw["timeout"], (app._HTTP_CONNECT_TIMEOUT, app._HTTP_TIMEOUT))

            # WebSocket MUST remain direct by default even when IQ_PROXY_URL is set
            self.assertFalse(app._is_ws_proxy_enabled())
            ok, reason = api_inst.start_websocket()
            self.assertTrue(ok)
            self.assertIsNone(reason)
            self.assertEqual(len(records["ws_attempts"]), 1)
            ws_kw = records["ws_attempts"][0]["kwargs"]
            self.assertNotIn("http_proxy_host", ws_kw)
            self.assertNotIn("http_proxy_port", ws_kw)
            self.assertNotIn("http_proxy_auth", ws_kw)

            # /health exposes only safe boolean flags and never proxy URL/credentials
            health_res = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
            self.assertTrue(health_res["proxyConfigured"])
            self.assertFalse(health_res["wsProxyEnabled"])
            self.assertNotIn("MyProxySecret123", str(health_res))
            self.assertNotIn("eu_user", str(health_res))

            # Invalid proxy scheme fails closed without echoing credentials
            os.environ["IQ_PROXY_URL"] = "ftp://leak_user:leak_pass@bad.example:21"
            with self.assertRaises(ValueError) as bad_ctx:
                app._get_proxy_url()
            self.assertNotIn("leak_pass", str(bad_ctx.exception))
            self.assertNotIn("leak_user", str(bad_ctx.exception))
        finally:
            app._probe_ws_endpoint = orig_probe
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            cleanup()

    def test_auth_failures_classify_errors_and_never_switch_auth_host(self):
        orig_probe = app._probe_ws_endpoint
        app._probe_ws_endpoint = lambda ws_url, timeout_seconds=None, include_upgrade=False, verify_tls=False: {
            "url": ws_url,
            "host": "iqoption.com",
            "port": 443,
            "ok": True,
            "stage": "ok",
            "resolvedIps": ["45.88.36.129"],
            "dnsMs": 5.0,
            "tcpMs": 5.0,
            "tlsMs": 8.0,
            "upgradeMs": None,
            "tlsVersion": "TLSv1.3",
            "httpStatus": None,
            "error": None,
        }

        class FakeSSLError(Exception):
            pass

        class FakeProxyError(Exception):
            pass

        scenarios = [
            (
                "http_401",
                lambda _api: type(
                    "Resp",
                    (),
                    {
                        "status_code": 401,
                        "cookies": {},
                        "text": "invalid_credentials",
                        "json": staticmethod(lambda: {"code": "invalid_credentials"}),
                    },
                )(),
                "auth.iqoption.com (HTTP 401)",
            ),
            (
                "ssl_error",
                lambda _api: (_ for _ in ()).throw(FakeSSLError("CERTIFICATE_VERIFY_FAILED")),
                "TLS verification failed",
            ),
            (
                "proxy_error",
                lambda _api: (_ for _ in ()).throw(
                    FakeProxyError("Cannot connect to proxy http://puser:ppass@proxy.local:8080")
                ),
                "proxy tunnel failed",
            ),
        ]

        try:
            for _label, behavior, expected_text in scenarios:
                api_cls, _gv, records, cleanup = self._with_patched_http_auth_stubs(get_ssid_behavior=behavior)
                try:
                    api_inst = api_cls()
                    ok, reason = api_inst.connect()
                    self.assertFalse(ok)
                    self.assertIn(expected_text, reason)
                    # Exactly one auth attempt on canonical host; never silently switch hosts or retry
                    self.assertEqual(records["get_ssid_calls"], 1)
                    self.assertGreaterEqual(records["close_calls"], 1)
                    # Proxy credentials must never leak into reason
                    self.assertNotIn("ppass", reason)
                    self.assertNotIn("puser", reason)
                    self.assertNotIn("iq-secret-password", reason)
                finally:
                    cleanup()
        finally:
            app._probe_ws_endpoint = orig_probe

    def test_auth_timeout_handling_bounded_no_retries_and_closes_ws(self):
        orig_probe = app._probe_ws_endpoint
        app._probe_ws_endpoint = lambda ws_url, timeout_seconds=None, include_upgrade=False, verify_tls=False: {
            "url": ws_url,
            "host": "iqoption.com",
            "port": 443,
            "ok": True,
            "stage": "ok",
            "resolvedIps": ["45.88.36.129"],
            "dnsMs": 5.0,
            "tcpMs": 5.0,
            "tlsMs": 8.0,
            "upgradeMs": None,
            "tlsVersion": "TLSv1.3",
            "httpStatus": None,
            "error": None,
        }

        class ConnectTimeout(Exception):
            pass

        class ReadTimeout(Exception):
            pass

        try:
            for exc_cls, expected_phrase in (
                (ConnectTimeout, "TCP connection timed out"),
                (ReadTimeout, "read timed out"),
            ):
                api_cls, _gv, records, cleanup = self._with_patched_http_auth_stubs(
                    get_ssid_behavior=lambda _api, e=exc_cls: (_ for _ in ()).throw(
                        e("auth.iqoption.com timed out")
                    )
                )
                try:
                    api_inst = api_cls()
                    ok, reason = api_inst.connect()
                    self.assertFalse(ok)
                    self.assertIn(expected_phrase, reason)
                    self.assertEqual(records["get_ssid_calls"], 1)
                    self.assertGreaterEqual(records["close_calls"], 1)
                finally:
                    cleanup()
        finally:
            app._probe_ws_endpoint = orig_probe

    def test_secret_redaction_strips_proxy_and_iq_credentials_everywhere(self):
        saved_env = {
            k: os.environ.get(k)
            for k in ("IQ_EMAIL", "IQ_PASSWORD", "IQ_CONNECTOR_TOKEN", "IQ_PROXY_URL", "IQ_PROXY_WS")
        }
        os.environ["IQ_EMAIL"] = "private.trader@example.com"
        os.environ["IQ_PASSWORD"] = "UltraSecretIQPass!99"
        os.environ["IQ_CONNECTOR_TOKEN"] = "ConnTok-887766"
        os.environ["IQ_PROXY_URL"] = "http://prox_usr:ProxPass%402026@eu-egress.example:3128"
        os.environ.pop("IQ_PROXY_WS", None)

        orig_probe_ws = app._probe_ws_endpoint
        orig_probe_https = app._probe_https_endpoint
        orig_probe_proxy = app._probe_https_via_proxy

        try:
            # Redacted proxy helper strips credentials and keeps only scheme://host:port
            self.assertEqual(
                app._redact_proxy_url(os.environ["IQ_PROXY_URL"]),
                "http://eu-egress.example:3128",
            )

            import base64
            basic_b64 = base64.b64encode(b"prox_usr:ProxPass@2026").decode("ascii")
            noisy = (
                "ProxyError connecting via http://prox_usr:ProxPass%402026@eu-egress.example:3128 "
                f"Proxy-Authorization: Basic {basic_b64} "
                "email=private.trader@example.com pwd=UltraSecretIQPass!99 tok=ConnTok-887766 "
                "other=https://inline_u:inline_p@other.example:9000 raw=ProxPass@2026"
            )
            cleaned = app._sanitize_error(noisy)
            for forbidden in (
                "prox_usr",
                "ProxPass%402026",
                "ProxPass@2026",
                basic_b64,
                "private.trader@example.com",
                "UltraSecretIQPass!99",
                "ConnTok-887766",
                "inline_u",
                "inline_p",
            ):
                self.assertNotIn(forbidden, cleaned)
            self.assertIn("eu-egress.example:3128", cleaned)

            # Verify /network-check proxyAuthEndpoint never exposes credentials
            app._probe_ws_endpoint = lambda url, timeout_seconds=None, include_upgrade=False: {
                "url": url,
                "ok": True,
                "stage": "ok",
            }
            app._probe_https_endpoint = lambda url, timeout_seconds=None: {
                "url": url,
                "ok": False,
                "stage": "tcp",
            }
            app._probe_https_via_proxy = lambda target_url, proxy_url, timeout_seconds=None, **_kw: {
                "proxy": app._redact_proxy_url(proxy_url),
                "target": "auth.iqoption.com:443",
                "ok": True,
                "stage": "ok",
                "tlsVerified": True,
                "tlsVersion": "TLSv1.3",
                "error": None,
            }
            net_res = asyncio.run(app.network_check(x_connector_token="ConnTok-887766"))
            self.assertTrue(net_res["proxyConfigured"])
            self.assertFalse(net_res["wsProxyEnabled"])
            self.assertEqual(net_res["proxyAuthEndpoint"]["proxy"], "http://eu-egress.example:3128")
            self.assertTrue(net_res["proxyAuthEndpoint"]["tlsVerified"])
            self.assertTrue(net_res["orderExecutionSupported"])
            self.assertFalse(net_res["realTradingEnabled"])
            serialized = str(net_res)
            for forbidden in ("prox_usr", "ProxPass", "UltraSecretIQPass", "private.trader@example.com", "ConnTok-887766"):
                self.assertNotIn(forbidden, serialized)
        finally:
            app._probe_ws_endpoint = orig_probe_ws
            app._probe_https_endpoint = orig_probe_https
            app._probe_https_via_proxy = orig_probe_proxy
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_timesync_none_timestamp_does_not_raise_typeerror_during_connect(self):
        """Regression test for: TypeError: unsupported operand type(s) for /: 'NoneType' and 'int'."""
        saved_modules = {
            name: sys.modules.get(name)
            for name in ("iqoptionapi.ws.objects", "iqoptionapi.ws.objects.timesync")
        }

        class UpstreamTimeSync:
            """Reproduces exact upstream iqoptionapi/ws/objects/timesync.py bug."""
            def __init__(self):
                self.__server_timestamp = None

            @property
            def server_timestamp(self):
                return self.__server_timestamp / 1000

            @server_timestamp.setter
            def server_timestamp(self, timestamp):
                self.__server_timestamp = timestamp

        m_objects = ModuleType("iqoptionapi.ws.objects")
        m_timesync = ModuleType("iqoptionapi.ws.objects.timesync")
        m_timesync.TimeSync = UpstreamTimeSync
        sys.modules["iqoptionapi.ws.objects"] = m_objects
        sys.modules["iqoptionapi.ws.objects.timesync"] = m_timesync

        orig_probe = app._probe_ws_endpoint
        app._probe_ws_endpoint = lambda ws_url, timeout_seconds=None, include_upgrade=False, verify_tls=False: {
            "url": ws_url,
            "ok": True,
            "stage": "ok",
        }
        api_cls, _gv, _records, cleanup = self._with_patched_http_auth_stubs()
        try:
            # Verify patched TimeSync property returns None while unset instead of crashing on None / 1000
            ts = UpstreamTimeSync()
            self.assertIsNone(ts.server_timestamp)
            ts.server_timestamp = 1710000000000
            self.assertEqual(ts.server_timestamp, 1710000000.0)

            # Simulate real connect() where timeSync arrives asynchronously 50ms after ssid
            api_inst = api_cls()
            api_inst.timesync = UpstreamTimeSync()

            def deliver_timesync():
                time.sleep(0.05)
                api_inst.timesync.server_timestamp = 1710000060000

            t = threading.Thread(target=deliver_timesync, daemon=True)
            t.start()
            ok, reason = api_inst.connect()
            t.join(timeout=1.0)
            self.assertTrue(ok, f"Expected connect() to succeed without TypeError, got: {reason}")
            self.assertIsNone(reason)

            # Also verify _safe_api_connect survives an unpatched TimeSync-like object raising TypeError
            class BrokenTimeSync:
                def __init__(self):
                    self.raw = None

                @property
                def server_timestamp(self):
                    return self.raw / 1000

                @server_timestamp.setter
                def server_timestamp(self, val):
                    self.raw = val

            api_inst2 = api_cls()
            api_inst2.timesync = BrokenTimeSync()

            def deliver_broken_ts():
                time.sleep(0.05)
                api_inst2.timesync.server_timestamp = 1710000120000

            t2 = threading.Thread(target=deliver_broken_ts, daemon=True)
            t2.start()
            ok2, reason2 = api_inst2.connect()
            t2.join(timeout=1.0)
            self.assertTrue(ok2, f"Expected fallback TypeError guard to succeed, got: {reason2}")
            self.assertIsNone(reason2)
        finally:
            app._probe_ws_endpoint = orig_probe
            cleanup()
            for name, mod in saved_modules.items():
                if mod is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = mod

    def test_get_ssid_exception_return_and_login_patch_redact_secrets(self):
        """Ensure returned Exception objects or raised login() exceptions are classified & redacted cleanly."""
        orig_probe = app._probe_ws_endpoint
        app._probe_ws_endpoint = lambda ws_url, timeout_seconds=None, include_upgrade=False, verify_tls=False: {
            "url": ws_url,
            "ok": True,
            "stage": "ok",
        }

        class ProxyError(Exception):
            pass

        # Case 1: get_ssid returns an Exception object (upstream iqoptionapi behavior if unpatched)
        api_cls, _gv, _records, cleanup = self._with_patched_http_auth_stubs(
            get_ssid_behavior=lambda _api: ProxyError("Proxy 407 for http://ws_u:ws_secret@proxy.webshare.io:80")
        )
        try:
            api_inst = api_cls()
            ok, reason = api_inst.connect()
            self.assertFalse(ok)
            self.assertIn("proxy tunnel failed", reason)
            self.assertNotIn("ws_secret", reason)
            self.assertNotIn("ws_u", reason)
        finally:
            cleanup()

        # Case 2: instance has callable login() which raises ProxyError directly
        api_cls2, _gv2, _records2, cleanup2 = self._with_patched_http_auth_stubs()
        try:
            api_inst2 = api_cls2()
            api_inst2.login = lambda _u, _p: (_ for _ in ()).throw(
                ProxyError("Failed via http://enc_u:enc_secret%21@proxy.webshare.io:80")
            )
            ok2, reason2 = api_inst2.connect()
            self.assertFalse(ok2)
            self.assertIn("proxy tunnel failed", reason2)
            self.assertNotIn("enc_secret", reason2)
            self.assertNotIn("enc_u", reason2)
        finally:
            app._probe_ws_endpoint = orig_probe
            cleanup2()

    def test_webshare_ws_proxy_modes_url_decoding_and_http11_tunnel_patch(self):
        """Verify IQ_PROXY_WS=true/auto, URL-decoded Webshare credentials, HTTP/1.1 CONNECT tunnel, and direct vs proxied network-check."""
        saved_env = {k: os.environ.get(k) for k in ("IQ_PROXY_URL", "IQ_PROXY_WS", "IQ_WS_URL", "IQ_CONNECTOR_TOKEN")}
        proxy_url = "http://user%2Bwebshare:p%40ss%3Aword%231@p.webshare.io:80"
        os.environ["IQ_PROXY_URL"] = proxy_url
        os.environ["IQ_PROXY_WS"] = "true"
        os.environ.pop("IQ_WS_URL", None)
        os.environ["IQ_CONNECTOR_TOKEN"] = "diag-tok-1"

        # Install a minimal websocket._http stub to verify _safe_ws_tunnel sends HTTP/1.1 + Host + Basic auth
        saved_ws_http = sys.modules.get("websocket._http")
        tunnel_sent = []

        class StubWebSocketProxyException(Exception):
            pass

        m_ws_http = ModuleType("websocket._http")
        m_ws_http.WebSocketProxyException = StubWebSocketProxyException
        m_ws_http._tunnel = lambda sock, host, port, auth: sock
        m_ws_http.send = lambda sock, data: tunnel_sent.append(data)
        m_ws_http.read_headers = lambda sock: (200, {}, "Connection established")
        sys.modules["websocket._http"] = m_ws_http

        orig_probe_ws = app._probe_ws_endpoint
        orig_probe_https = app._probe_https_endpoint
        orig_probe_proxy = app._probe_https_via_proxy
        orig_probe_ws_proxy = app._probe_ws_via_proxy

        api_cls, _gv, records, cleanup = self._with_patched_http_auth_stubs()
        try:
            # 1. URL-decoded Webshare proxy credentials for websocket-client
            ws_kwargs = app._get_ws_proxy_kwargs()
            self.assertEqual(ws_kwargs["http_proxy_host"], "p.webshare.io")
            self.assertEqual(ws_kwargs["http_proxy_port"], 80)
            self.assertEqual(ws_kwargs["proxy_type"], "http")
            self.assertEqual(ws_kwargs["http_proxy_auth"], ("user+webshare", "p@ss:word#1"))

            # 2. Patched websocket._http._tunnel sends HTTP/1.1 + Host + Base64 Basic auth
            m_ws_http._tunnel(object(), "iqoption.com", 443, ws_kwargs["http_proxy_auth"])
            self.assertEqual(len(tunnel_sent), 1)
            hdr = tunnel_sent[0]
            self.assertIn("CONNECT iqoption.com:443 HTTP/1.1\r\n", hdr)
            self.assertIn("Host: iqoption.com:443\r\n", hdr)
            import base64
            expected_b64 = base64.b64encode(b"user+webshare:p@ss:word#1").decode("ascii")
            self.assertIn(f"Proxy-Authorization: Basic {expected_b64}\r\n", hdr)

            # 3. IQ_PROXY_WS=true routes WS through proxy kwargs
            app._probe_https_via_proxy = lambda target_url, p_url, timeout_seconds=None, include_upgrade=False, verify_tls=True: {
                "url": target_url,
                "proxy": app._redact_proxy_url(p_url),
                "viaProxy": True,
                "ok": True,
                "stage": "ok",
                "error": None,
            }
            api_inst = api_cls()
            ok, reason = api_inst.start_websocket()
            self.assertTrue(ok, f"Expected proxied WS open, got: {reason}")
            self.assertTrue(app._active_ws_via_proxy)
            ws_run_kw = records["ws_attempts"][0]["kwargs"]
            self.assertEqual(ws_run_kw["http_proxy_host"], "p.webshare.io")
            self.assertEqual(ws_run_kw["http_proxy_port"], 80)
            self.assertEqual(ws_run_kw["proxy_type"], "http")
            self.assertEqual(ws_run_kw["http_proxy_auth"], ("user+webshare", "p@ss:word#1"))

            # 4. IQ_PROXY_WS=auto tries direct first, then falls back to proxy when direct fails
            os.environ["IQ_PROXY_WS"] = "auto"
            records["ws_attempts"].clear()
            app._probe_ws_endpoint = lambda ws_url, timeout_seconds=None, include_upgrade=False, verify_tls=False: {
                "url": ws_url,
                "ok": False,
                "stage": "tcp",
                "error": "Direct TCP blocked",
            }
            ok_auto, reason_auto = api_inst.start_websocket()
            self.assertTrue(ok_auto, f"Expected auto WS proxy fallback to succeed, got: {reason_auto}")
            self.assertTrue(app._active_ws_via_proxy)
            self.assertEqual(len(records["ws_attempts"]), 1)
            self.assertEqual(records["ws_attempts"][0]["kwargs"]["http_proxy_host"], "p.webshare.io")

            # 5. /network-check distinguishes proxyConfigured from proxyConnectivityVerified and direct vs proxied
            app._probe_https_endpoint = lambda url, timeout_seconds=None: {
                "url": url,
                "ok": False,
                "stage": "tcp",
                "error": "Direct auth TCP timeout",
            }
            app._probe_https_via_proxy = lambda target_url, p_url, timeout_seconds=None: {
                "url": target_url,
                "proxy": app._redact_proxy_url(p_url),
                "viaProxy": True,
                "ok": False,
                "stage": "proxy_connect",
                "httpStatus": 407,
                "error": "Proxy CONNECT rejected tunnel: HTTP 407",
            }
            app._probe_ws_via_proxy = lambda ws_url, p_url, timeout_seconds=None: {
                "url": ws_url,
                "proxy": app._redact_proxy_url(p_url),
                "viaProxy": True,
                "ok": False,
                "stage": "proxy_connect",
                "httpStatus": 407,
                "error": "Proxy CONNECT rejected tunnel: HTTP 407",
            }
            net_res = asyncio.run(app.network_check(x_connector_token="diag-tok-1"))
            self.assertTrue(net_res["proxyConfigured"])
            # Must NOT claim proxy is working merely because IQ_PROXY_URL is configured
            self.assertFalse(net_res["proxyConnectivityVerified"])
            self.assertFalse(net_res["wsProxyConnectivityVerified"])
            self.assertFalse(net_res["proxied"]["verified"])
            self.assertFalse(net_res["direct"]["authEndpoint"]["ok"])
            self.assertNotIn("p@ss:word#1", str(net_res))
            self.assertNotIn("user+webshare", str(net_res))
        finally:
            app._probe_ws_endpoint = orig_probe_ws
            app._probe_https_endpoint = orig_probe_https
            app._probe_https_via_proxy = orig_probe_proxy
            app._probe_ws_via_proxy = orig_probe_ws_proxy
            cleanup()
            if saved_ws_http is None:
                sys.modules.pop("websocket._http", None)
            else:
                sys.modules["websocket._http"] = saved_ws_http
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_missing_or_invalid_balance_and_candles_never_fabricate_values(self):
        """Ensure None/NaN/Inf balances and empty/malformed candles return HTTP 502 instead of fabricating 0 or empty 200."""
        class BadBalanceClient(FakeIqClient):
            def __init__(self, bad_balance):
                super().__init__(initial_mode="PRACTICE")
                self._bad_balance = bad_balance

            def get_balance(self):
                return self._bad_balance

        for bad_val in (None, float("nan"), float("inf"), "not-a-number", True):
            app._client = BadBalanceClient(bad_val)
            with self.assertRaises(app.HTTPException) as bal_ctx:
                app.balance(mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(bal_ctx.exception.status_code, 502)
            with self.assertRaises(app.HTTPException) as acct_ctx:
                app.account(mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(acct_ctx.exception.status_code, 502)

        # Empty candle list must raise HTTP 502 (not 200 with empty list)
        app._client = FakeIqClient(initial_mode="PRACTICE", candles_rows=[])
        q = app.CandlesQuery(symbol="EURUSD", interval=60, count=5)
        with self.assertRaises(app.HTTPException) as empty_ctx:
            app.candles(q, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(empty_ctx.exception.status_code, 502)
        self.assertFalse(app._last_candle_check["ok"])

        # Malformed candles (None/NaN/negative/high<low) must be rejected with HTTP 502
        bad_rows = [
            {"from": None, "open": 1.1, "max": 1.2, "min": 1.0, "close": 1.15, "volume": 5},
            {"from": 1700000000, "open": float("nan"), "max": 1.2, "min": 1.0, "close": 1.15, "volume": 5},
            {"from": 1700000060, "open": 1.1, "max": 1.0, "min": 1.2, "close": 1.15, "volume": 5},
            {"from": 1700000120, "open": -1.0, "max": 1.2, "min": 1.0, "close": 1.15, "volume": 5},
        ]
        app._client = FakeIqClient(initial_mode="PRACTICE", candles_rows=bad_rows)
        with self.assertRaises(app.HTTPException) as bad_c_ctx:
            app.candles(q, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(bad_c_ctx.exception.status_code, 502)
        with self.assertRaises(app.HTTPException) as bad_p_ctx:
            app.latest_price("EURUSD", mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(bad_p_ctx.exception.status_code, 502)

    def test_simultaneous_connect_requests_coalesce_via_single_flight_and_slow_ws(self):
        """Simulate a slow WebSocket connect + 5 simultaneous POST /connect calls:
        only ONE upstream IQ_Option.connect() runs, /health stays non-blocking and reports connectInFlight=True,
        and all 5 callers succeed cleanly without HTTP 503 busy errors.
        """
        saved_modules = {
            k: sys.modules.get(k)
            for k in ("iqoptionapi", "iqoptionapi.stable_api", "iqoptionapi.global_value")
        }
        orig_patched = app._iqoptionapi_patched
        orig_connect_timeout = app._CONNECT_TIMEOUT
        orig_lock_timeout = app._LOCK_ACQUIRE_TIMEOUT
        app._iqoptionapi_patched = True
        app._CONNECT_TIMEOUT = 3.0
        app._LOCK_ACQUIRE_TIMEOUT = 0.08  # Much shorter than slow connect delay (0.28s)!

        connect_calls = []
        connect_started = threading.Event()
        release_connect = threading.Event()

        m_iq = ModuleType("iqoptionapi")
        m_gv = ModuleType("iqoptionapi.global_value")
        m_gv.ssl_Mutual_exclusion = False
        m_gv.ssl_Mutual_exclusion_write = False
        m_gv.check_websocket_if_connect = 1

        class SlowFakeIQOption(FakeIqClient):
            def __init__(self, email, password):
                super().__init__(initial_mode="PRACTICE")
                self.email = email
                self.password = password

            def connect(self):
                connect_calls.append(time.monotonic())
                connect_started.set()
                release_connect.wait(timeout=2.0)
                return True, None

        m_stable = ModuleType("iqoptionapi.stable_api")
        m_stable.IQ_Option = SlowFakeIQOption
        sys.modules["iqoptionapi"] = m_iq
        sys.modules["iqoptionapi.global_value"] = m_gv
        sys.modules["iqoptionapi.stable_api"] = m_stable

        results = []
        errors = []

        def worker():
            try:
                body = app.ConnectBody(email="trader@example.com", password="secret-pass", mode="PRACTICE")
                res = app.connect_route(body=body, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
                results.append(res)
            except BaseException as exc:
                errors.append(exc)

        try:
            threads = [threading.Thread(target=worker) for _ in range(5)]
            for t in threads:
                t.start()

            self.assertTrue(connect_started.wait(timeout=1.0))
            # Allow all 5 threads to reach single-flight barrier
            time.sleep(0.15)
            # While slow connect is in flight (> _LOCK_ACQUIRE_TIMEOUT), /health stays non-blocking
            t0 = time.monotonic()
            h = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
            self.assertLess(time.monotonic() - t0, 0.2)
            self.assertTrue(h["connectInFlight"])
            self.assertTrue(h["busy"])
            self.assertEqual(h["busyOperation"], "connect")

            release_connect.set()
            for t in threads:
                t.join(timeout=3.0)

            self.assertEqual(errors, [])
            self.assertEqual(len(results), 5)
            self.assertEqual(len(connect_calls), 1)
            for res in results:
                self.assertTrue(res["connected"])
                self.assertEqual(res["mode"], "PRACTICE")
                self.assertTrue(res["modeVerified"])
                self.assertTrue(res["orderExecutionSupported"])
                self.assertFalse(res["realTradingEnabled"])

            # After completion, connector is idle and connected
            h_after = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
            self.assertFalse(h_after["busy"])
            self.assertFalse(h_after["connectInFlight"])
            self.assertTrue(h_after["connected"])
            self.assertEqual(h_after["lastConnectStage"], "connected")
        finally:
            release_connect.set()
            app._iqoptionapi_patched = orig_patched
            app._CONNECT_TIMEOUT = orig_connect_timeout
            app._LOCK_ACQUIRE_TIMEOUT = orig_lock_timeout
            for k, v in saved_modules.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v

    def test_connect_timeout_closes_local_client_fences_abandoned_worker_and_clears_busy(self):
        """Simulate a hanging connect() that times out:
        1. Returns HTTP 504 promptly.
        2. Closes the local client instance so the abandoned thread unblocks.
        3. Connector is NOT left permanently busy (connectInFlight=False, busy=False).
        4. Subsequent connect() establishes a healthy session and the late-exiting abandoned worker
           CANNOT overwrite app._client or reset global_value.check_websocket_if_connect to 0.
        """
        saved_modules = {
            k: sys.modules.get(k)
            for k in ("iqoptionapi", "iqoptionapi.stable_api", "iqoptionapi.global_value")
        }
        orig_patched = app._iqoptionapi_patched
        orig_connect_timeout = app._CONNECT_TIMEOUT
        app._iqoptionapi_patched = True
        app._CONNECT_TIMEOUT = 0.12

        m_iq = ModuleType("iqoptionapi")
        m_gv = ModuleType("iqoptionapi.global_value")
        m_gv.ssl_Mutual_exclusion = False
        m_gv.ssl_Mutual_exclusion_write = False
        m_gv.check_websocket_if_connect = 0

        attempt_counter = {"n": 0}
        first_client_closed = threading.Event()
        release_abandoned_worker = threading.Event()
        abandoned_worker_saw_cancel = []
        created_clients = []

        class ControllableIQOption(FakeIqClient):
            def __init__(self, email, password):
                super().__init__(initial_mode="PRACTICE")
                self.email = email
                self.password = password
                attempt_counter["n"] += 1
                self.attempt_num = attempt_counter["n"]
                created_clients.append(self)

            def close(self):
                if self.attempt_num == 1:
                    first_client_closed.set()

            def connect(self):
                if self.attempt_num == 1:
                    # Stay blocked past _CONNECT_TIMEOUT until explicitly released AFTER session 2 connects
                    release_abandoned_worker.wait(timeout=3.0)
                    abandoned_worker_saw_cancel.append(app._is_worker_cancelled())
                    # Even if abandoned worker returns (True, None) late, it MUST be fenced out
                    return True, None
                m_gv.check_websocket_if_connect = 1
                return True, None

        m_stable = ModuleType("iqoptionapi.stable_api")
        m_stable.IQ_Option = ControllableIQOption
        sys.modules["iqoptionapi"] = m_iq
        sys.modules["iqoptionapi.global_value"] = m_gv
        sys.modules["iqoptionapi.stable_api"] = m_stable

        try:
            body = app.ConnectBody(email="trader@example.com", password="secret-pass", mode="PRACTICE")
            with self.assertRaises(app.HTTPException) as ctx:
                app.connect_route(body=body, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(ctx.exception.status_code, 504)

            # Local client from timed-out attempt MUST have been closed
            self.assertTrue(first_client_closed.is_set())

            # Connector MUST NOT be stuck busy after failed/timed-out request
            h_failed = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
            self.assertFalse(h_failed["busy"])
            self.assertFalse(h_failed["connectInFlight"])
            self.assertFalse(h_failed["connected"])
            self.assertEqual(h_failed["lastConnectStage"], "timeout")

            # Now establish a new healthy session (attempt 2) while worker 1 is still alive!
            app._CONNECT_TIMEOUT = 2.0
            res2 = app.connect_route(body=body, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertTrue(res2["connected"])
            active_client = app._client
            self.assertIs(active_client, created_clients[1])
            self.assertEqual(m_gv.check_websocket_if_connect, 1)

            # Release abandoned worker 1 and confirm it saw cancellation and did NOT corrupt session 2
            release_abandoned_worker.set()
            time.sleep(0.1)
            self.assertEqual(abandoned_worker_saw_cancel, [True])
            self.assertIs(app._client, active_client)
            self.assertEqual(m_gv.check_websocket_if_connect, 1)
            h_ok = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
            self.assertTrue(h_ok["connected"])
            self.assertFalse(h_ok["busy"])
        finally:
            release_abandoned_worker.set()
            app._iqoptionapi_patched = orig_patched
            app._CONNECT_TIMEOUT = orig_connect_timeout
            for k, v in saved_modules.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v

    def test_abandoned_api_close_does_not_reset_newer_session_websocket_flag(self):
        """Ensure patched IQOptionAPI.close() called from a cancelled worker does NOT reset global_value.check_websocket_if_connect."""
        api_inst, _records, cleanup = self._with_patched_ws_stubs(lambda _u, gv, _w: setattr(gv, "check_websocket_if_connect", 1))
        try:
            import iqoptionapi.global_value as m_gv
            m_gv.check_websocket_if_connect = 1
            cancel_ev = threading.Event()
            cancel_ev.set()

            def run_cancelled_close():
                app._worker_ctx.cancel_event = cancel_ev
                app._worker_ctx.generation = 1
                try:
                    api_inst.close()
                finally:
                    app._worker_ctx.cancel_event = None
                    app._worker_ctx.generation = None

            t = threading.Thread(target=run_cancelled_close)
            t.start()
            t.join(timeout=1.0)
            # Active session's WebSocket flag MUST remain 1
            self.assertEqual(m_gv.check_websocket_if_connect, 1)
        finally:
            cleanup()

    def test_repeated_health_and_balance_requests_succeed_without_busy_starvation(self):
        """Simulate rapid repeated Health & Balance requests concurrently and verify zero 503 busy errors."""
        app._client = FakeIqClient(initial_mode="PRACTICE")
        app._confirmed_mode = "PRACTICE"
        app._mode_verified = True
        errors = []
        balances = []

        def hit_balance():
            try:
                res = app.balance(mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
                balances.append(res["balance"])
            except BaseException as exc:
                errors.append(exc)

        def hit_health():
            try:
                res = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
                self.assertEqual(res["status"], "running")
                self.assertTrue(res["connected"])
            except BaseException as exc:
                errors.append(exc)

        threads = []
        for _ in range(10):
            threads.append(threading.Thread(target=hit_balance))
            threads.append(threading.Thread(target=hit_health))
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=3.0)

        self.assertEqual(errors, [])
        self.assertEqual(len(balances), 10)
        self.assertTrue(all(b == 10000.0 for b in balances))

    def test_reconnect_after_disconnect_replaces_stale_session_cleanly(self):
        """Verify force_reconnect / dead-client reconnect replaces stale session without leaving stale references or busy state."""
        saved_modules = {
            k: sys.modules.get(k)
            for k in ("iqoptionapi", "iqoptionapi.stable_api", "iqoptionapi.global_value")
        }
        orig_patched = app._iqoptionapi_patched
        app._iqoptionapi_patched = True

        m_iq = ModuleType("iqoptionapi")
        m_gv = ModuleType("iqoptionapi.global_value")
        m_gv.ssl_Mutual_exclusion = False
        m_gv.ssl_Mutual_exclusion_write = False
        m_gv.check_websocket_if_connect = 1

        instances = []

        class ReconnectableClient(FakeIqClient):
            def __init__(self, email, password):
                super().__init__(initial_mode="PRACTICE")
                self.email = email
                self.password = password
                self.alive = True
                self.closed = False
                instances.append(self)

            def check_connect(self):
                return self.alive

            def close(self):
                self.closed = True
                self.alive = False

            def connect(self):
                self.alive = True
                return True, None

        m_stable = ModuleType("iqoptionapi.stable_api")
        m_stable.IQ_Option = ReconnectableClient
        sys.modules["iqoptionapi"] = m_iq
        sys.modules["iqoptionapi.global_value"] = m_gv
        sys.modules["iqoptionapi.stable_api"] = m_stable

        try:
            c1 = app.connect(email="trader@example.com", password="pw", target_mode="PRACTICE")
            gen1 = app._session_generation
            self.assertIs(c1, instances[0])
            self.assertTrue(app._is_client_alive(c1))

            # Simulate socket drop on c1
            c1.alive = False
            c2 = app._try_reconnect_session(c1, "PRACTICE")
            self.assertIsNotNone(c2)
            self.assertIsNot(c2, c1)
            self.assertIs(app._client, c2)
            self.assertTrue(c1.closed)
            self.assertGreater(app._session_generation, gen1)
            self.assertTrue(app._is_client_alive(c2))
            bal = app.balance(mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
            self.assertEqual(bal["balance"], 10000.0)
            self.assertTrue(bal["orderExecutionSupported"])
            self.assertFalse(bal["realTradingEnabled"])
        finally:
            app._iqoptionapi_patched = orig_patched
            for k, v in saved_modules.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v

    def test_dynamic_real_mode_detection_and_execution_without_switching(self):
        """When the user switches their IQ Option account to REAL inside IQ Option, NovaTrade auto-detects REAL without calling change_balance()."""
        client = FakeIqClient(initial_mode="PRACTICE")
        app._client = client

        acc_practice = app.account(fresh=True, x_connector_token=None)
        self.assertEqual(acc_practice["mode"], "PRACTICE")
        self.assertEqual(acc_practice["balance"], 10000.0)
        self.assertFalse(acc_practice["realTradingEnabled"])
        self.assertEqual(client.change_balance_calls, [])

        # User switches to REAL inside IQ Option app
        client.mode = "REAL"
        acc_real = app.account(fresh=True, x_connector_token=None)
        self.assertEqual(acc_real["mode"], "REAL")
        self.assertEqual(acc_real["accountType"], "REAL")
        self.assertEqual(acc_real["balance"], 250.0)
        self.assertTrue(acc_real["realTradingEnabled"])
        self.assertEqual(client.change_balance_calls, [])

        # Health also reflects REAL automatically
        h_real = asyncio.run(app.health(mode=None, x_iq_mode="AUTO"))
        self.assertTrue(h_real["connected"])
        self.assertEqual(h_real["mode"], "REAL")
        self.assertTrue(h_real["realTradingEnabled"])

        # Order routed with expectedMode=REAL executes cleanly in REAL without switching
        req = app.OrderRequest(
            symbol="EURUSD",
            direction="PUT",
            amount=5.0,
            expirySeconds=60,
            expectedMode="REAL",
            idempotencyKey="real-mode-order-1",
        )
        res = app.place_order(req, x_connector_token=None)
        self.assertTrue(res["accepted"])
        self.assertEqual(res["mode"], "REAL")
        self.assertEqual(client.buy_calls[-1][4], "REAL")
        self.assertEqual(client.change_balance_calls, [])

    def test_full_practice_trade_lifecycle_open_monitor_close_and_history(self):
        """End-to-end connector test: open PRACTICE trade -> list active position -> close trade -> verify history sync."""
        client = FakeIqClient(initial_mode="PRACTICE")
        app._client = client

        # 1. Open trade in PRACTICE
        order_res = app.place_order(
            app.OrderRequest(
                symbol="EURUSD",
                direction="CALL",
                amount=20.0,
                expirySeconds=180,
                expectedMode="PRACTICE",
                idempotencyKey="lifecycle-1",
            ),
            x_connector_token=None,
        )
        self.assertTrue(order_res["accepted"])
        oid = order_res["brokerOrderId"]
        self.assertEqual(order_res["mode"], "PRACTICE")

        # 2. Monitor active positions
        pos_res = app.positions(x_connector_token=None)
        self.assertTrue(pos_res["supported"])
        self.assertEqual(pos_res["mode"], "PRACTICE")
        self.assertEqual(len(pos_res["positions"]), 1)
        self.assertEqual(pos_res["positions"][0]["ticket"], oid)
        self.assertEqual(pos_res["positions"][0]["symbol"], "EURUSD")

        # 3. Check single order status while open
        st_open = app.order_status(oid, x_connector_token=None)
        self.assertIn(st_open["status"], ("OPEN", "FILLED"))
        self.assertEqual(st_open["brokerOrderId"], oid)

        # 4. Close trade
        close_res = app.close_position(oid, x_connector_token=None)
        self.assertTrue(close_res["closed"])
        self.assertEqual(close_res["status"], "CLOSED")
        self.assertEqual(close_res["mode"], "PRACTICE")
        self.assertEqual(len(client.sell_calls), 1)

        # 5. Active positions list is now empty
        pos_after = app.positions(x_connector_token=None)
        self.assertEqual(len(pos_after["positions"]), 0)

        # 6. History contains both IQ Option closed history and settled tracked order
        client.option_outcomes["101"] = {
            "id": 101,
            "active": "EURUSD",
            "direction": "call",
            "amount": 10.0,
            "win_amount": 18.0,
            "profit_amount": 8.0,
            "close_time": 1700000000,
        }
        hist = app.history(x_connector_token=None)
        self.assertTrue(hist["supported"])
        ids = [str(t.get("id")) for t in hist["trades"]]
        self.assertIn("101", ids)
        self.assertIn(oid, ids)

    def test_transient_timeout_preserves_alive_client_session(self):
        """A single transient timeout reading balance must NOT tear down a healthy alive WebSocket session."""
        release_event = threading.Event()
        calls = {"count": 0}

        class FlakyOnceClient(FakeIqClient):
            def get_balance(self):
                calls["count"] += 1
                if calls["count"] == 1:
                    release_event.wait(timeout=2.0)
                return 7428.71

        orig_timeout = app._BALANCE_TIMEOUT
        app._BALANCE_TIMEOUT = 0.05
        client = FlakyOnceClient(initial_mode="PRACTICE")
        app._client = client
        try:
            with self.assertRaises(app.HTTPException) as ctx:
                app.balance(fresh=True, x_connector_token=None)
            self.assertEqual(ctx.exception.status_code, 504)
            # Crucially, _client must still be preserved because check_connect() is still alive!
            self.assertIs(app._client, client)

            # Subsequent call succeeds immediately using the preserved session
            ok_bal = app.balance(fresh=True, x_connector_token=None)
            self.assertEqual(ok_bal["balance"], 7428.71)
            self.assertEqual(ok_bal["mode"], "PRACTICE")
        finally:
            release_event.set()
            app._BALANCE_TIMEOUT = orig_timeout


    def test_flexible_trade_duration_and_stake_limit(self):
        client = FakeIqClient(initial_mode="PRACTICE")
        app._client = client

        # 1-minute (60s) duration -> duration_min = 1
        req_1m = app.OrderRequest(
            symbol="EURUSD",
            direction="CALL",
            amount=25.0,
            expirySeconds=60,
            expectedMode="PRACTICE",
            idempotencyKey="test-flex-1m",
        )
        res_1m = app.place_order(req_1m, x_connector_token=None)
        self.assertTrue(res_1m["accepted"])
        self.assertEqual(res_1m["expirySeconds"], 60)
        self.assertEqual(client.buy_calls[-1][3], 1, "1-minute trade must pass duration_min=1 to IQ Option")

        # 5-minute (300s) duration -> duration_min = 5
        req_5m = app.OrderRequest(
            symbol="EURUSD",
            direction="CALL",
            amount=50.0,
            expirySeconds=300,
            expectedMode="PRACTICE",
            idempotencyKey="test-flex-5m",
        )
        res_5m = app.place_order(req_5m, x_connector_token=None)
        self.assertTrue(res_5m["accepted"])
        self.assertEqual(res_5m["expirySeconds"], 300)
        self.assertEqual(client.buy_calls[-1][3], 5, "5-minute trade must pass duration_min=5 to IQ Option")

        # 15-minute (900s) duration -> duration_min = 15
        req_15m = app.OrderRequest(
            symbol="EURUSD",
            direction="PUT",
            amount=100.0,
            expirySeconds=900,
            expectedMode="PRACTICE",
            idempotencyKey="test-flex-15m",
        )
        res_15m = app.place_order(req_15m, x_connector_token=None)
        self.assertTrue(res_15m["accepted"])
        self.assertEqual(res_15m["expirySeconds"], 900)
        self.assertEqual(client.buy_calls[-1][3], 15, "15-minute trade must pass duration_min=15 to IQ Option")
        self.assertEqual(res_15m["amount"], 100.0, "Stake of exactly $100 must be supported")


if __name__ == "__main__":
    unittest.main()
