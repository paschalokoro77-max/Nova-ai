import { GoogleGenAI, Type } from '@google/genai';
import type { Timeframe } from './marketData.ts';

export type AndroidTradingAppName = 'MT5' | 'IQ_OPTION' | 'UNKNOWN';
export type AndroidAccountMode = 'DEMO' | 'PRACTICE' | 'REAL' | 'UNKNOWN';

export const ANDROID_TRADING_PACKAGES = {
  MT5: 'net.metaquotes.metatrader5',
  IQ_OPTION: 'com.iqoption',
} as const;

export interface AndroidScreenVisionInput {
  imageBase64: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  appPackageHint?: string | null;
  accessibilityText?: string[];
  notes?: string;
}

export interface AndroidScreenVisionResult {
  visionAvailable: boolean;
  model: string;
  appName: AndroidTradingAppName;
  appPackage: string;
  accountMode: AndroidAccountMode;
  detectedSymbol: string | null;
  normalizedSymbol: string | null;
  detectedTimeframeRaw: string | null;
  normalizedTimeframe: Timeframe | null;
  detectedPrice: number | null;
  detectedBalance: number | null;
  detectedCurrency: string | null;
  chartTrend: 'UPTREND' | 'DOWNTREND' | 'RANGING' | 'UNCLEAR';
  visualBias: 'CALL' | 'PUT' | 'WAIT';
  visualConfidence: number;
  candlestickObservations: string[];
  tradeButtonsVisible: boolean;
  detectedActionLabels: string[];
  summary: string;
  riskWarning: string;
  error?: string;
}

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export function normalizeAndroidPackageAndApp(
  appPackageHint?: string | null,
  extractedApp?: string | null
): { appName: AndroidTradingAppName; appPackage: string } {
  const pkg = (appPackageHint || '').trim().toLowerCase();
  const ext = (extractedApp || '').trim().toUpperCase();

  if (pkg.includes('metatrader5') || pkg.includes('metaquotes') || ext === 'MT5' || ext.includes('METATRADER')) {
    return { appName: 'MT5', appPackage: pkg || ANDROID_TRADING_PACKAGES.MT5 };
  }
  if (pkg.includes('iqoption') || ext === 'IQ_OPTION' || ext.includes('IQ OPTION') || ext.includes('IQOPTION')) {
    return { appName: 'IQ_OPTION', appPackage: pkg || ANDROID_TRADING_PACKAGES.IQ_OPTION };
  }
  return { appName: 'UNKNOWN', appPackage: pkg || 'unknown' };
}

export function normalizeDetectedSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let upper = raw.toUpperCase().trim();
  // Strip common mobile broker suffixes like "(OTC)", "-OTC", ".PRO", spaces, slashes
  upper = upper
    .replace(/\(OTC\)/g, '')
    .replace(/-OTC\b/g, '')
    .replace(/\bOTC\b/g, '')
    .replace(/[^A-Z0-9]/g, '');

  if (!upper) return null;
  if (upper === 'GOLD' || upper === 'XAU') return 'XAUUSD';
  if (upper === 'BTC' || upper === 'BTCUSDT') return 'BTCUSD';
  if (upper === 'ETH' || upper === 'ETHUSDT') return 'ETHUSD';
  if (upper === 'SOL' || upper === 'SOLUSDT') return 'SOLUSD';
  if (/^[A-Z0-9]{3,16}$/.test(upper)) return upper;
  return null;
}

export function normalizeDetectedTimeframe(raw: string | null | undefined): Timeframe | null {
  if (!raw) return null;
  const clean = raw.toUpperCase().replace(/\s+/g, '');
  if (clean === 'M1' || clean === '1M' || clean === '1MIN' || clean === '60S') return '1m';
  if (clean === 'M5' || clean === '5M' || clean === '5MIN' || clean === '300S') return '5m';
  if (clean === 'M15' || clean === '15M' || clean === '15MIN' || clean === '900S') return '15m';
  if (clean === 'H1' || clean === '1H' || clean === '60M' || clean === '1HR') return '1h';
  return null;
}

export function cleanBase64Image(raw: string): { valid: boolean; data: string; byteLength: number; error?: string } {
  const trimmed = raw.trim().replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '').replace(/\s+/g, '');
  if (!trimmed || trimmed.length < 128) {
    return { valid: false, data: '', byteLength: 0, error: 'Image payload is empty or too small.' };
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    return { valid: false, data: '', byteLength: 0, error: 'Image payload is not valid base64.' };
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.byteLength < 256) {
    return { valid: false, data: '', byteLength: buf.byteLength, error: 'Decoded image is too small.' };
  }
  if (buf.byteLength > 3 * 1024 * 1024) {
    return { valid: false, data: '', byteLength: buf.byteLength, error: 'Screenshot exceeds 3 MB limit.' };
  }
  return { valid: true, data: trimmed, byteLength: buf.byteLength };
}

