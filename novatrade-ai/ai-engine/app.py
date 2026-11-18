from datetime import datetime, timezone
from typing import List, Literal, Optional
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title='NovaTrade AI Quantitative Analysis Engine', version='0.2.0')


class CandleInput(BaseModel):
    time: float
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class AnalyseRequest(BaseModel):
    symbol: str = Field(default='EURUSD', pattern=r'^[A-Z0-9_-]{3,20}$')
    timeframe: Literal['1m', '5m', '15m', '1h'] = '1m'
    candles: Optional[List[CandleInput]] = None
    min_score: int = Field(default=65, ge=40, le=95)


def ema(values: np.ndarray, period: int) -> np.ndarray:
    alpha = 2.0 / (period + 1)
    out = np.empty_like(values, dtype=float)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
    return out


def rsi(values: np.ndarray, period: int = 14) -> float:
    if len(values) <= period:
        return 50.0
    delta = np.diff(values)
    gains = np.maximum(delta, 0.0)
    losses = np.maximum(-delta, 0.0)
    avg_gain = float(np.mean(gains[:period]))
    avg_loss = float(np.mean(losses[:period]))
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + float(gains[i])) / period
        avg_loss = (avg_loss * (period - 1) + float(losses[i])) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return float(100.0 - 100.0 / (1.0 + rs))


def macd(values: np.ndarray):
    ema12 = ema(values, 12)
    ema26 = ema(values, 26)
    line = ema12 - ema26
    signal = ema(line, 9)
    hist = line - signal
    return float(line[-1]), float(signal[-1]), float(hist[-1])


def bollinger(values: np.ndarray, period: int = 20, mult: float = 2.0):
    window = values[-period:]
    mid = float(np.mean(window))
    std = float(np.std(window))
    upper = mid + mult * std
    lower = mid - mult * std
    return upper, mid, lower


@app.get('/health')
def health():
    return {'status': 'ok', 'engine': 'quantitative-indicators', 'live_data': False}


@app.post('/analyse/demo')
def analyse_demo(req: AnalyseRequest):
    if not req.candles or len(req.candles) < 35:
        return {
            'signal': {
                'symbol': req.symbol,
                'direction': 'WAIT',
                'score': 0,
                'reasons': [
                    'Insufficient verified market candles supplied (minimum 35 bars required).',
                    'The engine refuses to invent synthetic prices or fabricate signals.'
                ],
                'warning': 'NO VERIFIED CANDLES — WAIT. Supply live or historical candles from a documented provider.'
            },
            'source': 'no-market-data',
            'timestamp': datetime.now(timezone.utc).isoformat(),
        }

    closes = np.array([c.close for c in req.candles], dtype=float)
    ema9 = float(ema(closes, 9)[-1])
    ema21 = float(ema(closes, 21)[-1])
    ema50 = float(ema(closes, min(50, len(closes)))[-1])
    rsi14 = rsi(closes, 14)
    macd_line, macd_sig, macd_hist = macd(closes)
    bb_upper, bb_mid, bb_lower = bollinger(closes, 20, 2.0)

    bull_points = 0
    bear_points = 0
    reasons = []

    if ema9 > ema21 > ema50:
        bull_points += 28
        reasons.append('EMA 9 > EMA 21 > EMA 50 bullish alignment')
    elif ema9 < ema21 < ema50:
        bear_points += 28
        reasons.append('EMA 9 < EMA 21 < EMA 50 bearish alignment')

    if macd_line > macd_sig and macd_hist > 0:
        bull_points += 24
        reasons.append('MACD bullish crossover with positive histogram')
    elif macd_line < macd_sig and macd_hist < 0:
        bear_points += 24
        reasons.append('MACD bearish crossover with negative histogram')

    if 45 <= rsi14 <= 68:
        bull_points += 20
        reasons.append(f'RSI(14) at {rsi14:.1f} supports bullish momentum')
    elif 32 <= rsi14 <= 55:
        bear_points += 20
        reasons.append(f'RSI(14) at {rsi14:.1f} supports bearish momentum')
    elif rsi14 < 30:
        bull_points += 18
        reasons.append(f'RSI(14) oversold ({rsi14:.1f})')
    elif rsi14 > 70:
        bear_points += 18
        reasons.append(f'RSI(14) overbought ({rsi14:.1f})')

    last_close = float(closes[-1])
    if last_close > bb_mid and last_close < bb_upper:
        bull_points += 15
    elif last_close < bb_mid and last_close > bb_lower:
        bear_points += 15

    net_bull = bull_points - bear_points
    direction = 'WAIT'
    score = max(bull_points, bear_points)
    if net_bull >= 20 and bull_points >= req.min_score:
        direction = 'CALL'
    elif -net_bull >= 20 and bear_points >= req.min_score:
        direction = 'PUT'

    return {
        'signal': {
            'symbol': req.symbol,
            'direction': direction,
            'score': int(min(100, score)),
            'reasons': reasons or ['Mixed indicator structure — holding WAIT'],
            'indicators': {
                'ema9': round(ema9, 6),
                'ema21': round(ema21, 6),
                'ema50': round(ema50, 6),
                'rsi14': round(rsi14, 2),
                'macd': round(macd_line, 6),
                'macdSignal': round(macd_sig, 6),
                'bbUpper': round(bb_upper, 6),
                'bbMiddle': round(bb_mid, 6),
                'bbLower': round(bb_lower, 6),
            },
            'warning': 'Quantitative indicator output on supplied candles.',
        },
        'source': 'python-quant-engine',
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }
