import { GoogleGenAI } from '@google/genai';
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

  const prompt = [
    `Provide a concise, objective 2-sentence technical commentary and 1-sentence invalidation/risk note for this quantitative market snapshot.`,
    `Do NOT invent prices, win guarantees, or change the quantitative decision (${analysis.direction}).`,
    `Asset: ${analysis.symbol} (${analysis.timeframe}) | Provider: ${analysis.provider}`,
    `Decision: ${analysis.direction} (Score: ${analysis.score}/100, Bull ${analysis.bullishScore} / Bear ${analysis.bearishScore})`,
    `Price: ${analysis.entryPrice} | Trend: ${analysis.indicators.trend} | Volatility: ${analysis.indicators.volatilityRegime} (ATR% ${analysis.indicators.atrPct})`,
    `RSI(14): ${analysis.indicators.rsi14} | MACD Hist: ${analysis.indicators.macdHistogram} | BB %B: ${analysis.indicators.bbPercentB}`,
    `Support: ${analysis.indicators.nearestSupport} | Resistance: ${analysis.indicators.nearestResistance}`,
    `MTF (${analysis.mtf?.higherTimeframe}): ${analysis.mtf?.alignment} (${analysis.mtf?.higherTrend})`,
    `Patterns: ${analysis.indicators.patterns.join(', ') || 'None'}`,
    `Backtest sample: ${analysis.backtest.sampleSize} trades, win rate: ${analysis.backtest.winRatePct ?? 'N/A'}%`,
    `Respond in JSON with keys "summary" and "riskNote".`,
  ].join('\n');

  try {
    const response = await client.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'You are an institutional quantitative market analyst. Summarize the provided indicator metrics factually in 2 concise sentences plus 1 risk invalidation sentence. Never promise profits or override the quantitative decision.',
        responseMimeType: 'application/json',
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
    return {
      available: false,
      model: 'gemini-4-hydrogen',
      summary: null,
      riskNote: null,
      error: err instanceof Error ? err.message : 'Gemini commentary failed',
    };
  }
}
