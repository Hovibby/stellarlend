process.env.DRY_RUN = 'true';
process.env.STELLAR_NETWORK = 'testnet';
process.env.MIN_PROFIT_THRESHOLD_XLM = '0.1';
process.env.POLL_INTERVAL_MS = '60000';
process.env.LOG_LEVEL = 'error';

import axios from 'axios';
import { AuctionBidderService } from '../auctionBidder.service';
import { botMetrics } from '../metrics';
import { loadConfig } from '../config';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  }));
});

function makeService(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const config = { ...loadConfig(), ...overrides };
  const { Logger } = require('../logger');
  return new AuctionBidderService(config, new Logger('error'));
}

function makeAuction(id: number, overrides: Partial<{
  currentPrice: number;
  oraclePrice: number;
  debtAmount: number;
  collateralAmount: number;
  status: 'Active' | 'Settled' | 'Expired';
}> = {}) {
  return {
    id,
    pool: 'USDC_POOL',
    collateralAsset: 'USDC',
    debtAsset: 'XLM',
    collateralAmount: overrides.collateralAmount ?? 10_000,
    debtAmount: overrides.debtAmount ?? 5_000,
    oraclePrice: overrides.oraclePrice ?? 10_000,
    startPrice: 10_000,
    currentPrice: overrides.currentPrice ?? 8_000,   // 20% discount
    startTime: Date.now() - 60_000,
    endTime: Date.now() + 300_000,
    status: (overrides.status ?? 'Active') as 'Active' | 'Settled' | 'Expired',
    borrower: 'G_BORROWER',
    highestBidder: null,
    highestBidAmount: null,
  };
}

beforeEach(() => {
  botMetrics.reset();
  mockedAxios.post?.mockReset?.();
  mockedAxios.get?.mockReset?.();
});

