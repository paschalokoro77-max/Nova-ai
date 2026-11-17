import { parseIqConnectorConfig } from './brokers/iqOption.ts';

export type Timeframe = '1m' | '5m' | '15m' | '1h';

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AssetDefinition {
  symbol: string;
  name: string;
  category: 'FX' | 'CRYPTO' | 'COMMODITY';
  instrumentType: 'FOREX' | 'CRYPTO' | 'COMMODITY';
  krakenFiatPair?: string; // strictly fiat-to-fiat pairs on Kraken
  krakenCryptoPair?: string;
  binanceSymbol?: string;
  yahooSymbol?: string;
  decimals: number;
  binaryOptionsOfferedByBroker?: boolean;
}

export const SUPPORTED_ASSETS: AssetDefinition[] = [
  { symbol: 'EURUSD', name: 'EUR / USD', category: 'FX', instrumentType: 'FOREX', yahooSymbol: 'EURUSD=X', krakenFiatPair: 'EURUSD', decimals: 5 },
  { symbol: 'GBPUSD', name: 'GBP / USD', category: 'FX', instrumentType: 'FOREX', yahooSymbol: 'GBPUSD=X', krakenFiatPair: 'GBPUSD', decimals: 5 },
  { symbol: 'USDJPY', name: 'USD / JPY', category: 'FX', instrumentType: 'FOREX', yahooSymbol: 'USDJPY=X', krakenFiatPair: 'USDJPY', decimals: 3 },
  { symbol: 'EURJPY', name: 'EUR / JPY', category: 'FX', instrumentType: 'FOREX', yahooSymbol: 'EURJPY=X', decimals: 3 },
  { symbol: 'AUDUSD', name: 'AUD / USD', category: 'FX', instrumentType: 'FOREX', yahooSymbol: 'AUDUSD=X', krakenFiatPair: 'AUDUSD', decimals: 5 },
  { symbol: 'USDCAD', name: 'USD / CAD', category: 'FX', instrumentType: 'FOREX', yahooSymbol: 'USDCAD=X', krakenFiatPair: 'USDCAD', decimals: 5 },
  { symbol: 'USDCHF', name: 'USD / CHF', category: 'FX', instrumentType: 'FOREX', yahooSymbol: 'USDCHF=X', decimals: 5 },
  { symbol: 'EURGBP', name: 'EUR / GBP', category: 'FX', instrumentType: 'FOREX', yahooSymbol: 'EURGBP=X', decimals: 5 },
  { symbol: 'NZDUSD', name: 'NZD / USD', category: 'FX', instrumentType: 'FOREX', yahooSymbol: 'NZDUSD=X', decimals: 5 },
  { symbol: 'BTCUSD', name: 'BTC / USD', category: 'CRYPTO', instrumentType: 'CRYPTO', binanceSymbol: 'BTCUSDT', krakenCryptoPair: 'XBTUSD', decimals: 2 },
  { symbol: 'ETHUSD', name: 'ETH / USD', category: 'CRYPTO', instrumentType: 'CRYPTO', binanceSymbol: 'ETHUSDT', krakenCryptoPair: 'ETHUSD', decimals: 2 },
  { symbol: 'SOLUSD', name: 'SOL / USD', category: 'CRYPTO', instrumentType: 'CRYPTO', binanceSymbol: 'SOLUSDT', krakenCryptoPair: 'SOLUSD', decimals: 2 },
  { symbol: 'XAUUSD', name: 'Gold Futures (GC=F)', category: 'COMMODITY', instrumentType: 'COMMODITY', yahooSymbol: 'GC=F', decimals: 2 },
];

export type MarketStatus = 'LIVE' | 'DELAYED' | 'MARKET_CLOSED' | 'UNAVAILABLE' | 'OPEN' | 'DELAYED_OR_CLOSED';

export interface MarketDataResult {
  ok: boolean;
  symbol: string;
  instrumentType: AssetDefinition['instrumentType'];
  timeframe: Timeframe;
  candles: Candle[];
  currentPrice: number | null;
  priceChangePct: number | null;
  provider: string;
  marketStatus: MarketStatus;
  fetchedAt: string;
  lastBarAt: string | null;
  latencyMs: number;
  isStale: boolean;
  error?: string;
}

const cache = new Map<string, { expiresAt: number; result: MarketDataResult }>();

const TTL_MS: Record<Timeframe, number> = {
  '1m': 8_000,
  '5m': 20_000,
  '15m': 40_000,
  '1h': 60_000,
};

const KRAKEN_INTERVAL: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
};

const BINANCE_INTERVAL: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
};

const YAHOO_INTERVAL: Record<Timeframe, { interval: string; range: string }> = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '1h': { interval: '1h', range: '1mo' },
};

