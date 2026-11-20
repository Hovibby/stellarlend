/**
 * Pure diff/patch logic for LendingSnapshot incremental writes.
 *
 * Problem being solved
 * ────────────────────
 * The original flow rewrites the entire lending.snap.json on every update.
 * When the position list grows, the full-rewrite cost scales linearly with
 * the number of positions — O(N) JSON serialisation + a full fsync — even
 * when only one position changed.
 *
 * Solution
 * ────────
 * computeDiff() compares two SnapshotStateV2 objects and returns only what
 * changed.  The SnapshotLoader writes the diff entry to a separate
 * lending.snap.diff.jsonl file (append-only, one JSON object per line) and
 * rewrites the full lending.snap.json only when the diff log exceeds a
 * configurable compaction threshold.  Consumers that need the current state
 * always read the full snapshot; the diff log is an operator/debug artifact.
 *
 * All functions in this file are pure — no I/O, no side-effects, fully
 * testable.
 */

import type {
  CurrentSnapshotState,
  CurrentPositionEntry,
  CurrentPoolEntry,
  CurrentGovernanceEntry,
} from './schema';

// ── Diff shape ───────────────────────────────────────────────────────────────

export interface PositionDiff {
  added: CurrentPositionEntry[];
  removed: string[];                // addresses
  modified: CurrentPositionEntry[];
}

export interface PoolDiff {
  added: CurrentPoolEntry[];
  removed: string[];                // asset symbols
  modified: CurrentPoolEntry[];
}

export interface GovernanceDiff {
  added: CurrentGovernanceEntry[];
  removed: number[];                // proposalIds
  modified: CurrentGovernanceEntry[];
}

export interface StateDiff {
  positions: PositionDiff;
  pools: PoolDiff;
  governance: GovernanceDiff;
  isEmpty: boolean;
}

/** A single entry appended to the diff log file. */
export interface DiffLogEntry {
  seq: number;
  recordedAt: string;
  diff: StateDiff;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function positionKey(p: CurrentPositionEntry): string {
  return p.address;
}

function poolKey(p: CurrentPoolEntry): string {
  return p.asset;
}

function governanceKey(g: CurrentGovernanceEntry): number {
  return g.proposalId;
}

function positionEqual(a: CurrentPositionEntry, b: CurrentPositionEntry): boolean {
  return (
    a.collateral === b.collateral &&
    a.debt === b.debt &&
    a.healthFactor === b.healthFactor &&
    (a.lastUpdatedLedger ?? 0) === (b.lastUpdatedLedger ?? 0)
  );
}

function poolEqual(a: CurrentPoolEntry, b: CurrentPoolEntry): boolean {
  return (
    a.collateralFactorBps === b.collateralFactorBps &&
    a.interestRateBps === b.interestRateBps &&
    a.supplyCap === b.supplyCap &&
    (a.liquidationThresholdBps ?? 0) === (b.liquidationThresholdBps ?? 0)
  );
}

function governanceEqual(a: CurrentGovernanceEntry, b: CurrentGovernanceEntry): boolean {
  return (
    a.status === b.status &&
    a.executed === b.executed &&
    a.votesFor === b.votesFor &&
    a.votesAgainst === b.votesAgainst &&
    (a.timelockAt ?? 0) === (b.timelockAt ?? 0)
  );
}

// ── Generic list diff ────────────────────────────────────────────────────────

function diffList<T, K extends string | number>(
  prev: T[],
  next: T[],
  keyFn: (item: T) => K,
  equalFn: (a: T, b: T) => boolean,
): { added: T[]; removed: K[]; modified: T[] } {
  const prevMap = new Map<K, T>(prev.map((item) => [keyFn(item), item]));
  const nextMap = new Map<K, T>(next.map((item) => [keyFn(item), item]));

  const added: T[] = [];
  const removed: K[] = [];
  const modified: T[] = [];

  for (const [key, nextItem] of nextMap) {
    const prevItem = prevMap.get(key);
    if (!prevItem) {
      added.push(nextItem);
    } else if (!equalFn(prevItem, nextItem)) {
      modified.push(nextItem);
    }
  }

  for (const key of prevMap.keys()) {
    if (!nextMap.has(key)) {
      removed.push(key);
    }
  }

  return { added, removed, modified };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute the diff between two snapshot states.
 *
 * Returns a StateDiff with isEmpty=true when the states are identical, so
 * callers can skip writing a diff entry altogether.
 */
export function computeDiff(
  prev: CurrentSnapshotState,
  next: CurrentSnapshotState,
): StateDiff {
  const positions = diffList(prev.positions, next.positions, positionKey, positionEqual);
  const pools = diffList(prev.pools, next.pools, poolKey, poolEqual);
  const governance = diffList(prev.governance, next.governance, governanceKey, governanceEqual);

  const isEmpty =
    positions.added.length === 0 &&
    positions.removed.length === 0 &&
    positions.modified.length === 0 &&
    pools.added.length === 0 &&
    pools.removed.length === 0 &&
    pools.modified.length === 0 &&
    governance.added.length === 0 &&
    governance.removed.length === 0 &&
    governance.modified.length === 0;

  return { positions, pools, governance, isEmpty };
}

/**
 * Apply a StateDiff to a base state, returning a new state.
 *
 * Used when replaying a diff log on top of an older full snapshot to
 * reconstruct the current state without reading the full file.
 */
export function applyDiff(base: CurrentSnapshotState, diff: StateDiff): CurrentSnapshotState {
  // Positions
  const removedPositions = new Set(diff.positions.removed);
  const modifiedPositions = new Map(diff.positions.modified.map((p) => [p.address, p]));
  const positions: CurrentPositionEntry[] = [
    ...base.positions
      .filter((p) => !removedPositions.has(p.address))
      .map((p) => modifiedPositions.get(p.address) ?? p),
    ...diff.positions.added,
  ];

  // Pools
  const removedPools = new Set(diff.pools.removed);
  const modifiedPools = new Map(diff.pools.modified.map((p) => [p.asset, p]));
  const pools: CurrentPoolEntry[] = [
    ...base.pools
      .filter((p) => !removedPools.has(p.asset))
      .map((p) => modifiedPools.get(p.asset) ?? p),
    ...diff.pools.added,
  ];

  // Governance
  const removedGov = new Set(diff.governance.removed);
  const modifiedGov = new Map(diff.governance.modified.map((g) => [g.proposalId, g]));
  const governance: CurrentGovernanceEntry[] = [
    ...base.governance
      .filter((g) => !removedGov.has(g.proposalId))
      .map((g) => modifiedGov.get(g.proposalId) ?? g),
    ...diff.governance.added,
  ];

  return { positions, pools, governance };
}

/** Serialise a DiffLogEntry to a single JSON line (no trailing newline). */
export function serialiseDiffEntry(entry: DiffLogEntry): string {
  return JSON.stringify(entry);
}

/** Parse a single JSONL line from the diff log. Returns null on parse error. */
export function parseDiffEntry(line: string): DiffLogEntry | null {
  try {
    const parsed = JSON.parse(line.trim());
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.seq === 'number' &&
      typeof parsed.recordedAt === 'string' &&
      typeof parsed.diff === 'object'
    ) {
      return parsed as DiffLogEntry;
    }
    return null;
  } catch {
    return null;
  }
}
