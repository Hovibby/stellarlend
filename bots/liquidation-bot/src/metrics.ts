/**
 * In-process metrics for the liquidation bot.
 *
 * Intentionally dependency-free: no Prometheus client, no external agent.
 * Values are exposed via getSnapshot() so any exporter (StatsD push,
 * Prometheus text, structured log flush) can consume them without coupling
 * the bot to a specific observability stack.
 *
 * Counters only increment; gauges can be set freely.
 * All writes are synchronous and non-blocking.
 */

export interface BotMetricsSnapshot {
  // Liquidation bot counters
  liquidation_attempts_total: number;
  liquidation_successes_total: number;
  liquidation_failures_total: number;
  liquidation_skipped_inflight_total: number;
  liquidation_skipped_circuitbreaker_total: number;
  // Auction bidder counters
  bid_attempts_total: number;
  bid_successes_total: number;
  bid_failures_total: number;
  bid_skipped_inflight_total: number;
  // Gauges
  active_liquidations: number;
  active_bids: number;
  circuit_breaker_open_count: number;
  // Latency (rolling last-N average in ms)
  avg_liquidation_latency_ms: number;
  avg_bid_latency_ms: number;
  // Webhook
  webhook_deliveries_total: number;
  webhook_failures_total: number;
}

/** Constant-time rolling-mean that keeps no unbounded history. */
class RollingMean {
  private n = 0;
  private mean = 0;

  record(value: number): void {
    this.n += 1;
    // Welford online mean
    this.mean += (value - this.mean) / this.n;
  }

  get(): number {
    return Math.round(this.mean);
  }

  reset(): void {
    this.n = 0;
    this.mean = 0;
  }
}

class BotMetrics {
  // Liquidation counters
  liquidation_attempts_total = 0;
  liquidation_successes_total = 0;
  liquidation_failures_total = 0;
  liquidation_skipped_inflight_total = 0;
  liquidation_skipped_circuitbreaker_total = 0;
  // Auction bidder counters
  bid_attempts_total = 0;
  bid_successes_total = 0;
  bid_failures_total = 0;
  bid_skipped_inflight_total = 0;
  // Gauges
  active_liquidations = 0;
  active_bids = 0;
  circuit_breaker_open_count = 0;
  // Webhook
  webhook_deliveries_total = 0;
  webhook_failures_total = 0;

  private liquidationLatency = new RollingMean();
  private bidLatency = new RollingMean();

  recordLiquidationLatency(ms: number): void {
    this.liquidationLatency.record(ms);
  }

  recordBidLatency(ms: number): void {
    this.bidLatency.record(ms);
  }

  getSnapshot(): BotMetricsSnapshot {
    return {
      liquidation_attempts_total: this.liquidation_attempts_total,
      liquidation_successes_total: this.liquidation_successes_total,
      liquidation_failures_total: this.liquidation_failures_total,
      liquidation_skipped_inflight_total: this.liquidation_skipped_inflight_total,
      liquidation_skipped_circuitbreaker_total: this.liquidation_skipped_circuitbreaker_total,
      bid_attempts_total: this.bid_attempts_total,
      bid_successes_total: this.bid_successes_total,
      bid_failures_total: this.bid_failures_total,
      bid_skipped_inflight_total: this.bid_skipped_inflight_total,
      active_liquidations: this.active_liquidations,
      active_bids: this.active_bids,
      circuit_breaker_open_count: this.circuit_breaker_open_count,
      avg_liquidation_latency_ms: this.liquidationLatency.get(),
      avg_bid_latency_ms: this.bidLatency.get(),
      webhook_deliveries_total: this.webhook_deliveries_total,
      webhook_failures_total: this.webhook_failures_total,
    };
  }

  /** Test helper — resets all counters and latency accumulators. */
  reset(): void {
    this.liquidation_attempts_total = 0;
    this.liquidation_successes_total = 0;
    this.liquidation_failures_total = 0;
    this.liquidation_skipped_inflight_total = 0;
    this.liquidation_skipped_circuitbreaker_total = 0;
    this.bid_attempts_total = 0;
    this.bid_successes_total = 0;
    this.bid_failures_total = 0;
    this.bid_skipped_inflight_total = 0;
    this.active_liquidations = 0;
    this.active_bids = 0;
    this.circuit_breaker_open_count = 0;
    this.webhook_deliveries_total = 0;
    this.webhook_failures_total = 0;
    this.liquidationLatency.reset();
    this.bidLatency.reset();
  }
}

/** Singleton shared by both bot services and exposed for testing. */
export const botMetrics = new BotMetrics();