export function getAssetDefinition(symbol: string): AssetDefinition {
  const clean = symbol.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const found = SUPPORTED_ASSETS.find((a) => a.symbol === clean);
  if (found) return found;
  return {
    symbol: clean,
    name: clean,
    category: 'FX',
    instrumentType: 'FOREX',
    yahooSymbol: `${clean}=X`,
    decimals: clean.includes('JPY') ? 3 : 5,
  };
}

async function fetchYahooCandles(yahooSymbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
  const cfg = YAHOO_INTERVAL[timeframe];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${cfg.interval}&range=${cfg.range}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(6500),
    headers: { 'User-Agent': 'NovaTradeAI/1.0' },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const payload = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: Array<number | null>;
            high?: Array<number | null>;
            low?: Array<number | null>;
            close?: Array<number | null>;
            volume?: Array<number | null>;
          }>;
        };
      }>;
    };
  };
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote || timestamps.length < 10) throw new Error('Yahoo returned insufficient candles');

  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    if (o != null && h != null && l != null && c != null && c > 0) {
      candles.push({
        time: Number(timestamps[i]),
        open: Number(o),
        high: Number(h),
        low: Number(l),
        close: Number(c),
        volume: Number(quote.volume?.[i] ?? 0),
      });
    }
  }
  if (candles.length < 10) throw new Error('Yahoo returned insufficient valid bars');
  return candles.slice(-limit);
}

async function fetchKrakenCandles(pair: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
  const interval = KRAKEN_INTERVAL[timeframe];
  const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${interval}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6500) });
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
  const payload = (await res.json()) as { error?: string[]; result?: Record<string, unknown> };
  if (payload.error && payload.error.length > 0) {
    throw new Error(`Kraken API: ${payload.error.join(', ')}`);
  }
  const resultObj = payload.result || {};
  const dataKey = Object.keys(resultObj).find((k) => k !== 'last');
  if (!dataKey || !Array.isArray(resultObj[dataKey])) {
    throw new Error('Kraken returned empty OHLC series');
  }
  const rows = resultObj[dataKey] as Array<[number, string, string, string, string, string, string, number]>;
  const candles: Candle[] = rows
    .map((r) => ({
      time: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[6] || 0),
    }))
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close) && c.close > 0);
  if (candles.length < 10) throw new Error('Kraken returned insufficient candles');
  return candles.slice(-limit);
}

async function fetchBinanceCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
  const interval = BINANCE_INTERVAL[timeframe];
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${Math.min(limit, 1000)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6500) });
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const rows = (await res.json()) as Array<[number, string, string, string, string, string]>;
  if (!Array.isArray(rows) || rows.length < 10) throw new Error('Binance returned insufficient candles');
  return rows.map((r) => ({
    time: Math.floor(Number(r[0]) / 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5] || 0),
  }));
}

async function fetchIqConnectorCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[] | null> {
  const cfg = parseIqConnectorConfig();
  if (!cfg.urlValid || !cfg.url) return null;
  const intervalMap: Record<Timeframe, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = (process.env.IQ_CONNECTOR_TOKEN || '').trim();
  if (token) {
    headers['x-connector-token'] = token;
  }
  const res = await fetch(`${cfg.url}/candles`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ symbol, interval: intervalMap[timeframe], count: limit }),
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { candles?: Candle[] };
  if (!Array.isArray(data.candles) || data.candles.length < 10) return null;
  return data.candles;
}

