# NovaTrade AI — MT5 + IQ Option Integration Architecture

Active integrations in NovaTrade AI are scoped strictly to **two** brokers:

## 1. MetaTrader 5 (MT5) — Official Python SDK Bridge (`novatrade-ai/mt5-connector`)
- **API Type**: Official MetaQuotes `MetaTrader5` Python package wrapped in a private FastAPI microservice (`app.py` + `mt5_core.py`).
- **Host Requirement**: Requires Windows x64 + running MetaTrader 5 Desktop Terminal (`terminal64.exe`).
- **Safety Lock**: Enforces `mt5.account_info().trade_mode == ACCOUNT_TRADE_MODE_DEMO`. Real/contest accounts are disconnected (`mt5.shutdown()`) and rejected fail-closed.
- **Capabilities**:
  - Demo connection & disconnect
  - Account balance, equity, free margin & leverage sync
  - Live tick prices (`bid`, `ask`, `last`, `spread`) via `symbol_info_tick`
  - Candlestick OHLCV history (`1m`, `5m`, `15m`, `1h`) via `copy_rates_from_pos`
  - Open positions (`positions_get`) & deal history (`history_deals_get`)
  - Pre-flight order validation (`mt5.order_check`) + guarded demo order routing (`mt5.order_send`)

## 2. IQ Option — Unofficial Community Connector (`novatrade-ai/iq-connector`)
- **API Type**: **Unofficial** community `iqoptionapi` package (NOT an official public IQ Option retail API).
- **Safety Lock**: Credentials (`IQ_EMAIL`, `IQ_PASSWORD`) stay strictly in connector host environment variables (never over HTTP or in frontend). Locked to `PRACTICE` mode; order placement endpoints are absent (fail-closed read-only).
- **Capabilities**:
  - Practice balance inspection & asset availability (`/account`, `/balance`, `/assets`)
  - Historical candlestick retrieval (`/candles`) & derived latest reference close (`/price/{symbol}`)
  - Read-only option history (`/history`) where supported by the upstream fork
  - Order execution: **Disabled / Locked**
