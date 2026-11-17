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

        def Header(*args, **kwargs):
            return None
        def Query(*args, **kwargs):
            return None

        m_fastapi = ModuleType("fastapi")
        m_fastapi.FastAPI = FastAPI
        m_fastapi.Header = Header
        m_fastapi.HTTPException = HTTPException
        m_fastapi.Query = Query
        sys.modules["fastapi"] = m_fastapi

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
        m_pydantic = ModuleType("pydantic")
        m_pydantic.BaseModel = BaseModel
        m_pydantic.Field = Field
        sys.modules["pydantic"] = m_pydantic

sys.path.insert(0, str(Path(__file__).resolve().parent))
import app  # noqa: E402


class FakeIqClient:
    def __init__(self, initial_mode="PRACTICE", allow_real_switch=True):
        self.mode = initial_mode
        self.allow_real_switch = allow_real_switch
        self.change_balance_called_with = None

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


if __name__ == "__main__":
    unittest.main()