export async function fetchMarketCandles(
  symbol: string,
  timeframe: Timeframe = '1m',
  limit = 160,
  bypassCache = false
): Promise<MarketDataResult> {
  const asset = getAssetDefinition(symbol);
  const key = `${asset.symbol}:${timeframe}:${limit}`;
  const now = Date.now();

  if (!bypassCache) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }
  }

  const started = Date.now();
  const errors: string[] = [];

  const attempt = async (providerName: string, loader: () => Promise<Candle[]>): Promise<MarketDataResult | null> => {
    try {
      const candles = await loader();
      const latest = candles[candles.length - 1];
      const first = candles[0];
      const changePct = first && first.close > 0 ? ((latest.close - first.close) / first.close) * 100 : 0;
      const nowEpoch = Math.floor(Date.now() / 1000);
      const ageSeconds = nowEpoch - latest.time;
      const maxStale = timeframe === '1m' ? 300 : timeframe === '5m' ? 900 : timeframe === '15m' ? 2700 : 7200;

      const currentDate = new Date();
      const dayOfWeek = currentDate.getUTCDay();
      const utcHour = currentDate.getUTCHours();
      const isWeekend =
        dayOfWeek === 6 ||
        (dayOfWeek === 5 && utcHour >= 22) ||
        (dayOfWeek === 0 && utcHour < 22);

      let marketStatus: MarketStatus = 'LIVE';
      if (isWeekend && asset.instrumentType === 'FOREX') {
        marketStatus = 'MARKET_CLOSED';
      } else if (ageSeconds > maxStale * 3) {
        marketStatus = 'MARKET_CLOSED';
      } else if (ageSeconds > maxStale) {
        marketStatus = 'DELAYED';
      } else {
        marketStatus = 'LIVE';
      }
      const isStale = marketStatus !== 'LIVE';

      const result: MarketDataResult = {
        ok: true,
        symbol: asset.symbol,
        instrumentType: asset.instrumentType,
        timeframe,
        candles,
        currentPrice: latest.close,
        priceChangePct: Number(changePct.toFixed(4)),
        provider: providerName,
        marketStatus,
        fetchedAt: new Date().toISOString(),
        lastBarAt: new Date(latest.time * 1000).toISOString(),
        latencyMs: Date.now() - started,
        isStale,
      };
      cache.set(key, { expiresAt: now + TTL_MS[timeframe], result });
      return result;
    } catch (err) {
      errors.push(`${providerName}: ${err instanceof Error ? err.message : 'unavailable'}`);
      return null;
    }
  };

  // Strict asset-class separation: Forex NEVER falls back to Crypto data.
  if (asset.instrumentType === 'FOREX') {
    if (asset.yahooSymbol) {
      const yahooFx = await attempt('Yahoo Finance FX (Currency Feed)', () => fetchYahooCandles(asset.yahooSymbol!, timeframe, limit));
      if (yahooFx) return yahooFx;
    }
    if (asset.krakenFiatPair) {
      const krakenFx = await attempt('Kraken Spot Fiat FX', () => fetchKrakenCandles(asset.krakenFiatPair!, timeframe, limit));
      if (krakenFx) return krakenFx;
    }
  } else if (asset.instrumentType === 'CRYPTO') {
    if (asset.binanceSymbol) {
      const binance = await attempt('Binance Spot Klines (Crypto)', () => fetchBinanceCandles(asset.binanceSymbol!, timeframe, limit));
      if (binance) return binance;
    }
    if (asset.krakenCryptoPair) {
      const krakenCrypto = await attempt('Kraken Spot Crypto OHLC', () => fetchKrakenCandles(asset.krakenCryptoPair!, timeframe, limit));
      if (krakenCrypto) return krakenCrypto;
    }
  } else if (asset.instrumentType === 'COMMODITY') {
    if (asset.yahooSymbol) {
      const yahooCmd = await attempt('Yahoo Finance Commodity Futures', () => fetchYahooCandles(asset.yahooSymbol!, timeframe, limit));
      if (yahooCmd) return yahooCmd;
    }
  }

  const iqCfg = parseIqConnectorConfig();
  if (iqCfg.urlValid && iqCfg.url) {
    const iq = await attempt('IQ Option Practice Connector', async () => {
      const c = await fetchIqConnectorCandles(asset.symbol, timeframe, limit);
      if (!c) throw new Error('IQ Connector returned no candles');
      return c;
    });
    if (iq) return iq;
  }

  return {
    ok: false,
    symbol: asset.symbol,
    instrumentType: asset.instrumentType,
    timeframe,
    candles: [],
    currentPrice: null,
    priceChangePct: null,
    provider: 'unavailable',
    marketStatus: 'UNAVAILABLE',
    fetchedAt: new Date().toISOString(),
    lastBarAt: null,
    latencyMs: Date.now() - started,
    isStale: true,
    error: errors.join(' | ') || `No verified ${asset.instrumentType} market-data provider available for ${asset.symbol}.`,
  };
}

export async function getMarketDataProviderStatus() {
  const sample = await fetchMarketCandles('EURUSD', '1m', 40);
  const crypto = await fetchMarketCandles('BTCUSD', '1m', 40);
  const iqCfg = parseIqConnectorConfig();
  return {
    fxAvailable: sample.ok,
    fxProvider: sample.provider,
    fxPrice: sample.currentPrice,
    fxMarketStatus: sample.marketStatus,
    cryptoAvailable: crypto.ok,
    cryptoProvider: crypto.provider,
    cryptoPrice: crypto.currentPrice,
    iqConnectorConfigured: iqCfg.configured,
    iqConnectorUrlValid: iqCfg.urlValid,
    binaryOptionsAvailable: false,
    binaryOptionsNote: 'Binary options instruments are only enabled when an authorised/connected broker feed confirms open contracts.',
    checkedAt: new Date().toISOString(),
  };
}
