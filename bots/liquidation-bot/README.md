# StellarLend Liquidation Bot

Automated off-chain bot that monitors position health on the StellarLend
protocol and executes liquidations and auction bids when profitable.

Resolves **Issue #1402** — Add liquidation bot interface.  
Optimisation wave: **drips-wave · high · 200-points**

---

## Overview

The liquidation bot connects to the StellarLend API over both HTTP polling
and a WebSocket health-feed, identifies under-collateralised positions, and
submits liquidation transactions when the expected net profit exceeds a
configurable minimum threshold.

A companion `AuctionBidderService` monitors Dutch-auction events and places
bids when the discount exceeds a configurable floor.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Liquidation Bot                              │
│                                                                      │
│  ┌──────────────┐  health_update   ┌────────────────────────────┐   │
│  │  WebSocket   │ ───────────────▶ │   evaluatePositions()      │   │
│  │  Feed        │                  │   • filter HF < 1.2        │   │
│  └──────────────┘                  │   • check min profit       │   │
│                                    │   • in-flight dedup guard  │   │
│  ┌──────────────┐  HTTP poll       │   • circuit-breaker check  │   │
│  │  REST API    │ ───────────────▶ └──────────────┬─────────────┘   │
│  │  /opport.    │                                 │                 │
│  └──────────────┘                                 ▼                 │
│                                    ┌────────────────────────────┐   │
│                                    │   executeLiquidation()     │   │
│                                    │   POST /lending/liquidate  │   │
│                                    │   → webhook notify         │   │
│                                    │   → metrics update         │   │
│                                    └────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- Node.js ≥ 18
- A funded Stellar keypair on the target network
- Access to a running StellarLend API (local or testnet)

### Install & run

```bash
cd bots/liquidation-bot
cp .env.example .env
# fill in BOT_SECRET_KEY, BOT_PUBLIC_KEY, API_BASE_URL, WS_URL
npm install
npm start
```

### Dry-run mode (safe to test)

```bash
DRY_RUN=true npm start
```

In dry-run mode the bot evaluates positions and logs what it *would* do, but
makes no on-chain calls and sends no webhooks.

---

## Configuration

Copy `.env.example` to `.env` and edit:

| Variable | Default | Description |
|---|---|---|
| `STELLAR_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `STELLAR_RPC_URL` | horizon-testnet | Soroban RPC endpoint |
| `STELLAR_HORIZON_URL` | horizon-testnet | Horizon endpoint |
| `BOT_SECRET_KEY` | *(required)* | Stellar secret key (`S...`) |
| `BOT_PUBLIC_KEY` | *(required)* | Corresponding public key (`G...`) |
| `MIN_PROFIT_THRESHOLD_XLM` | `1.0` | Minimum net profit to attempt liquidation |
| `MAX_GAS_PRICE_STROOPS` | `100000` | Max gas price per transaction |
| `LIQUIDATION_TARGET_STRATEGY` | `highest_profit` | `highest_profit` \| `highest_risk` \| `lowest_hf` |
| `POLL_INTERVAL_MS` | `5000` | How often to poll the REST API (ms) |
| `DRY_RUN` | `true` | Set to `false` to submit real transactions |
| `MAX_CONCURRENT_LIQUIDATIONS` | `3` | Max parallel liquidations in-flight |
| `WS_URL` | `ws://localhost:3000/…` | WebSocket health-feed URL |
| `API_BASE_URL` | `http://localhost:3000/api` | REST API base URL |
| `LIQUIDATION_WEBHOOK_URL` | *(disabled)* | URL for signed `liquidation.confirmed` notifications |
| `LIQUIDATION_WEBHOOK_SECRET` | *(disabled)* | Shared secret for HMAC-SHA256 signatures |
| `WEBHOOK_MAX_ATTEMPTS` | `3` | Max delivery attempts (including first) |
| `WEBHOOK_RETRY_DELAY_MS` | `500` | Initial retry delay; doubles after each failure |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

