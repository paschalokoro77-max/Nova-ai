import { GoogleGenAI, Type } from '@google/genai';
import type { QuantAnalysisResult } from './quantEngine.ts';

export interface GeminiCommentary {
  available: boolean;
  model: string;
  summary: string | null;
  riskNote: string | null;
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

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|500|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function generateGeminiExplanation(analysis: QuantAnalysisResult): Promise<GeminiCommentary> {
  const client = getClient();
  if (!client) {
    return {
      available: false,
      model: 'gemini-4-hydrogen',
      summary: null,
      riskNote: null,
      error: 'GEMINI_API_KEY is not configured; quantitative indicators remain active.',
    };
  }

  if (!analysis.indicators) {
    return {
      available: false,
      model: 'gemini-4-hydrogen',
      summary: null,
      riskNote: null,
      error: 'No verified indicators available for commentary.',
    };
  }

  const ms = analysis.indicators.marketStructure;
  const cal = analysis.confidenceCalibration;
  const pillars = analysis.pillars;
  const compat = analysis.timeframeExpiryCompatibility;
  const inst = analysis.instrumentProfile;

  const prompt = [
    `Provide an objective 2-sentence institutional quantitative commentary and 1-sentence invalidation/risk note grounded strictly in the metrics below.`,
    `Do NOT invent prices, guarantee wins, or contradict the quantitative decision (${analysis.direction}).`,
    `Asset: ${analysis.symbol} (${analysis.timeframe}) | Class: ${inst?.assetClass ?? 'GENERAL'} | Provider: ${analysis.provider}`,
    `Market Regime: ${analysis.marketRegime ?? 'UNKNOWN'} | Adaptive Strategy: ${analysis.activeStrategy ?? 'UNKNOWN'}`,
    `Decision: ${analysis.direction} | Calibrated Confidence: ${analysis.score}/100 (Bull ${analysis.bullishScore} / Bear ${analysis.bearishScore})`,
    cal
      ? `Calibration: Raw ${cal.rawScore} -> Calibrated ${cal.calibratedScore} (${cal.independentConfirmations}/5 pillars, Conflict -${cal.conflictPenalty}, Regime ${cal.regimeAdjustment >= 0 ? '+' : ''}${cal.regimeAdjustment}, Hist ${cal.historicalAdjustment >= 0 ? '+' : ''}${cal.historicalAdjustment})`
      : null,
    pillars
      ? `Pillars: Trend(${pillars.trendStructure.verdict}), Momentum(${pillars.momentum.verdict}), Vol/Timing(${pillars.volatilityRegime.verdict}), PA/SR(${pillars.priceActionSR.verdict}), MTF(${pillars.multiTimeframe.verdict})`
      : null,
    `Price: ${analysis.entryPrice} | Trend: ${analysis.indicators.trend} (${ms?.structure ?? 'N/A'}) | Volatility: ${analysis.indicators.volatilityRegime} (ATR% ${analysis.indicators.atrPct})`,
    `Structure: ADX(14)=${analysis.indicators.adx14 ?? ms?.adx14 ?? 'N/A'}, ER=${analysis.indicators.efficiencyRatio ?? ms?.efficiencyRatio ?? 'N/A'}, Extension=${ms?.extensionAtr ?? 'N/A'} ATR, Breakout=${ms?.breakoutState ?? 'NONE'}`,
    `RSI(14): ${analysis.indicators.rsi14} | MACD Hist: ${analysis.indicators.macdHistogram} | BB %B: ${analysis.indicators.bbPercentB}`,
    `Support: ${analysis.indicators.nearestSupport} | Resistance: ${analysis.indicators.nearestResistance}`,
    `MTF (${analysis.mtf?.higherTimeframe}): ${analysis.mtf?.alignment} (${analysis.mtf?.higherTrend}, HTF RSI ${analysis.mtf?.higherRsi ?? 'N/A'})`,
    compat ? `Timeframe/Expiry Fit: ${compat.status} (${compat.requestedExpirySeconds}s = ${compat.barFraction} bars; rec ${compat.recommendedExpirySeconds}s)` : null,
    inst ? `Instrument Behavior: ${inst.note}` : null,
    `Patterns: ${analysis.indicators.patterns.join(', ') || 'None'}`,
    `Walk-forward Backtest Sample: ${analysis.backtest.sampleSize} trades, win rate: ${analysis.backtest.winRatePct ?? 'N/A'}%`,
    analysis.direction === 'WAIT' && analysis.rejectionReasons?.length
      ? `WAIT Gate Reasons: ${analysis.rejectionReasons.slice(0, 3).join(' | ')}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'You are an institutional quantitative market analyst. Summarize the provided regime, multi-pillar structure, timeframe-expiry fit, and indicator metrics factually in 2 concise sentences plus 1 concrete risk invalidation sentence. Never promise profits or override the quantitative decision.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: 'Concise 2-sentence quantitative summary referencing regime, pillars, and indicator structure.',
              },
              riskNote: {
                type: Type.STRING,
                description: 'Single-sentence risk invalidation level, volatility caution, or WAIT rationale.',
              },
            },
            required: ['summary', 'riskNote'],
          },
        },
      });
      const raw = (response.text || '{}').trim();
      const parsed = JSON.parse(raw) as { summary?: string; riskNote?: string };
      return {
        available: true,
        model: 'gemini-4-hydrogen',
        summary: parsed.summary || null,
        riskNote: parsed.riskNote || null,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < 2 && isTransientError(err)) {
        await delay(300 * (attempt + 1));
        continue;
      }
      break;
    }
  }

  return {
    available: false,
    model: 'gemini-4-hydrogen',
    summary: null,
    riskNote: null,
    error: lastErr instanceof Error ? lastErr.message : 'Gemini commentary failed',
  };
}

