# Momentum Rider — cbBTC trading bot

[![make.fun](https://img.shields.io/badge/make.fun-btc--race--24h--20261123--0511-blue)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Node](https://img.shields.io/badge/node-22-blue)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A quiet trend bot for the make.fun race "Race a BTC trading bot live for 24 hours". It trades Coinbase Wrapped BTC (cbBTC) against USDC, one minute at a time, starting from $1,000.

## Strategy

Trade rarely, only with the trend behind it:

- **Entry** (full cash, while flat): EMA(12) crosses above EMA(40) **and** the close is at least 1.00% above the close 120 bars ago — a fresh up-cross confirmed by a real 2-hour rise. A cross with no rise behind it is a chop artefact.
- **Exit** (whole position): the close falls 2.00% below the highest close since entry (trailing stop). No fixed take-profit — a strong trend is exactly what pays — and no EMA cross-down exit, which whipsawed badly in backtests.
- **Cooldown**: no re-entry for 30 bars after a stop-out. No new buys in the last 60 bars of the window.

## Results

- **Dev window** (kit `grade-local`, exact fill model): net PnL **+$20.39**, 1 trade, max drawdown 1.98%, fees $0.81 — comfortably through the dev gate (net PnL > $0). Net PnL at 2x fees is still +$19.58.
- **Stress copies** of the dev window: mirrored −3.6% day −$19.50 (2 trades), −7% day −$26.91 (2 trades), −1.8% day / flat-chop day / time-reversed day $0.00 (no entry — the momentum filter keeps the bot in cash). Worst drawdown stays far under the 25% guardrail.

## Run

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout) via the kit's `vendor/makefun-bars.ts` shim, copied byte-identical from the competition kit. Standard library only, deterministic: float64 EMAs, no clock, no network, no randomness.

```sh
node main.ts
```

Grade locally with the competition kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <repo> --driver process
```
