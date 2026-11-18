# IQ Option experimental connector (PRACTICE / read-only)

This is a self-hosted **PRACTICE / read-only** Python connector service that bridges the Node/Express backend (`IQ_CONNECTOR_URL`) to the community-maintained `iqoptionapi` package. It has **not** been authenticated against a live IQ Option account in this repository.

## Documented Limitations of `iqoptionapi`
1. **Unofficial reverse-engineered protocol**: IQ Option does not provide an officially supported public retail trading API. Private HTTP/WebSocket endpoints can break without notice.
2. **2FA / Captcha / Regional restrictions**: Accounts with 2FA, reCAPTCHA challenges, or restricted jurisdictions will fail automated login. Do not disable 2FA to force automation.
3. **TLS / Security risks in forks**: Several community forks disable SSL verification or use stale WebSocket pins. Audit the fork source code before installing it.
4. **No real-money order execution**: This connector intentionally locks to `PRACTICE` mode and exposes zero order-placement routes.
5. **Latency & candle availability**: Historical candles (`POST /candles`) and closed options (`GET /history`) depend on the unofficial client's socket state and are not guaranteed for latency-sensitive execution.

## Endpoints
- `GET /health` — connector runtime status, credential configuration, and connection state
- `POST /connect` — authenticate using local `IQ_EMAIL` / `IQ_PASSWORD` env vars (locked to `PRACTICE`)
- `GET /account` — account type and practice balance
- `GET /balance` — practice balance
- `GET /assets` — currently open binary/turbo/digital/forex/crypto instruments
- `POST /candles` — normalized OHLCV candles (`{"symbol":"EURUSD","interval":60,"count":100}`)
- `GET /history` — recent closed option history where supported by `get_optioninfo_v2`
- `POST /disconnect` — clear in-memory client session

## Local run
1. Create a Python 3.10+ virtual environment.
2. `pip install -r requirements.txt`
3. Review and install a compatible `iqoptionapi` fork in your private environment.
4. Set `IQ_EMAIL`, `IQ_PASSWORD`, and optionally `IQ_CONNECTOR_TOKEN` on your private host.
5. `uvicorn app:app --host 127.0.0.1 --port 8010`
6. For local same-machine testing, set `IQ_CONNECTOR_URL` to `http://127.0.0.1:8010`. When the NovaTrade web server runs in cloud containers (e.g. AI Studio / Cloud Run), deploy `iq-connector` separately and set `IQ_CONNECTOR_URL` to ONLY its public HTTPS URL (do **not** paste `IQ_CONNECTOR_URL=` inside the secret value and do **not** use `localhost`).
