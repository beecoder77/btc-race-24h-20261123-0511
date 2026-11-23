// Momentum-rider cbBTC bot for make.fun btc-race-24h-20261123-0511.
//
// Idea: one-minute cbBTC is noisy (1m-return stdev ~8 bps) and a full
// round trip costs ~26 bps, so frequent trading loses to fees. The money
// in this market sits in multi-hour trends: the dev window rose +3.64%
// with a single +2.29% hour doing most of the work, and the previous
// race's winner made just 2 trades for +2.16%. So this bot trades rarely
// and only with the trend behind it: it buys a fresh EMA up-cross that is
// confirmed by a real 2-hour rise, rides it with a trailing stop, and
// otherwise sits in cash. It never sells at a fixed target (a strong
// trend is exactly what pays), never averages down, and never chases a
// bounce in a falling market.
//
// Rules (parameters chosen from the dev window's own statistics and
// stress-tested on mirrored / rescaled copies of it, not fitted to one
// outcome):
// - Entry, full cash, only while flat: EMA(12) crosses above EMA(40)
//   AND the close is at least 1.00% above the close 120 bars ago
//   (momentum confirmation: a cross with no 2-hour rise behind it is a
//   chop artefact, and in every downside stress copy the confirmation
//   filter cut the loss roughly in half versus the bare cross).
// - Exit, whole position: the close falls 2.00% below the highest close
//   since entry (trailing stop). No EMA cross-down exit: on the dev
//   window the cross-down exit whipsawed the bot into 32 trades and
//   -$47, while the trailing stop alone made +$34.57 in 1 trade.
// - After a stop-out, no re-entry for 30 bars (cooldown against
//   whipsaw). No new buys in the last 60 bars of the window, so the
//   bot never buys right before the harness's final flatten.
// - Every order carries max_slippage_bps 150 (1-minute moves reach
//   ~72 bps); a fill the market refuses is simply retried by the
//   standing rule on the next bar while its reason still holds.
//
// Dev-window result (kit grade-local, process driver, exact fill model):
// net PnL +$20.39, 1 trade, max drawdown 1.98%, fees $0.81; net PnL at
// 2x fees +$19.58. Stress copies of the same window (corrected model,
// opens consistent with closes): mirrored -3.6% day -$19.50 (2 trades),
// -7% day -$26.91 (2 trades), -1.8% day / flat-chop day / time-reversed
// day $0.00 (no entry — the momentum filter keeps the bot in cash).
// Worst observed drawdown stays far under the 25% guardrail.
//
// Determinism: float64 EMAs (seeded as the mean of their first span of
// closes, as the kit's EMA baseline does), pure arithmetic on the bars
// the harness sends, no clock, no environment, no randomness. The same
// bars always produce the same orders.

import { runBars } from './vendor/makefun-bars.ts';
import type { OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// Both windows are 1,440 one-minute bars (RULES.txt). The count is used
// only to stop buying near the end of the window.
const TOTAL_BARS = 1440;
const FAST_SPAN = 12;
const SLOW_SPAN = 40;
// Entry needs a real rise behind the cross: 1.00% over 120 bars.
const MOMENTUM_BARS = 120;
const MOMENTUM_BPS = 100;
const TRAIL_BPS = 200; // 2.00% trailing stop from the peak close
const COOLDOWN_BARS = 30;
const NO_BUY_LAST_BARS = 60;
const MAX_SLIPPAGE_BPS = 150;
const BPS_DENOM = 10000;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

const fast: Ema = { span: FAST_SPAN, warm: [], value: null };
const slow: Ema = { span: SLOW_SPAN, warm: [], value: null };
// Gap (fast - slow) after the previous bar; null until both EMAs exist.
let prevGap: number | null = null;
// Closes of the scored bars, for the momentum lookback.
const closes: number[] = [];
// Highest close since the current entry (0 while flat).
let peak = 0;
// Scored-bar index from which re-entry is allowed again (after a stop-out).
let cooldownUntil = -1;
// Scored bars seen so far (warm-up batches excluded).
let scoredBars = 0;
let buySeq = 1;
let sellSeq = 1;

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);

    // Fold in this batch's fills first: a sell fill starts the cooldown.
    for (const f of batch.fills) {
      if (f.status === 'filled' && f.side === 'sell') {
        cooldownUntil = scoredBars + COOLDOWN_BARS;
        peak = 0;
      }
    }

    // Indicators read every batch, warm-up included (as the kit's EMA
    // baseline does); no order is sent while warming up.
    stepEma(fast, close);
    stepEma(slow, close);
    if (state.warmingUp) return [];
    scoredBars += 1;
    closes.push(close);

    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];
    const gap =
      fast.value !== null && slow.value !== null
        ? fast.value - slow.value
        : null;

    // Exit: trailing stop from the peak close since entry. The condition
    // persists while the position is held, so a refused sell is retried
    // on the next bar.
    if (held !== undefined) {
      if (close > peak) peak = close;
      if (peak > 0 && close <= peak * (1 - TRAIL_BPS / BPS_DENOM)) {
        orders.push({
          side: 'sell',
          symbol: SYMBOL,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
          client_id: `x${sellSeq++}`,
        });
        prevGap = gap;
        return orders;
      }
      prevGap = gap;
      return orders;
    }

    // Entry: fresh EMA up-cross, confirmed by a 2-hour rise, while flat,
    // out of cooldown, and not in the last bars of the window.
    peak = 0;
    const barsLeft = TOTAL_BARS - scoredBars;
    const momentumOk =
      closes.length > MOMENTUM_BARS &&
      closes[closes.length - 1]! >=
        closes[closes.length - 1 - MOMENTUM_BARS]! *
          (1 + MOMENTUM_BPS / BPS_DENOM);
    const crossUp =
      gap !== null && prevGap !== null && gap > 0 && prevGap <= 0;
    if (
      crossUp &&
      momentumOk &&
      scoredBars > cooldownUntil &&
      barsLeft > NO_BUY_LAST_BARS
    ) {
      const maxWeight =
        (BigInt(state.hello.caps.max_weight_bps) * state.equity) /
        BigInt(BPS_DENOM);
      let notional = state.cash < maxWeight ? state.cash : maxWeight;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
        orders.push({
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
          client_id: `e${buySeq++}`,
        });
        peak = close;
      }
    }
    prevGap = gap;
    return orders;
  },
});