---

## Position Discovery API

The bot discovers liquidatable positions by polling:

```
GET /api/liquidations/opportunities?maxHf=1.2&sortBy=netProfitStroops&sortDir=desc
```

Response shape:

```json
{
  "opportunities": [
    {
      "address": "GXXX...",
      "collateralAsset": "USDC",
      "debtAsset": "XLM",
      "collateralValue": 1500000,
      "debtValue": 1000000,
      "healthFactor": 0.98,
      "estimatedProfit": 50000,
      "gasCostStroops": 10000,
      "netProfit": 40000
    }
  ]
}
```

It also subscribes to real-time updates via WebSocket:

```
ws://<host>/api/ws/health-updates
```

Messages with `type: "health_update"` or `type: "health_snapshot"` carry
the same `PositionHealth` shape and are processed immediately.

---

## Liquidation Execution

For each selected position the bot calls:

```
POST /api/lending/liquidate
{
  "positionAddress": "GXXX...",
  "maxRepayAmount": "500000"
}
```

`maxRepayAmount` is set to 50% of the current debt value, within the
protocol's close-factor cap.

---

## Target Strategies

| Strategy | Behaviour |
|---|---|
| `highest_profit` | Sort by `netProfit` descending — maximise per-tx earnings |
| `highest_risk` | Sort by `healthFactor` ascending — prioritise most dangerous positions |
| `lowest_hf` | Alias for `highest_risk` |

---

## Performance Optimisations

This wave adds three targeted fixes for the previously measured tail-latency:

### 1 · Per-address in-flight deduplication

**Problem:** Both the WebSocket handler and the poll loop call
`evaluatePositions()`. If both fire within the same event-loop window, the
same under-collateralised position could enter `executeLiquidation()` twice
simultaneously — the second call wastes a concurrency slot and always fails
(the position is already being liquidated or is no longer eligible).

**Fix:** A `Set<string>` (`inFlight`) is checked before entering
`executeLiquidation`. If the address is already present the attempt is
silently skipped and the `liquidation_skipped_inflight_total` counter
increments. The entry is removed in `finaliseLiquidation()` whether the call
succeeds or fails.

Same guard applies to `AuctionBidderService` for auction IDs.

### 2 · Per-address circuit breaker

**Problem:** A position whose on-chain state makes liquidation permanently
impossible (locked by another liquidator, temporarily healthy after a price
tick, gas too high) will be retried on every poll cycle, burning RPC quota
and blocking the concurrency cap for positions that *can* be liquidated.

**Fix:** `CircuitBreakerRegistry` tracks consecutive failures per address
using a standard closed → open → half-open state machine:

| State | Behaviour |
|---|---|
| `closed` | Attempts are allowed; failure counter increments on each failure |
| `open` | All attempts blocked for `openWindowMs` (default 60 s) |
| `half-open` | One probe attempt allowed after the window; success closes, failure re-opens |

Threshold and window are configurable via constructor options. The registry
is exposed through `bot.getBreakerRegistry()` for operator inspection.

### 3 · In-process metrics

`BotMetrics` (singleton `botMetrics`) tracks the following without any
external dependency:

| Metric | Type | Description |
|---|---|---|
| `liquidation_attempts_total` | counter | Every call to `executeLiquidation` |
| `liquidation_successes_total` | counter | Confirmed successful liquidations |
| `liquidation_failures_total` | counter | Failed liquidation attempts |
| `liquidation_skipped_inflight_total` | counter | Skipped: already in-flight |
| `liquidation_skipped_circuitbreaker_total` | counter | Skipped: breaker open |
| `bid_attempts_total` | counter | Every call to `placeBid` |
| `bid_successes_total` | counter | Confirmed successful bids |
| `bid_failures_total` | counter | Failed bid attempts |
| `bid_skipped_inflight_total` | counter | Skipped: auction already in-flight |
| `active_liquidations` | gauge | Current in-flight liquidation count |
| `active_bids` | gauge | Current in-flight bid count |
| `circuit_breaker_open_count` | gauge | Addresses with an open breaker |
| `avg_liquidation_latency_ms` | gauge | Welford rolling mean (ms) |
| `avg_bid_latency_ms` | gauge | Welford rolling mean (ms) |
| `webhook_deliveries_total` | counter | Successful webhook deliveries |
| `webhook_failures_total` | counter | Failed webhook deliveries |