export async function analyzeAndroidTradingScreen(
  input: AndroidScreenVisionInput
): Promise<AndroidScreenVisionResult> {
  const cleaned = cleanBase64Image(input.imageBase64);
  if (!cleaned.valid) {
    const appInfo = normalizeAndroidPackageAndApp(input.appPackageHint, null);
    return {
      visionAvailable: false,
      model: 'gemini-4-hydrogen',
      appName: appInfo.appName,
      appPackage: appInfo.appPackage,
      accountMode: 'UNKNOWN',
      detectedSymbol: null,
      normalizedSymbol: null,
      detectedTimeframeRaw: null,
      normalizedTimeframe: null,
      detectedPrice: null,
      detectedBalance: null,
      detectedCurrency: null,
      chartTrend: 'UNCLEAR',
      visualBias: 'WAIT',
      visualConfidence: 0,
      candlestickObservations: [],
      tradeButtonsVisible: false,
      detectedActionLabels: [],
      summary: 'Screenshot rejected before Gemini analysis.',
      riskWarning: cleaned.error || 'Invalid screenshot payload.',
      error: cleaned.error,
    };
  }

  const client = getClient();
  if (!client) {
    const appInfo = normalizeAndroidPackageAndApp(input.appPackageHint, null);
    return {
      visionAvailable: false,
      model: 'gemini-4-hydrogen',
      appName: appInfo.appName,
      appPackage: appInfo.appPackage,
      accountMode: 'UNKNOWN',
      detectedSymbol: null,
      normalizedSymbol: null,
      detectedTimeframeRaw: null,
      normalizedTimeframe: null,
      detectedPrice: null,
      detectedBalance: null,
      detectedCurrency: null,
      chartTrend: 'UNCLEAR',
      visualBias: 'WAIT',
      visualConfidence: 0,
      candlestickObservations: [],
      tradeButtonsVisible: false,
      detectedActionLabels: [],
      summary: 'GEMINI_API_KEY is not configured on the server; visual screen reading is unavailable.',
      riskWarning: 'Configure GEMINI_API_KEY to enable multimodal mobile screen analysis.',
      error: 'GEMINI_API_KEY is not configured.',
    };
  }

  const a11ySnippet = Array.isArray(input.accessibilityText) && input.accessibilityText.length > 0
    ? `Accessibility text nodes from Android foreground window: ${input.accessibilityText.slice(0, 40).join(' | ')}`
    : 'No Accessibility text hierarchy provided.';

  const promptText = [
    'Analyze this Android mobile trading screen capture accurately and conservatively.',
    `Foreground package hint: ${input.appPackageHint || 'unspecified'}.`,
    a11ySnippet,
    input.notes ? `User note: ${input.notes.slice(0, 240)}` : '',
    'Rules:',
    '1. Identify whether this screen belongs to MetaTrader 5 (MT5), IQ_OPTION, or UNKNOWN.',
    '2. Identify account mode strictly from visible labels/colors: DEMO, PRACTICE, REAL, or UNKNOWN. Never guess REAL or DEMO if unclear.',
    '3. Extract the exact trading symbol, chart timeframe (e.g. M1, M5, 1m, 5m, 15m, H1), and visible current market price only if readable; otherwise return null.',
    '4. Only extract visible screen balance and currency if explicitly printed on screen; otherwise return null.',
    '5. Provide objective technical observations of visible candlesticks, support/resistance, momentum, or visible indicators, and classify chartTrend and visualBias (CALL, PUT, or WAIT). Default to WAIT if unclear or choppy.',
    '6. Detect whether order execution buttons (e.g. BUY/SELL or HIGHER/LOWER) are visibly present on screen.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const response = await client.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: input.mimeType,
              data: cleaned.data,
            },
          },
          { text: promptText },
        ],
      },
      config: {
        systemInstruction:
          'You are an institutional multimodal market chart vision analyzer. Inspect mobile trading app screenshots strictly from visible visual and text evidence. Never invent prices, balances, or profit guarantees.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            appName: { type: Type.STRING, description: 'MT5, IQ_OPTION, or UNKNOWN' },
            accountMode: { type: Type.STRING, description: 'DEMO, PRACTICE, REAL, or UNKNOWN' },
            detectedSymbol: { type: Type.STRING, nullable: true, description: 'Trading symbol shown on chart, e.g. EURUSD or EUR/USD (OTC)' },
            detectedTimeframe: { type: Type.STRING, nullable: true, description: 'Chart timeframe label, e.g. M1, M5, 1m, 15m, H1' },
            detectedPrice: { type: Type.NUMBER, nullable: true, description: 'Latest visible asset price on screen' },
            detectedBalance: { type: Type.NUMBER, nullable: true, description: 'Account balance visibly printed on screen, or null' },
            detectedCurrency: { type: Type.STRING, nullable: true, description: 'Balance currency code if visible, e.g. USD' },
            chartTrend: { type: Type.STRING, description: 'UPTREND, DOWNTREND, RANGING, or UNCLEAR' },
            visualBias: { type: Type.STRING, description: 'CALL, PUT, or WAIT' },
            visualConfidence: { type: Type.INTEGER, description: '0 to 100 subjective visual structure confidence' },
            candlestickObservations: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Concise factual observations from the chart image',
            },
            tradeButtonsVisible: { type: Type.BOOLEAN, description: 'Whether trade entry buttons (BUY/SELL or HIGHER/LOWER) are visible' },
            detectedActionLabels: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Visible button labels such as BUY, SELL, HIGHER, LOWER',
            },
            summary: { type: Type.STRING, description: 'Concise 2-sentence factual summary of the chart and screen state' },
            riskWarning: { type: Type.STRING, description: '1-sentence invalidation or screen-reading caution note' },
          },
          required: [
            'appName',
            'accountMode',
            'chartTrend',
            'visualBias',
            'visualConfidence',
            'candlestickObservations',
            'tradeButtonsVisible',
            'detectedActionLabels',
            'summary',
            'riskWarning',
          ],
        },
      },
    });

    const raw = (response.text || '{}').trim();
    const parsed = JSON.parse(raw) as {
      appName?: string;
      accountMode?: string;
      detectedSymbol?: string | null;
      detectedTimeframe?: string | null;
      detectedPrice?: number | null;
      detectedBalance?: number | null;
      detectedCurrency?: string | null;
      chartTrend?: string;
      visualBias?: string;
      visualConfidence?: number;
      candlestickObservations?: string[];
      tradeButtonsVisible?: boolean;
      detectedActionLabels?: string[];
      summary?: string;
      riskWarning?: string;
    };

    const appInfo = normalizeAndroidPackageAndApp(input.appPackageHint, parsed.appName);
    const rawAccountMode = (parsed.accountMode || 'UNKNOWN').toUpperCase();
    const accountMode: AndroidAccountMode =
      rawAccountMode === 'DEMO' || rawAccountMode === 'PRACTICE' || rawAccountMode === 'REAL'
        ? rawAccountMode
        : 'UNKNOWN';

    const rawTrend = (parsed.chartTrend || 'UNCLEAR').toUpperCase();
    const chartTrend =
      rawTrend === 'UPTREND' || rawTrend === 'DOWNTREND' || rawTrend === 'RANGING' ? rawTrend : 'UNCLEAR';

    const rawBias = (parsed.visualBias || 'WAIT').toUpperCase();
    const visualBias = rawBias === 'CALL' || rawBias === 'PUT' ? rawBias : 'WAIT';

    const normalizedSymbol = normalizeDetectedSymbol(parsed.detectedSymbol);
    const normalizedTimeframe = normalizeDetectedTimeframe(parsed.detectedTimeframe);

    return {
      visionAvailable: true,
      model: 'gemini-4-hydrogen',
      appName: appInfo.appName,
      appPackage: appInfo.appPackage,
      accountMode,
      detectedSymbol: parsed.detectedSymbol || null,
      normalizedSymbol,
      detectedTimeframeRaw: parsed.detectedTimeframe || null,
      normalizedTimeframe,
      detectedPrice: typeof parsed.detectedPrice === 'number' && Number.isFinite(parsed.detectedPrice) ? parsed.detectedPrice : null,
      detectedBalance:
        typeof parsed.detectedBalance === 'number' && Number.isFinite(parsed.detectedBalance) ? parsed.detectedBalance : null,
      detectedCurrency: parsed.detectedCurrency ? String(parsed.detectedCurrency).toUpperCase().slice(0, 8) : null,
      chartTrend,
      visualBias,
      visualConfidence: Math.max(0, Math.min(100, Math.round(Number(parsed.visualConfidence) || 0))),
      candlestickObservations: Array.isArray(parsed.candlestickObservations)
        ? parsed.candlestickObservations.slice(0, 6).map(String)
        : [],
      tradeButtonsVisible: Boolean(parsed.tradeButtonsVisible),
      detectedActionLabels: Array.isArray(parsed.detectedActionLabels)
        ? parsed.detectedActionLabels.slice(0, 6).map(String)
        : [],
      summary: parsed.summary || 'Screen analyzed via Gemini Vision.',
      riskWarning:
        parsed.riskWarning || 'Screen OCR observations are advisory only and must pass quantitative and risk validation.',
    };
  } catch (err) {
    const appInfo = normalizeAndroidPackageAndApp(input.appPackageHint, null);
    return {
      visionAvailable: false,
      model: 'gemini-4-hydrogen',
      appName: appInfo.appName,
      appPackage: appInfo.appPackage,
      accountMode: 'UNKNOWN',
      detectedSymbol: null,
      normalizedSymbol: null,
      detectedTimeframeRaw: null,
      normalizedTimeframe: null,
      detectedPrice: null,
      detectedBalance: null,
      detectedCurrency: null,
      chartTrend: 'UNCLEAR',
      visualBias: 'WAIT',
      visualConfidence: 0,
      candlestickObservations: [],
      tradeButtonsVisible: false,
      detectedActionLabels: [],
      summary: 'Gemini visual analysis request failed.',
      riskWarning: err instanceof Error ? err.message : 'Unable to analyze screenshot.',
      error: err instanceof Error ? err.message : 'Gemini visual analysis failed.',
    };
  }
}
