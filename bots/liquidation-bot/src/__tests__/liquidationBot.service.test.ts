process.env.DRY_RUN = 'true';
process.env.STELLAR_NETWORK = 'testnet';
process.env.MIN_PROFIT_THRESHOLD_XLM = '0.5';
process.env.POLL_INTERVAL_MS = '60000';
process.env.LOG_LEVEL = 'error';

import axios from 'axios';
import { LiquidationBotService } from '../liquidationBot.service';
import { CircuitBreakerRegistry } from '../circuitBreaker';
import { botMetrics } from '../metrics';
import { loadConfig } from '../config';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Silence WebSocket noise in tests
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  }));
});

function makeBot(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const config = { ...loadConfig(), ...overrides };
  const breaker = new CircuitBreakerRegistry({ failureThreshold: 2, openWindowMs: 60_000 });
  return { bot: new LiquidationBotService(config, undefined, breaker), breaker };
}

function makePosition(
  address: string,
  overrides: Partial<{
    healthFactor: number;
    netProfit: number;
    estimatedProfit: number;
    debtValue: number;
  }> = {},
) {
  return {
    address,
    collateralAsset: 'USDC',
    debtAsset: 'XLM',
    collateralValue: 15_000_000,
    debtValue: overrides.debtValue ?? 10_000_000,
    healthFactor: overrides.healthFactor ?? 1.0,
    estimatedProfit: overrides.estimatedProfit ?? 5_000_000,
    gasCostStroops: 10_000,
    netProfit: overrides.netProfit ?? 10_000_000, // 1 XLM @ 10,000,000 stroops/XLM
  };
}

beforeEach(() => {
  botMetrics.reset();
  mockedAxios.post?.mockReset?.();
  mockedAxios.get?.mockReset?.();
});

