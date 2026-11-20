/**
 * Per-address circuit breaker for the liquidation bot.
 *
 * Problem: a position whose on-chain state makes liquidation impossible
 * (e.g. temporarily healthy after a price tick, locked by another liquidator,
 * or stuck due to gas) will be retried on every poll cycle, burning RPC
 * quota and contributing to tail-latency for the positions that *can* be
 * liquidated.
 *
 * Solution: after `failureThreshold` consecutive failures for the same
 * address, the breaker opens and suppresses all further attempts for
 * `openWindowMs`.  After the window the breaker half-opens: one probe attempt
 * is allowed through.  A successful probe closes the breaker; another failure
 * resets the window.
 *
 * The breaker is intentionally in-memory only.  It is not persisted across
 * restarts so a restarted bot always gets a fresh start.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerEntry {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  probeSentAt: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the breaker opens. Default: 3 */
  failureThreshold: number;
  /** How long (ms) the breaker stays open before allowing a probe. Default: 60 000 */
  openWindowMs: number;
}

export class CircuitBreakerRegistry {
  private readonly entries = new Map<string, BreakerEntry>();
  private readonly opts: CircuitBreakerOptions;

  constructor(opts: Partial<CircuitBreakerOptions> = {}) {
    this.opts = {
      failureThreshold: opts.failureThreshold ?? 3,
      openWindowMs: opts.openWindowMs ?? 60_000,
    };
  }

  /**
   * Returns true when the given key is allowed to attempt an action.
   * Advances the state machine as a side-effect (open → half-open).
   */
  isAllowed(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.state === 'closed') {
      return true;
    }

    if (entry.state === 'open') {
      const elapsed = Date.now() - entry.openedAt;
      if (elapsed < this.opts.openWindowMs) {
        return false;
      }
      // Window elapsed — transition to half-open and allow one probe
      entry.state = 'half-open';
      entry.probeSentAt = Date.now();
      return true;
    }

    // half-open: only one probe at a time
    if (entry.state === 'half-open') {
      // If another caller already sent a probe recently, block this one
      if (entry.probeSentAt > 0 && Date.now() - entry.probeSentAt < this.opts.openWindowMs) {
        return false;
      }
      entry.probeSentAt = Date.now();
      return true;
    }

    return true;
  }

  /** Call on a successful outcome to close (or keep closed) the breaker. */
  recordSuccess(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.state = 'closed';
    entry.consecutiveFailures = 0;
    entry.openedAt = 0;
    entry.probeSentAt = 0;
  }

  /** Call on a failed outcome. Opens the breaker after threshold failures. */
  recordFailure(key: string): void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: 'closed', consecutiveFailures: 0, openedAt: 0, probeSentAt: 0 };
      this.entries.set(key, entry);
    }

    entry.consecutiveFailures += 1;

    if (
      entry.state !== 'open' &&
      entry.consecutiveFailures >= this.opts.failureThreshold
    ) {
      entry.state = 'open';
      entry.openedAt = Date.now();
    } else if (entry.state === 'half-open') {
      // Probe failed — re-open
      entry.state = 'open';
      entry.openedAt = Date.now();
      entry.probeSentAt = 0;
    }
  }

  getState(key: string): BreakerState {
    return this.entries.get(key)?.state ?? 'closed';
  }

  getEntry(key: string): BreakerEntry | undefined {
    return this.entries.get(key);
  }

  /** Number of addresses currently in an open or half-open state. */
  openCount(): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.state !== 'closed') n++;
    }
    return n;
  }

  /** Remove all entries — useful in tests. */
  reset(): void {
    this.entries.clear();
  }
}
