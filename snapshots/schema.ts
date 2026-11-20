/**
 * Canonical types for StellarLend lending snapshots.
 *
 * Version history
 * ───────────────
 * 1  Initial schema (positions, pools, governance)
 * 2  Added `liquidationThresholdBps` on PoolEntry; PositionEntry gains
 *    optional `lastUpdatedLedger`; GovernanceEntry gains optional `timelockAt`.
 *
 * When bumping CURRENT_SNAPSHOT_VERSION:
 *  1. Add a new block to the history above.
 *  2. Update the discriminated union SnapshotState to include the new type.
 *  3. Add a migration branch in snapshotLoader.migrate().
 */

export const CURRENT_SNAPSHOT_VERSION = 2 as const;

// ── V1 ──────────────────────────────────────────────────────────────────────

export interface PositionEntryV1 {
  address: string;
  collateral: string;
  debt: string;
  healthFactor: string;
}

export interface PoolEntryV1 {
  asset: string;
  collateralFactorBps: number;
  interestRateBps: number;
  supplyCap: string;
}

export interface GovernanceEntryV1 {
  proposalId: number;
  status: string;
  executed: boolean;
  votesFor: string;
  votesAgainst: string;
}

export interface SnapshotStateV1 {
  positions: PositionEntryV1[];
  pools: PoolEntryV1[];
  governance: GovernanceEntryV1[];
}

export interface LendingSnapshotV1 {
  version: 1;
  kind: 'contract-state';
  recordedAt: string;
  state: SnapshotStateV1;
}

// ── V2 ──────────────────────────────────────────────────────────────────────

export interface PositionEntryV2 extends PositionEntryV1 {
  /** Ledger sequence number at which this position was last written on-chain. */
  lastUpdatedLedger?: number;
}

export interface PoolEntryV2 extends PoolEntryV1 {
  /** Liquidation threshold in basis points (must be >= collateralFactorBps). */
  liquidationThresholdBps?: number;
}

export interface GovernanceEntryV2 extends GovernanceEntryV1 {
  /** Unix timestamp (seconds) at which the timelock unlocks, if queued. */
  timelockAt?: number;
}

export interface SnapshotStateV2 {
  positions: PositionEntryV2[];
  pools: PoolEntryV2[];
  governance: GovernanceEntryV2[];
}

export interface LendingSnapshotV2 {
  version: 2;
  kind: 'contract-state';
  recordedAt: string;
  state: SnapshotStateV2;
  /**
   * Sequential diff sequence number.  Starts at 0 (baseline snapshot written
   * without any predecessor).  Increments by 1 on every write that carries
   * real changes.  Consumers use this to detect skipped diff entries.
   */
  seq: number;
}

// ── Union used throughout the codebase ──────────────────────────────────────

export type LendingSnapshot = LendingSnapshotV1 | LendingSnapshotV2;

/** The current production type, always pinned to CURRENT_SNAPSHOT_VERSION. */
export type CurrentLendingSnapshot = LendingSnapshotV2;
export type CurrentSnapshotState = SnapshotStateV2;
export type CurrentPositionEntry = PositionEntryV2;
export type CurrentPoolEntry = PoolEntryV2;
export type CurrentGovernanceEntry = GovernanceEntryV2;