describe('AuctionBidderService', () => {
  describe('stats — initial state', () => {
    it('returns zero stats on a fresh instance', () => {
      const svc = makeService();
      const stats = svc.getStats();
      expect(stats.totalBidAttempted).toBe(0);
      expect(stats.totalBidSuccessful).toBe(0);
      expect(stats.avgPremiumBps).toBe(0);
      expect(stats.totalCollateralReceived).toBe(0);
    });
  });

  describe('start / stop lifecycle', () => {
    it('starts and stops without throwing', () => {
      const svc = makeService();
      expect(() => svc.start()).not.toThrow();
      expect(() => svc.stop()).not.toThrow();
    });

    it('clears watched auctions on stop', () => {
      const svc = makeService();
      const internal = svc as any;
      internal.watchedAuctions.set(1, makeAuction(1));
      svc.stop();
      expect(svc.getWatchedAuctions()).toHaveLength(0);
    });
  });

  describe('dry-run bid execution', () => {
    it('records a successful dry-run bid', async () => {
      const svc = makeService({ dryRun: true, maxConcurrentLiquidations: 5 });
      const internal = svc as any;
      await internal.placeBid(makeAuction(42));
      const stats = svc.getStats();
      expect(stats.totalBidAttempted).toBe(1);
      expect(stats.totalBidSuccessful).toBe(1);
    });

    it('increments bid_attempts and bid_successes metrics', async () => {
      const svc = makeService({ dryRun: true, maxConcurrentLiquidations: 5 });
      const internal = svc as any;
      await internal.placeBid(makeAuction(99));
      expect(botMetrics.bid_attempts_total).toBe(1);
      expect(botMetrics.bid_successes_total).toBe(1);
      expect(botMetrics.bid_failures_total).toBe(0);
    });

    it('records bid latency after execution', async () => {
      const svc = makeService({ dryRun: true, maxConcurrentLiquidations: 5 });
      const internal = svc as any;
      await internal.placeBid(makeAuction(100));
      expect(botMetrics.getSnapshot().avg_bid_latency_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('in-flight deduplication guard', () => {
    it('skips an auction already tracked in inFlight', async () => {
      const svc = makeService({
        dryRun: true,
        maxConcurrentLiquidations: 5,
        minDiscountBps: 100,
        minProfitThresholdXlm: 0.001,
      });
      const internal = svc as any;

      // Mark auction 7 as in-flight
      internal.inFlight.add(7);

      internal.handleAuctionUpdate([makeAuction(7)]);

      expect(botMetrics.bid_skipped_inflight_total).toBe(1);
      expect(botMetrics.bid_attempts_total).toBe(0);
    });

    it('clears in-flight entry after the bid resolves', async () => {
      const svc = makeService({ dryRun: true, maxConcurrentLiquidations: 5 });
      const internal = svc as any;
      await internal.placeBid(makeAuction(55));
      expect(internal.inFlight.has(55)).toBe(false);
    });

    it('allows the same auction to be bid on again after in-flight clears', async () => {
      const svc = makeService({ dryRun: true, maxConcurrentLiquidations: 5 });
      const internal = svc as any;
      await internal.placeBid(makeAuction(66));
      await internal.placeBid(makeAuction(66));
      expect(botMetrics.bid_attempts_total).toBe(2);
    });
  });

  describe('handleAuctionUpdate — routing', () => {
    it('removes settled and expired auctions from watchlist', () => {
      const svc = makeService({ minDiscountBps: 100, minProfitThresholdXlm: 0.001 });
      const internal = svc as any;
      internal.watchedAuctions.set(1, makeAuction(1));
      internal.watchedAuctions.set(2, makeAuction(2));

      internal.handleAuctionUpdate([
        makeAuction(1, { status: 'Settled' }),
        makeAuction(2, { status: 'Expired' }),
      ]);

      expect(svc.getWatchedAuctions()).toHaveLength(0);
    });

    it('adds active auctions to the watchlist', () => {
      const svc = makeService({
        minDiscountBps: 100,         // 100 bps minimum
        minProfitThresholdXlm: 100,  // very high threshold so no bid fires
      });
      const internal = svc as any;
      internal.handleAuctionUpdate([makeAuction(10)]);
      expect(svc.getWatchedAuctions()).toHaveLength(1);
    });
  });

  describe('discount calculation', () => {
    it('calculates discount as (oracle - current) / oracle * 10000', () => {
      const svc = makeService();
      const internal = svc as any;
      // oraclePrice=10000, currentPrice=8000 → 20% discount = 2000 bps
      expect(internal.calculateDiscountBps(makeAuction(1, { oraclePrice: 10_000, currentPrice: 8_000 }))).toBe(2000);
    });

    it('returns 0 when oraclePrice is 0 (guard against division by zero)', () => {
      const svc = makeService();
      const internal = svc as any;
      expect(internal.calculateDiscountBps(makeAuction(1, { oraclePrice: 0 }))).toBe(0);
    });
  });

  describe('live (non-dry-run) bid execution', () => {
    it('records a successful bid result with txHash', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { txHash: 'tx_bid_ok', collateralReceived: 4_000 },
      });
      const svc = makeService({
        dryRun: false,
        maxConcurrentLiquidations: 5,
      });
      const internal = svc as any;
      await internal.placeBid(makeAuction(200));
      const results = svc.getResults();
      expect(results[0]?.success).toBe(true);
      expect(results[0]?.txHash).toBe('tx_bid_ok');
    });

    it('records a failure result when the API call rejects', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('bid rejected'));
      const svc = makeService({ dryRun: false, maxConcurrentLiquidations: 5 });
      const internal = svc as any;
      await internal.placeBid(makeAuction(201));
      const results = svc.getResults();
      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toContain('bid rejected');
      expect(botMetrics.bid_failures_total).toBe(1);
    });
  });

  describe('concurrency cap', () => {
    it('skips bids when at the concurrency limit', async () => {
      const svc = makeService({ dryRun: true, maxConcurrentLiquidations: 1 });
      const internal = svc as any;
      internal.activeBids = 1; // already at cap

      await internal.placeBid(makeAuction(300));

      // Should have returned early without attempting
      expect(botMetrics.bid_attempts_total).toBe(0);
    });
  });

  describe('getResults() returns a defensive copy', () => {
    it('mutating the result array does not affect internal state', async () => {
      const svc = makeService({ dryRun: true, maxConcurrentLiquidations: 5 });
      const internal = svc as any;
      await internal.placeBid(makeAuction(400));
      const copy = svc.getResults();
      copy.length = 0;
      expect(svc.getResults()).toHaveLength(1);
    });
  });

  describe('avgPremiumBps in stats', () => {
    it('returns 0 when no successful bids exist', () => {
      const svc = makeService();
      expect(svc.getStats().avgPremiumBps).toBe(0);
    });

    it('averages premiumBps across successful bids', async () => {
      const svc = makeService({ dryRun: true, maxConcurrentLiquidations: 5 });
      const internal = svc as any;
      // Auction 1: oraclePrice=10000, currentPrice=8000 → 2000 bps
      await internal.placeBid(makeAuction(501, { oraclePrice: 10_000, currentPrice: 8_000 }));
      // Auction 2: oraclePrice=10000, currentPrice=9000 → 1000 bps
      await internal.placeBid(makeAuction(502, { oraclePrice: 10_000, currentPrice: 9_000 }));
      const stats = svc.getStats();
      expect(stats.avgPremiumBps).toBe(1500); // (2000 + 1000) / 2
    });
  });
});
