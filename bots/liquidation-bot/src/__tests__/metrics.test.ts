import { botMetrics } from '../metrics';

beforeEach(() => {
  botMetrics.reset();
});

describe('BotMetrics', () => {
  describe('initial state', () => {
    it('all counters are zero after reset', () => {
      const snap = botMetrics.getSnapshot();
      expect(snap.liquidation_attempts_total).toBe(0);
      expect(snap.liquidation_successes_total).toBe(0);
      expect(snap.liquidation_failures_total).toBe(0);
      expect(snap.liquidation_skipped_inflight_total).toBe(0);
      expect(snap.liquidation_skipped_circuitbreaker_total).toBe(0);
      expect(snap.bid_attempts_total).toBe(0);
      expect(snap.bid_successes_total).toBe(0);
      expect(snap.bid_failures_total).toBe(0);
      expect(snap.bid_skipped_inflight_total).toBe(0);
      expect(snap.active_liquidations).toBe(0);
      expect(snap.active_bids).toBe(0);
      expect(snap.circuit_breaker_open_count).toBe(0);
      expect(snap.webhook_deliveries_total).toBe(0);
      expect(snap.webhook_failures_total).toBe(0);
    });

    it('rolling-mean latencies default to 0', () => {
      const snap = botMetrics.getSnapshot();
      expect(snap.avg_liquidation_latency_ms).toBe(0);
      expect(snap.avg_bid_latency_ms).toBe(0);
    });
  });

  describe('counter increments', () => {
    it('liquidation counters accumulate independently', () => {
      botMetrics.liquidation_attempts_total += 3;
      botMetrics.liquidation_successes_total += 2;
      botMetrics.liquidation_failures_total += 1;
      const snap = botMetrics.getSnapshot();
      expect(snap.liquidation_attempts_total).toBe(3);
      expect(snap.liquidation_successes_total).toBe(2);
      expect(snap.liquidation_failures_total).toBe(1);
    });

    it('skipped counters track deduplication and circuit-breaker hits', () => {
      botMetrics.liquidation_skipped_inflight_total += 5;
      botMetrics.liquidation_skipped_circuitbreaker_total += 2;
      const snap = botMetrics.getSnapshot();
      expect(snap.liquidation_skipped_inflight_total).toBe(5);
      expect(snap.liquidation_skipped_circuitbreaker_total).toBe(2);
    });

    it('bid counters accumulate independently', () => {
      botMetrics.bid_attempts_total += 4;
      botMetrics.bid_successes_total += 3;
      botMetrics.bid_failures_total += 1;
      botMetrics.bid_skipped_inflight_total += 2;
      const snap = botMetrics.getSnapshot();
      expect(snap.bid_attempts_total).toBe(4);
      expect(snap.bid_successes_total).toBe(3);
      expect(snap.bid_failures_total).toBe(1);
      expect(snap.bid_skipped_inflight_total).toBe(2);
    });
  });

  describe('gauge updates', () => {
    it('active_liquidations gauge reflects current concurrency', () => {
      botMetrics.active_liquidations = 2;
      expect(botMetrics.getSnapshot().active_liquidations).toBe(2);
      botMetrics.active_liquidations = 1;
      expect(botMetrics.getSnapshot().active_liquidations).toBe(1);
    });

    it('circuit_breaker_open_count gauge is set freely', () => {
      botMetrics.circuit_breaker_open_count = 3;
      expect(botMetrics.getSnapshot().circuit_breaker_open_count).toBe(3);
    });
  });

  describe('rolling-mean latency (Welford online mean)', () => {
    it('single recording equals that value', () => {
      botMetrics.recordLiquidationLatency(100);
      expect(botMetrics.getSnapshot().avg_liquidation_latency_ms).toBe(100);
    });

    it('two equal recordings produce the same average', () => {
      botMetrics.recordLiquidationLatency(200);
      botMetrics.recordLiquidationLatency(200);
      expect(botMetrics.getSnapshot().avg_liquidation_latency_ms).toBe(200);
    });

    it('converges toward the true mean over many samples', () => {
      // average of 1..10 = 5.5, rounds to 6 (Math.round on the online mean)
      for (let i = 1; i <= 10; i++) {
        botMetrics.recordLiquidationLatency(i * 10);
      }
      const snap = botMetrics.getSnapshot();
      // mean of [10,20,...,100] = 55 ms
      expect(snap.avg_liquidation_latency_ms).toBe(55);
    });

    it('bid and liquidation latency means are tracked separately', () => {
      botMetrics.recordLiquidationLatency(100);
      botMetrics.recordBidLatency(500);
      const snap = botMetrics.getSnapshot();
      expect(snap.avg_liquidation_latency_ms).toBe(100);
      expect(snap.avg_bid_latency_ms).toBe(500);
    });
  });

  describe('getSnapshot() returns a copy', () => {
    it('mutating the returned object does not change internal state', () => {
      botMetrics.liquidation_attempts_total = 7;
      const snap = botMetrics.getSnapshot();
      (snap as any).liquidation_attempts_total = 999;
      expect(botMetrics.getSnapshot().liquidation_attempts_total).toBe(7);
    });
  });

  describe('reset()', () => {
    it('zeroes everything including latency accumulators', () => {
      botMetrics.liquidation_attempts_total = 10;
      botMetrics.recordLiquidationLatency(300);
      botMetrics.reset();
      const snap = botMetrics.getSnapshot();
      expect(snap.liquidation_attempts_total).toBe(0);
      expect(snap.avg_liquidation_latency_ms).toBe(0);
    });
  });
});
