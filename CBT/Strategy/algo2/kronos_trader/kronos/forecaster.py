"""Kronos forecaster — runs HuggingFace model when available, falls back to technical proxy."""
import numpy as np
from dataclasses import dataclass
from typing import Optional


@dataclass
class KronosForecast:
    bullish_prob: float
    bearish_prob: float
    volatility_expansion_prob: float
    confidence: float
    source: str   # 'kronos_model' | 'technical_proxy'


class KronosForecaster:
    def __init__(self, config: dict):
        self.cfg = config
        self.enabled = config.get('enabled', False)
        self._model = None
        self._processor = None

        if self.enabled:
            self._try_load_model()

    def _try_load_model(self):
        try:
            from .model_loader import KronosModelLoader
            loader = KronosModelLoader(model_size=self.cfg.get('model_size', 'base'))
            self._model, self._processor = loader.load()
        except Exception as e:
            print(f"[Kronos] Model load failed ({e}), using technical proxy")
            self._model = None

    def forecast(self, df) -> KronosForecast:
        if self._model is not None:
            return self._forecast_with_model(df)
        return self._technical_proxy(df)

    def _technical_proxy(self, df) -> KronosForecast:
        """Estimate bullish probability from momentum + VWAP position."""
        if len(df) < 20:
            return KronosForecast(0.5, 0.5, 0.5, 0.3, 'technical_proxy')

        close = df['close'].values
        # Short-term momentum
        mom5 = (close[-1] - close[-5]) / close[-5]
        mom20 = (close[-1] - close[-20]) / close[-20]
        # RSI proxy
        deltas = np.diff(close[-15:])
        gains = np.where(deltas > 0, deltas, 0).mean()
        losses = np.where(deltas < 0, -deltas, 0).mean()
        rs = gains / (losses + 1e-9)
        rsi = 100 - 100 / (1 + rs)
        rsi_norm = rsi / 100

        # Combine: weighted average of signals
        bullish = 0.5 + 0.3 * np.tanh(mom5 * 20) + 0.2 * np.tanh(mom20 * 10) + 0.1 * (rsi_norm - 0.5)
        bullish = float(np.clip(bullish, 0.05, 0.95))

        # Volatility (ATR change)
        highs, lows = df['high'].values, df['low'].values
        atr_recent = (highs[-5:] - lows[-5:]).mean()
        atr_hist = (highs[-20:-5] - lows[-20:-5]).mean()
        vol_exp = float(np.clip(atr_recent / (atr_hist + 1e-9) - 0.5, 0, 1))

        confidence = 0.3 + 0.4 * abs(bullish - 0.5) * 2
        return KronosForecast(
            bullish_prob=round(bullish, 4),
            bearish_prob=round(1 - bullish, 4),
            volatility_expansion_prob=round(vol_exp, 4),
            confidence=round(confidence, 4),
            source='technical_proxy',
        )

    def _forecast_with_model(self, df) -> KronosForecast:
        # Full Kronos inference (requires model loaded)
        try:
            from .tokenizer_utils import df_to_kronos_input
            inputs = df_to_kronos_input(df, self.cfg.get('lookback_candles', 128))
            with __import__('torch').no_grad():
                outputs = self._model(**inputs)
            # Parse model outputs — structure depends on Kronos model config
            logits = outputs.logits if hasattr(outputs, 'logits') else outputs[0]
            probs = __import__('torch').softmax(logits[-1], dim=-1).numpy()
            bullish = float(probs[1]) if len(probs) > 1 else 0.5
            return KronosForecast(
                bullish_prob=round(bullish, 4),
                bearish_prob=round(1 - bullish, 4),
                volatility_expansion_prob=0.5,
                confidence=0.8,
                source='kronos_model',
            )
        except Exception as e:
            return self._technical_proxy(df)
