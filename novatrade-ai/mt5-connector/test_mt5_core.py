import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mt5_core  # noqa: E402


class FakeMt5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_CONTEST = 1
    ACCOUNT_TRADE_MODE_REAL = 2
    TIMEFRAME_M1 = 1
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_H1 = 60
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_PENDING = 5
    ORDER_TIME_GTC = 0
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008

    def __init__(self, trade_mode=0):
        self.trade_mode = trade_mode
        self.order_check_calls = 0
        self.order_send_calls = 0

    def initialize(self, **kwargs):
        return True

    def login(self, *args, **kwargs):
        return True

    def shutdown(self):
        return True

    def last_error(self):
        return (0, "OK")

    def account_info(self):
        return SimpleNamespace(
            login=50241890,
            server="Broker-Server",
            name="Test Trader",
            currency="USD",
            trade_mode=self.trade_mode,
            balance=2500.0,
            equity=2500.0,
            margin=0.0,
            margin_free=2500.0,
            leverage=100,
            trade_allowed=True,
        )

    def symbol_info(self, symbol):
        return SimpleNamespace(
            name=symbol,
            visible=True,
            digits=5,
            volume_min=0.01,
            volume_max=100.0,
            volume_step=0.01,
            filling_mode=2,
        )

    def symbol_select(self, symbol, enable):
        return True

    def symbol_info_tick(self, symbol):
        return SimpleNamespace(bid=1.10000, ask=1.10020, last=1.10010, time=1700000000)

    def order_check(self, request):
        self.order_check_calls += 1
        return SimpleNamespace(
            retcode=0,
            comment="Done",
            balance=2500.0,
            equity=2500.0,
            profit=0.0,
            margin=11.0,
            margin_free=2489.0,
            margin_level=22700.0,
        )

    def order_send(self, request):
        self.order_send_calls += 1
        return SimpleNamespace(
            retcode=self.TRADE_RETCODE_DONE,
            comment="Request executed",
            order=90001234,
            deal=70005678,
            price=request["price"],
            volume=request["volume"],
        )


class Mt5CoreTest(unittest.TestCase):
    def test_connect_and_order_demo_mode(self):
        fake = FakeMt5(trade_mode=FakeMt5.ACCOUNT_TRADE_MODE_DEMO)
        svc = mt5_core.MT5BridgeService(mt5_module=fake)
        res = svc.connect(environment="demo")
        self.assertTrue(res["connected"])
        self.assertEqual(res["tradeMode"], "DEMO")

        placed = svc.place_order(environment="demo", symbol="EURUSD", side="BUY", order_type="MARKET", volume=0.01)
        self.assertTrue(placed["accepted"])
        self.assertEqual(placed["status"], "FILLED")
        self.assertEqual(placed["tradeMode"], "DEMO")
        self.assertEqual(fake.order_check_calls, 1)
        self.assertEqual(fake.order_send_calls, 1)

    def test_connect_and_order_real_mode_preserved(self):
        fake = FakeMt5(trade_mode=FakeMt5.ACCOUNT_TRADE_MODE_REAL)
        svc = mt5_core.MT5BridgeService(mt5_module=fake)
        res = svc.connect(environment="real")
        self.assertTrue(res["connected"])
        self.assertEqual(res["tradeMode"], "REAL")
        self.assertTrue(res["realTradingEnabled"])

        val = svc.validate_order(environment="real", symbol="EURUSD", side="SELL", order_type="MARKET", volume=0.02)
        self.assertTrue(val["valid"])
        self.assertEqual(val["tradeMode"], "REAL")

        placed = svc.place_order(environment="real", symbol="EURUSD", side="SELL", order_type="MARKET", volume=0.02)
        self.assertTrue(placed["accepted"])
        self.assertEqual(placed["status"], "FILLED")
        self.assertEqual(placed["tradeMode"], "REAL")
        self.assertEqual(fake.order_check_calls, 2)
        self.assertEqual(fake.order_send_calls, 1)

    def test_reject_environment_mismatch(self):
        fake = FakeMt5(trade_mode=FakeMt5.ACCOUNT_TRADE_MODE_DEMO)
        svc = mt5_core.MT5BridgeService(mt5_module=fake)
        with self.assertRaises(mt5_core.BridgeError) as ctx:
            svc.connect(environment="real")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("MT5 terminal authenticated a DEMO account", str(ctx.exception))

    def test_reject_contest_mode(self):
        fake = FakeMt5(trade_mode=FakeMt5.ACCOUNT_TRADE_MODE_CONTEST)
        svc = mt5_core.MT5BridgeService(mt5_module=fake)
        svc.connect()
        with self.assertRaises(mt5_core.BridgeError) as ctx:
            svc.place_order(environment="demo", symbol="EURUSD", side="BUY", order_type="MARKET", volume=0.01)
        self.assertEqual(ctx.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
