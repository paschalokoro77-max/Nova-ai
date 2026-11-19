"""Unit tests for novatrade-ai/iq-connector/app.py.
Tests mode normalization, PRACTICE/REAL balance mode verification, fail-closed behavior, and order locking.
"""
import asyncio
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
        self.candles_rows = candles_rows
        self.raise_on_candles = raise_on_candles

    def check_connect(self):
        return True

    def get_balance_mode(self):
        return self.mode

    def change_balance(self, target_mode):
        self.change_balance_called_with = target_mode
        if target_mode == "REAL" and not self.allow_real_switch:
            # Stays in PRACTICE even when REAL was requested
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
            {"id": 1, "type": 1, "amount": 10000.0, "currency": "USD"},
            {"id": 2, "type": 4, "amount": 250.0, "currency": "USD"},
        ]

    def get_profile_ansyc(self):
        return {
            "result": {
                "id": 998877,
                "email": "trader@example.com",
                "name": "Nova Trader",
                "currency": "USD",
                "is_activated": True,
            }
        }

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
        app._requested_mode = "PRACTICE"
        app._confirmed_mode = "PRACTICE"
        app._mode_verified = False
        app._last_error = None
        app._connected_at = None
        app._opcodes_updated = False

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
        # Default fallback
        app._requested_mode = "PRACTICE"
        self.assertEqual(app._resolve_target_mode(), "PRACTICE")

        # Header takes precedence
        self.assertEqual(app._resolve_target_mode(x_iq_mode="REAL"), "REAL")
        self.assertEqual(app._resolve_target_mode(x_iq_mode="DEMO"), "PRACTICE")

        # Query param
        self.assertEqual(app._resolve_target_mode(query_mode="REAL"), "REAL")

        # Explicit mode param
        self.assertEqual(app._resolve_target_mode(explicit_mode="real"), "REAL")

    def test_ensure_balance_mode_practice(self):
        client = FakeIqClient(initial_mode="PRACTICE")
        active, ok = app._ensure_balance_mode(client, "PRACTICE")
        self.assertTrue(ok)
        self.assertEqual(active, "PRACTICE")

    def test_ensure_balance_mode_real_success(self):
        client = FakeIqClient(initial_mode="PRACTICE", allow_real_switch=True)
        active, ok = app._ensure_balance_mode(client, "REAL")
        self.assertTrue(ok)
        self.assertEqual(active, "REAL")
        self.assertEqual(client.get_balance_mode(), "REAL")

    def test_ensure_balance_mode_real_fail_closed(self):
        # Client refused to switch to REAL and remains in PRACTICE
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

    def test_order_placement_strictly_locked(self):
        with self.assertRaises(app.HTTPException) as ctx:
            app.order_locked()
        self.assertEqual(ctx.exception.status_code, 423)
        self.assertIn("locked", str(ctx.exception.detail).lower())

    def test_price_endpoint_returns_latest_close_in_practice(self):
        app._client = FakeIqClient(initial_mode="PRACTICE")
        res = app.latest_price("EUR/USD", mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(res["symbol"], "EURUSD")
        self.assertEqual(res["last"], 1.0860)
        self.assertEqual(res["mode"], "PRACTICE")
        self.assertFalse(res["orderExecutionSupported"])
        self.assertFalse(res["realTradingEnabled"])

    def test_candles_endpoint_returns_normalized_bars(self):
        app._client = FakeIqClient(initial_mode="PRACTICE")
        query = app.CandlesQuery(symbol="EURUSD", interval=60, count=2)
        res = app.candles(query, mode=None, x_iq_mode="PRACTICE", x_connector_token=None)
        self.assertEqual(res["symbol"], "EURUSD")
        self.assertEqual(len(res["candles"]), 2)
        self.assertEqual(res["candles"][-1]["close"], 1.0860)
        self.assertFalse(res["orderExecutionSupported"])
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

    def test_health_always_reports_practice_and_execution_locked(self):
        app._client = FakeIqClient(initial_mode="PRACTICE")
        res = asyncio.run(app.health(mode=None, x_iq_mode="PRACTICE"))
        self.assertEqual(res["status"], "running")
        self.assertFalse(res["busy"])
        self.assertTrue(res["connected"])
        self.assertEqual(res["mode"], "PRACTICE")
        self.assertFalse(res["orderExecutionSupported"])
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
            self.assertFalse(health_res["orderExecutionSupported"])
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
        self.assertFalse(bal_ok["orderExecutionSupported"])
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


if __name__ == "__main__":
    unittest.main()