Access the current snapshot from any process inspector or health endpoint:

```ts
import { botMetrics } from './metrics';
const snap = botMetrics.getSnapshot();
console.log(snap);
```

---

## Liquidation Webhooks

When a real liquidation succeeds, the bot POSTs a signed
`liquidation.confirmed` event if both `LIQUIDATION_WEBHOOK_URL` and
`LIQUIDATION_WEBHOOK_SECRET` are configured. Dry-run results are not sent.

```json
{
  "id": "liquidation_abc123_1710000000000",
  "type": "liquidation.confirmed",
  "createdAt": 1710000000000,
  "data": {
    "positionAddress": "GXXX...",
    "txHash": "abc123",
    "profitStroops": 40000,
    "timestamp": 1710000000000
  }
}
```

Request headers:

| Header | Value |
|---|---|
| `x-stellarlend-webhook-id` | Unique event ID |
| `x-stellarlend-webhook-timestamp` | Unix seconds |
| `x-stellarlend-webhook-signature` | `sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">` |

Network errors, timeouts, HTTP 429, and HTTP 5xx are retried up to
`WEBHOOK_MAX_ATTEMPTS` with exponential backoff. Other HTTP errors are not
retried. Consumers should use the event `id` for deduplication.

---

## Health Check & Stats

```ts
const stats = bot.getStats();
// { totalAttempted: 12, totalSuccessful: 10, totalProfit: 1_200_000 }

const snap = botMetrics.getSnapshot();
// { liquidation_attempts_total: 12, avg_liquidation_latency_ms: 230, ... }

const breaker = bot.getBreakerRegistry();
// breaker.getState('GXXX...') → 'closed' | 'open' | 'half-open'
// breaker.openCount() → number of currently-blocked addresses
```

Integrate with a process manager (PM2) to auto-restart on crash and wire
the stats into your existing dashboards.

---

## Security Notes

- **Never commit your secret key.** Use environment variables or a secrets manager.
- Run `DRY_RUN=true` on testnet first to validate your configuration.
- Use `MAX_CONCURRENT_LIQUIDATIONS=1` in production until behaviour is verified.
- The bot connects only to the endpoints you configure — no external calls are
  made without explicit configuration.

---

## Development

```bash
# Run all tests (unit + integration)
npm test

# Run with coverage
npm test -- --coverage

# Build
npm run build
```

---

## Architecture

```
bots/liquidation-bot/
├── src/
│   ├── index.ts                   Entry point — start/stop lifecycle
│   ├── liquidationBot.service.ts  Core bot: in-flight guard, circuit breaker, metrics
│   ├── auctionBidder.service.ts   Dutch-auction bidding: in-flight guard, metrics
│   ├── circuitBreaker.ts          Per-address closed/open/half-open state machine
│   ├── metrics.ts                 In-process counters, gauges, and rolling-mean latency
│   ├── liquidationWebhook.service.ts  Signed webhook delivery with exponential backoff
│   ├── config.ts                  Environment-based configuration
│   ├── logger.ts                  Structured logger
│   └── __tests__/
│       ├── circuitBreaker.test.ts
│       ├── metrics.test.ts
│       ├── liquidationBot.service.test.ts
│       ├── auctionBidder.service.test.ts
│       └── liquidationWebhook.service.test.ts
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Related Issues

- **#1402** — Add liquidation bot interface
- **#1403** — Add partial liquidation (`partial_liquidate` entrypoint)
- **#1400** — Flash loan support
- **#1401** — Flash loan reentrancy protection