describe('LiquidationBotService', () => {
  describe('config loading', () => {
    it('reads environment variables correctly', () => {
      const config = loadConfig();
      expect(config.dryRun).toBe(true);
      expect(config.stellarNetwork).toBe('testnet');
      expect(config.minProfitThresholdXlm).toBe(0.5);
    });
  });

  describe('stats — initial state', () => {
    it('returns zero stats on a fresh instance', () => {
      const { bot } = makeBot();
      const stats = bot.getStats();
      expect(stats.totalAttempted).toBe(0);
      expect(stats.totalSuccessful).toBe(0);
      expect(stats.totalProfit).toBe(0);
    });
  });

  describe('start / stop lifecycle', () => {
    it('starts and stops without throwing', () => {
      const { bot } = makeBot();
      expect(() => bot.start()).not.toThrow();
      expect(() => bot.stop()).not.toThrow();
    });
  });

  describe('dry-run liquidation execution', () => {
    it('records a successful dry-run result', async () => {
      const { bot } = makeBot({ dryRun: true, maxConcurrentLiquidations: 5 });
      // Access the private method via casting for white-box testing
      const svc = bot as any;
      await svc.executeLiquidation(makePosition('G_TEST_1'));
      const stats = bot.getStats();
      expect(stats.totalAttempted).toBe(1);
      expect(stats.totalSuccessful).toBe(1);
    });

    it('increments the liquidation_attempts and success metrics', async () => {
      const { bot } = makeBot({ dryRun: true, maxConcurrentLiquidations: 5 });
      const svc = bot as any;
      await svc.executeLiquidation(makePosition('G_TEST_2'));
      expect(botMetrics.liquidation_attempts_total).toBe(1);
      expect(botMetrics.liquidation_successes_total).toBe(1);
      expect(botMetrics.liquidation_failures_total).toBe(0);
    });

    it('records latency after each execution', async () => {
      const { bot } = makeBot({ dryRun: true, maxConcurrentLiquidations: 5 });
      const svc = bot as any;
      await svc.executeLiquidation(makePosition('G_TEST_3'));
      expect(botMetrics.getSnapshot().avg_liquidation_latency_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('in-flight deduplication guard', () => {
    it('skips a position that is already in-flight', async () => {
      const { bot } = makeBot({ dryRun: true, maxConcurrentLiquidations: 5 });
      const svc = bot as any;

      // Manually add the address to the in-flight set before the call
      svc.inFlight.add('G_INFLIGHT');

      // evaluatePositions should see it as in-flight and skip
      svc.evaluatePositions([makePosition('G_INFLIGHT')]);

      expect(botMetrics.liquidation_skipped_inflight_total).toBe(1);
      expect(botMetrics.liquidation_attempts_total).toBe(0);
    });

    it('clears the in-flight entry after execution completes', async () => {
      const { bot } = makeBot({ dryRun: true, maxConcurrentLiquidations: 5 });
      const svc = bot as any;
      await svc.executeLiquidation(makePosition('G_CLEAR_TEST'));
      expect(svc.inFlight.has('G_CLEAR_TEST')).toBe(false);
    });

    it('allows the same address again once cleared', async () => {
      const { bot } = makeBot({ dryRun: true, maxConcurrentLiquidations: 5 });
      const svc = bot as any;

      await svc.executeLiquidation(makePosition('G_REUSE'));
      expect(botMetrics.liquidation_attempts_total).toBe(1);

      await svc.executeLiquidation(makePosition('G_REUSE'));
      expect(botMetrics.liquidation_attempts_total).toBe(2);
    });
  });

  describe('circuit breaker integration', () => {
    it('skips positions whose breaker is open', () => {
      const { bot, breaker } = makeBot({
        dryRun: true,
        maxConcurrentLiquidations: 5,
      });
      const svc = bot as any;

      // Force the breaker open
      breaker.recordFailure('G_BROKEN');
      breaker.recordFailure('G_BROKEN'); // threshold = 2

      svc.evaluatePositions([makePosition('G_BROKEN')]);

      expect(botMetrics.liquidation_skipped_circuitbreaker_total).toBe(1);
      expect(botMetrics.liquidation_attempts_total).toBe(0);
    });

    it('records failure and opens the breaker after threshold', async () => {
      mockedAxios.post.mockRejectedValue(new Error('tx reverted'));
      const { bot, breaker } = makeBot({
        dryRun: false,
        maxConcurrentLiquidations: 5,
        liquidationWebhookUrl: '',
        liquidationWebhookSecret: '',
      });
      const svc = bot as any;

      await svc.executeLiquidation(makePosition('G_FAIL_1'));
      expect(breaker.getState('G_FAIL_1')).toBe('closed'); // 1 failure < threshold=2

      await svc.executeLiquidation(makePosition('G_FAIL_1'));
      expect(breaker.getState('G_FAIL_1')).toBe('open'); // 2nd failure opens it
      expect(botMetrics.liquidation_failures_total).toBe(2);
    });

    it('closes the breaker after a successful liquidation', async () => {
      mockedAxios.post
        .mockRejectedValueOnce(new Error('temporary fail'))
        .mockResolvedValueOnce({ data: { txHash: 'abc123' } });

      const { bot, breaker } = makeBot({
        dryRun: false,
        maxConcurrentLiquidations: 5,
        liquidationWebhookUrl: '',
        liquidationWebhookSecret: '',
      });
      const svc = bot as any;

      await svc.executeLiquidation(makePosition('G_RECOVER'));
      expect(breaker.getState('G_RECOVER')).toBe('closed'); // 1 failure, threshold=2

      await svc.executeLiquidation(makePosition('G_RECOVER'));
      expect(breaker.getState('G_RECOVER')).toBe('closed'); // success resets
    });

    it('exposes the breaker registry via getBreakerRegistry()', () => {
      const { bot, breaker } = makeBot();
      expect(bot.getBreakerRegistry()).toBe(breaker);
    });
  });

  describe('concurrency cap', () => {
    it('does not start new liquidations when at the concurrency cap', () => {
      const { bot } = makeBot({
        dryRun: true,
        maxConcurrentLiquidations: 1,
      });
      const svc = bot as any;

      // Simulate one already in progress
      svc.activeLiquidations = 1;

      svc.evaluatePositions([
        makePosition('G_CAP_A'),
        makePosition('G_CAP_B'),
      ]);

      // The cap is already reached — no new attempts should be started
      expect(botMetrics.liquidation_attempts_total).toBe(0);
    });
  });

  describe('target selection strategies', () => {
    it('highest_profit selects the position with greatest netProfit', () => {
      const { bot } = makeBot({ liquidationTargetStrategy: 'highest_profit', maxConcurrentLiquidations: 1 });
      const svc = bot as any;
      const positions = [
        makePosition('G_LOW', { netProfit: 5_000_000 }),
        makePosition('G_HIGH', { netProfit: 50_000_000 }),
      ];
      const selected: any[] = svc.selectTargets(positions);
      expect(selected[0].address).toBe('G_HIGH');
    });

    it('lowest_hf selects the position with the smallest health factor', () => {
      const { bot } = makeBot({ liquidationTargetStrategy: 'lowest_hf', maxConcurrentLiquidations: 1 });
      const svc = bot as any;
      const positions = [
        makePosition('G_SAFE', { healthFactor: 1.15 }),
        makePosition('G_RISKY', { healthFactor: 0.85 }),
      ];
      const selected: any[] = svc.selectTargets(positions);
      expect(selected[0].address).toBe('G_RISKY');
    });
  });

  describe('getResults()', () => {
    it('returns a copy, not the internal array', async () => {
      const { bot } = makeBot({ dryRun: true, maxConcurrentLiquidations: 5 });
      const svc = bot as any;
      await svc.executeLiquidation(makePosition('G_RES'));
      const results = bot.getResults();
      results.length = 0; // mutate the copy
      expect(bot.getResults()).toHaveLength(1);
    });
  });
});
