import { CircuitBreakerRegistry, BreakerState } from '../circuitBreaker';

function makeRegistry(opts?: { failureThreshold?: number; openWindowMs?: number }) {
  return new CircuitBreakerRegistry(opts);
}

describe('CircuitBreakerRegistry', () => {
  const KEY = 'GADDRESS_1';

  describe('initial state', () => {
    it('allows every key that has never been seen', () => {
      const reg = makeRegistry();
      expect(reg.isAllowed(KEY)).toBe(true);
      expect(reg.getState(KEY)).toBe<BreakerState>('closed');
    });

    it('openCount() is 0 when no failures have occurred', () => {
      const reg = makeRegistry();
      reg.isAllowed(KEY);
      expect(reg.openCount()).toBe(0);
    });
  });

  describe('failure accumulation → open', () => {
    it('stays closed below the failure threshold', () => {
      const reg = makeRegistry({ failureThreshold: 3 });
      reg.recordFailure(KEY);
      reg.recordFailure(KEY);
      expect(reg.getState(KEY)).toBe<BreakerState>('closed');
      expect(reg.isAllowed(KEY)).toBe(true);
    });

    it('opens exactly at the failure threshold', () => {
      const reg = makeRegistry({ failureThreshold: 3 });
      reg.recordFailure(KEY);
      reg.recordFailure(KEY);
      reg.recordFailure(KEY);
      expect(reg.getState(KEY)).toBe<BreakerState>('open');
    });

    it('blocks further attempts while open', () => {
      const reg = makeRegistry({ failureThreshold: 2, openWindowMs: 60_000 });
      reg.recordFailure(KEY);
      reg.recordFailure(KEY);
      expect(reg.isAllowed(KEY)).toBe(false);
    });

    it('openCount() reflects open breakers', () => {
      const reg = makeRegistry({ failureThreshold: 1 });
      reg.recordFailure('A');
      reg.recordFailure('B');
      reg.recordFailure('B'); // already open, stays open
      expect(reg.openCount()).toBe(2);
    });
  });

  describe('open → half-open → closed (success probe)', () => {
    it('transitions to half-open after openWindowMs elapses', () => {
      const reg = makeRegistry({ failureThreshold: 1, openWindowMs: 0 });
      reg.recordFailure(KEY);
      // With openWindowMs=0 the window has already elapsed
      expect(reg.isAllowed(KEY)).toBe(true);
      expect(reg.getState(KEY)).toBe<BreakerState>('half-open');
    });

    it('closes on a successful probe', () => {
      const reg = makeRegistry({ failureThreshold: 1, openWindowMs: 0 });
      reg.recordFailure(KEY);
      reg.isAllowed(KEY); // → half-open
      reg.recordSuccess(KEY);
      expect(reg.getState(KEY)).toBe<BreakerState>('closed');
      expect(reg.isAllowed(KEY)).toBe(true);
    });

    it('re-opens when the half-open probe fails', () => {
      const reg = makeRegistry({ failureThreshold: 1, openWindowMs: 0 });
      reg.recordFailure(KEY);
      reg.isAllowed(KEY); // → half-open
      reg.recordFailure(KEY); // probe failed → re-open
      expect(reg.getState(KEY)).toBe<BreakerState>('open');
    });

    it('openCount() decrements after successful probe closes the breaker', () => {
      const reg = makeRegistry({ failureThreshold: 1, openWindowMs: 0 });
      reg.recordFailure(KEY);
      expect(reg.openCount()).toBe(1);
      reg.isAllowed(KEY); // → half-open (still counts as open)
      reg.recordSuccess(KEY);
      expect(reg.openCount()).toBe(0);
    });
  });

  describe('recordSuccess on a closed breaker', () => {
    it('is a no-op — breaker stays closed, no entry created', () => {
      const reg = makeRegistry();
      reg.recordSuccess(KEY);
      expect(reg.getState(KEY)).toBe<BreakerState>('closed');
      expect(reg.getEntry(KEY)).toBeUndefined();
    });
  });

  describe('reset()', () => {
    it('clears all entries', () => {
      const reg = makeRegistry({ failureThreshold: 1 });
      reg.recordFailure('A');
      reg.recordFailure('B');
      expect(reg.openCount()).toBe(2);
      reg.reset();
      expect(reg.openCount()).toBe(0);
      expect(reg.getEntry('A')).toBeUndefined();
    });
  });

  describe('multiple independent keys', () => {
    it('manages each address independently', () => {
      const reg = makeRegistry({ failureThreshold: 2 });
      reg.recordFailure('A');
      reg.recordFailure('A'); // A opens
      reg.recordFailure('B'); // B still below threshold

      expect(reg.getState('A')).toBe<BreakerState>('open');
      expect(reg.getState('B')).toBe<BreakerState>('closed');
      expect(reg.isAllowed('A')).toBe(false);
      expect(reg.isAllowed('B')).toBe(true);
    });

    it('openCount() only counts non-closed breakers', () => {
      const reg = makeRegistry({ failureThreshold: 1 });
      reg.recordFailure('A');
      reg.recordFailure('B');
      reg.recordSuccess('B'); // B closes after success resets counter
      // 'B' was opened first (threshold=1), then closed
      expect(reg.openCount()).toBe(1); // only A
    });
  });
});
