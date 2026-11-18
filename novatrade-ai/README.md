# NovaTrade AI — Autonomous Trading Research & Paper Platform

NovaTrade AI is a full-stack trading research and paper-trading platform featuring a deterministic quantitative market analysis engine, optional Gemini analyst commentary, Supabase Auth/PostgreSQL persistence, server-side autonomous paper trading scheduler, strict risk controls, and an extensible broker architecture starting with an IQ Option read-only connector bridge.

Real-money broker order execution remains intentionally locked until an authorised, documented broker API and independently verified execution controls are in place.

## Directory Structure
- `/` (`server.ts`, `src/`, `vite.config.ts`, `package.json`) — Unified port 3000 full-stack runtime (Express API + Vite SPA)
- `novatrade-ai/web/` — React 19 + TypeScript + Tailwind CSS dashboard (11 sections)
- `novatrade-ai/server/` — Modular Express + TypeScript backend (Market Data, Quant Engine, Trading & Risk Engine, Broker Registry, Supabase Admin)
- `novatrade-ai/supabase/` — Base schema (`schema.sql`) and additive migration (`migrations/001_complete_platform.sql`) with Row-Level Security
- `novatrade-ai/iq-connector/` — Self-hosted Python FastAPI IQ Option PRACTICE/read-only service (`IQ_CONNECTOR_URL`)
- `novatrade-ai/ai-engine/` — Standalone Python FastAPI quantitative indicator engine (`AI_ENGINE_URL`)
- `novatrade-ai/connector/` — Local CLI connectivity probe (`iqoption_probe.py`)

## Environment Variables
Copy `.env.example` to `.env` and populate as needed:
- `PORT` (default `3000` for root runtime, `4000` for standalone `server/`)
- `VITE_SUPABASE_URL` — Your existing Supabase Project URL
- `VITE_SUPABASE_ANON_KEY` — Your Supabase Publishable (anon) Key
- `SUPABASE_SERVICE_ROLE_KEY` — Server-side only key (never expose to frontend)
- `GEMINI_API_KEY` — Server-side only key for optional `gemini-4-hydrogen` market commentary
- `IQ_CONNECTOR_URL` — Optional URL to private `iq-connector` service (e.g. `http://127.0.0.1:8010`)
- `IQ_CONNECTOR_TOKEN` — Optional shared header secret for `iq-connector`
- `AI_ENGINE_URL` — Optional URL to standalone Python `ai-engine`

## Installation & Local Run

### Unified Full-Stack Runtime (Port 3000)
```bash
npm install
npm run build
npm run dev
```

### Standalone Subprojects
```bash
# Backend API (:4000)
cd novatrade-ai/server && npm install && npm run dev

# Frontend (:5173, proxies /api to :4000)
cd novatrade-ai/web && npm install && npm run dev
```

### Supabase Database Setup
Run `novatrade-ai/supabase/migrations/001_complete_platform.sql` in the Supabase SQL Editor. It is additive and idempotent, preserving existing tables and rows.

## API Documentation
- `GET /api/health` — System health, mode, scheduler state, Supabase/Gemini/connector flags
- `GET /api/supabase/status` — Supabase environment configuration check
- `GET /api/market/assets` — Supported FX, crypto, and commodity assets + timeframes
- `GET /api/market/status` — Live market-data provider availability
- `GET /api/market/candles?symbol=EURUSD&timeframe=1m&limit=140` — Live OHLCV candles + EMA/Bollinger overlays
- `POST /api/signals/analyse` & `POST /api/signals/demo` — Quantitative analysis + MTF alignment + walk-forward sample + optional Gemini note
- `GET /api/signals` — Stored signals log
- `POST /api/scanner/run` — Multi-asset quantitative scan
- `GET /api/mode` & `PUT /api/mode` — Switch operating mode (`signals` | `assisted` | `automatic`)
- `POST /api/assisted/propose`, `GET /api/assisted/proposals`, `POST /api/assisted/proposals/:id/approve`, `POST /api/assisted/proposals/:id/reject` — Mode B approval flow
- `GET /api/paper-trades`, `POST /api/paper-trades`, `POST /api/paper-trades/:id/settle`, `POST /api/paper-trades/:id/cancel` — Paper trade lifecycle
- `GET /api/analytics` — Win rate, net P&L, profit factor, max drawdown, equity curve, symbol breakdown
- `GET /api/risk/status`, `PUT /api/risk/settings`, `POST /api/risk/emergency-stop`, `POST /api/risk/reset-daily` — Risk controls
- `GET /api/ai/settings`, `PUT /api/ai/settings` — Strategy profile, score threshold, MTF filter, watchlist, expiry
- `POST /api/auto-paper/arm`, `GET /api/auto-paper/status`, `POST /api/auto-paper/evaluate`, `POST /api/auto-paper/cycle` — Mode C autonomous paper scheduler
- `GET /api/broker/status`, `GET /api/broker/catalog`, `POST /api/broker/iq/connect`, `POST /api/broker/iq/disconnect`, `GET /api/broker/iq/balance`, `GET /api/broker/iq/assets`, `POST /api/broker/iq/candles`, `GET /api/broker/iq/history` — Broker status & IQ Option read-only bridge
- `POST /api/live-trading/enable`, `POST /api/live-trades` — Fail-closed live execution locks (`409` / `403`)
- `GET /api/activity` — Account activity log

## Production Deployment
```bash
npm install
npm run lint
npm run build
NODE_ENV=production npm start
```
