# NovaTrade AI — Official MetaTrader 5 Python Bridge

This service implements MetaQuotes' **official `MetaTrader5` Python SDK** as a lightweight FastAPI microservice (`app.py` + `mt5_core.py`).

## Why a Windows Host / VPS Is Required
MetaQuotes' official `MetaTrader5` Python package communicates via local Windows IPC directly with an open **MetaTrader 5 Desktop Terminal (`terminal64.exe`)**. Because MetaQuotes only publishes `MetaTrader5` wheels for Windows x64 (`Python 3.8–3.12`) and does not offer a cloud REST API, a Linux container cannot open MT5 IPC directly.

To connect NovaTrade AI to a live MetaTrader 5 Demo account:
1. Run the **MetaTrader 5 Desktop Terminal** on a Windows machine or Windows VPS and sign into your **DEMO** account (or set `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER` in `.env` on that Windows host).
2. Enable **Algo Trading** in the MT5 terminal toolbar if placing automated demo orders.
3. Install dependencies and start this bridge on that Windows host:
   ```bash
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   uvicorn app:app --host 127.0.0.1 --port 8765
   ```
4. Expose the bridge privately over HTTPS (e.g., Cloudflare Tunnel, Tailscale Funnel, or reverse proxy with TLS) and set `MT5_BRIDGE_URL` + `MT5_BRIDGE_TOKEN` in NovaTrade AI (or in a user's encrypted Broker Vault account).

## Android-Only Users: Required Architecture & Connection Plan
You **cannot** run MetaQuotes' official `MetaTrader5` Python package directly inside Android (Termux, Pydroid, or an Android browser), and the **MetaTrader 5 Android mobile app** does not expose a local API or IPC socket.

To use NovaTrade AI from **Android only** with your `MetaQuotes-Demo` account:
1. **Windows Bridge Host (PC or Low-Cost Windows VPS)**: Run MetaTrader 5 Desktop (`terminal64.exe`, signed into `MetaQuotes-Demo`) and start `novatrade-ai/mt5-connector` (`uvicorn app:app --host 127.0.0.1 --port 8765`) on that Windows machine.
2. **Private HTTPS Tunnel**: Expose port `8765` over HTTPS (for example via Cloudflare Tunnel `cloudflared tunnel` or Tailscale) and set a strong `MT5_BRIDGE_TOKEN` in `.env`.
3. **Connect from Android Browser**: Open NovaTrade AI on your Android device, go to **Broker Connections -> MT5 MetaQuotes-Demo -> Credentials**, enter your **MT5 Python Bridge URL**, **Bridge Auth Token**, **MetaQuotes-Demo** server, **Demo Login ID**, and **Demo Password** (encrypted AES-256-GCM in the server vault; never stored in frontend code), then tap **Connect Demo**.

## Safety Guarantees
- **Demo Only (Fail-Closed)**: `ensure_demo_account()` inspects `mt5.account_info().trade_mode` and strictly enforces `ACCOUNT_TRADE_MODE_DEMO`. Any `REAL` (`ACCOUNT_TRADE_MODE_REAL`) or `CONTEST` terminal session is disconnected via `mt5.shutdown()` and rejected with HTTP `403`.
- **Pre-Flight Validation**: `POST /order/validate` normalizes volume against broker `volume_min` / `volume_max` / `volume_step`, auto-detects supported filling mode (`FOK`/`IOC`/`RETURN`), and executes official `mt5.order_check(request)` before any `order_send()`.
- **No Credential Exposure**: Passwords remain encrypted in the server vault or Windows host `.env` and are never stored in frontend code, logged, or returned in API responses.
