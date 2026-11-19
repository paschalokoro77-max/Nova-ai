"""Unit tests for novatrade-ai/iq-connector/app.py.
Tests mode normalization, PRACTICE/REAL balance mode verification, fail-closed behavior, and order locking.
"""
import sys
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
        res = app.health(mode=None, x_iq_mode="PRACTICE")
        self.assertEqual(res["status"], "running")
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


if __name__ == "__main__":
    unittest.main()
