import {
  computeDiff,
  applyDiff,
  serialiseDiffEntry,
  parseDiffEntry,
  type DiffLogEntry,
  type StateDiff,
} from '../snapshotDiff';
import type { CurrentSnapshotState, CurrentPositionEntry, CurrentPoolEntry, CurrentGovernanceEntry } from '../schema';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALICE: CurrentPositionEntry = { address: 'C_ALICE', collateral: '10000', debt: '4000', healthFactor: '1.9' };
const BOB: CurrentPositionEntry   = { address: 'C_BOB',   collateral: '25000', debt: '15000', healthFactor: '1.25' };
const CAROL: CurrentPositionEntry = { address: 'C_CAROL', collateral: '5000',  debt: '0',     healthFactor: '99' };

const USDC: CurrentPoolEntry = { asset: 'USDC', collateralFactorBps: 8000, interestRateBps: 450,  supplyCap: '10000000' };
const XLM:  CurrentPoolEntry = { asset: 'XLM',  collateralFactorBps: 7000, interestRateBps: 380,  supplyCap: '50000000' };

const GOV1: CurrentGovernanceEntry = { proposalId: 1, status: 'executed', executed: true,  votesFor: '120', votesAgainst: '3' };
const GOV2: CurrentGovernanceEntry = { proposalId: 2, status: 'active',   executed: false, votesFor: '40',  votesAgainst: '5' };

const BASE: CurrentSnapshotState = {
  positions:  [ALICE, BOB],
  pools:      [USDC, XLM],
  governance: [GOV1, GOV2],
};

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// ── computeDiff ───────────────────────────────────────────────────────────────

describe('computeDiff', () => {
  it('returns isEmpty=true when states are identical', () => {
    const diff = computeDiff(BASE, clone(BASE));
    expect(diff.isEmpty).toBe(true);
    expect(diff.positions.added).toHaveLength(0);
    expect(diff.positions.removed).toHaveLength(0);
    expect(diff.positions.modified).toHaveLength(0);
  });

  describe('positions', () => {
    it('detects a new position', () => {
      const next = clone(BASE);
      next.positions.push(CAROL);
      const diff = computeDiff(BASE, next);
      expect(diff.isEmpty).toBe(false);
      expect(diff.positions.added).toHaveLength(1);
      expect(diff.positions.added[0]?.address).toBe('C_CAROL');
    });

    it('detects a removed position', () => {
      const next = clone(BASE);
      next.positions = next.positions.filter((p) => p.address !== 'C_BOB');
      const diff = computeDiff(BASE, next);
      expect(diff.positions.removed).toContain('C_BOB');
    });

    it('detects a modified position (debt changed)', () => {
      const next = clone(BASE);
      next.positions[0] = { ...next.positions[0]!, debt: '5000', healthFactor: '1.5' };
      const diff = computeDiff(BASE, next);
      expect(diff.positions.modified).toHaveLength(1);
      expect(diff.positions.modified[0]?.address).toBe('C_ALICE');
      expect(diff.positions.modified[0]?.debt).toBe('5000');
    });

    it('detects a change in the optional lastUpdatedLedger field', () => {
      const next = clone(BASE);
      next.positions[0] = { ...next.positions[0]!, lastUpdatedLedger: 999 };
      const diff = computeDiff(BASE, next);
      expect(diff.positions.modified).toHaveLength(1);
    });

    it('handles simultaneous add, remove, and modify', () => {
      const next = clone(BASE);
      next.positions = [
        { ...ALICE, debt: '9999' }, // modified
        CAROL,                      // added
        // BOB removed
      ];
      const diff = computeDiff(BASE, next);
      expect(diff.positions.added.map((p) => p.address)).toContain('C_CAROL');
      expect(diff.positions.removed).toContain('C_BOB');
      expect(diff.positions.modified.map((p) => p.address)).toContain('C_ALICE');
      expect(diff.isEmpty).toBe(false);
    });
  });

  describe('pools', () => {
    it('detects a new pool', () => {
      const next = clone(BASE);
      next.pools.push({ asset: 'ETH', collateralFactorBps: 6000, interestRateBps: 500, supplyCap: '1000000' });
      expect(computeDiff(BASE, next).pools.added).toHaveLength(1);
    });

    it('detects a removed pool', () => {
      const next = clone(BASE);
      next.pools = next.pools.filter((p) => p.asset !== 'XLM');
      expect(computeDiff(BASE, next).pools.removed).toContain('XLM');
    });

    it('detects a changed interestRateBps', () => {
      const next = clone(BASE);
      next.pools[0] = { ...next.pools[0]!, interestRateBps: 600 };
      const diff = computeDiff(BASE, next);
      expect(diff.pools.modified).toHaveLength(1);
      expect(diff.pools.modified[0]?.asset).toBe('USDC');
    });

    it('detects change in optional liquidationThresholdBps', () => {
      const next = clone(BASE);
      next.pools[0] = { ...next.pools[0]!, liquidationThresholdBps: 8500 };
      expect(computeDiff(BASE, next).pools.modified).toHaveLength(1);
    });
  });

  describe('governance', () => {
    it('detects a new proposal', () => {
      const next = clone(BASE);
      next.governance.push({ proposalId: 3, status: 'pending', executed: false, votesFor: '0', votesAgainst: '0' });
      expect(computeDiff(BASE, next).governance.added).toHaveLength(1);
    });

    it('detects a removed proposal', () => {
      const next = clone(BASE);
      next.governance = next.governance.filter((g) => g.proposalId !== 1);
      expect(computeDiff(BASE, next).governance.removed).toContain(1);
    });

    it('detects a status change', () => {
      const next = clone(BASE);
      next.governance[1] = { ...next.governance[1]!, status: 'executed', executed: true };
      const diff = computeDiff(BASE, next);
      expect(diff.governance.modified).toHaveLength(1);
      expect(diff.governance.modified[0]?.proposalId).toBe(2);
    });

    it('detects a change in optional timelockAt', () => {
      const next = clone(BASE);
      next.governance[0] = { ...next.governance[0]!, timelockAt: 1_750_000_000 };
      expect(computeDiff(BASE, next).governance.modified).toHaveLength(1);
    });
  });
});

// ── applyDiff ─────────────────────────────────────────────────────────────────

describe('applyDiff', () => {
  it('is a no-op on an empty diff', () => {
    const emptyDiff: StateDiff = {
      positions: { added: [], removed: [], modified: [] },
      pools:     { added: [], removed: [], modified: [] },
      governance:{ added: [], removed: [], modified: [] },
      isEmpty: true,
    };
    const result = applyDiff(BASE, emptyDiff);
    expect(result.positions).toHaveLength(BASE.positions.length);
    expect(result.pools).toHaveLength(BASE.pools.length);
    expect(result.governance).toHaveLength(BASE.governance.length);
  });

  it('adds new positions', () => {
    const diff = computeDiff(BASE, { ...clone(BASE), positions: [...BASE.positions, CAROL] });
    const result = applyDiff(BASE, diff);
    expect(result.positions.map((p) => p.address)).toContain('C_CAROL');
  });

  it('removes positions', () => {
    const nextPositions = BASE.positions.filter((p) => p.address !== 'C_BOB');
    const diff = computeDiff(BASE, { ...clone(BASE), positions: nextPositions });
    const result = applyDiff(BASE, diff);
    expect(result.positions.map((p) => p.address)).not.toContain('C_BOB');
    expect(result.positions).toHaveLength(1);
  });

  it('applies position modifications', () => {
    const modified: CurrentPositionEntry = { ...ALICE, debt: '7777', healthFactor: '1.1' };
    const diff = computeDiff(BASE, { ...clone(BASE), positions: [modified, BOB] });
    const result = applyDiff(BASE, diff);
    const alice = result.positions.find((p) => p.address === 'C_ALICE');
    expect(alice?.debt).toBe('7777');
  });

  it('round-trips a full diff: applyDiff(base, computeDiff(base, next)) ≈ next', () => {
    const next: CurrentSnapshotState = {
      positions: [{ ...ALICE, debt: '5000' }, CAROL],      // BOB removed, CAROL added, ALICE modified
      pools:     [{ ...USDC, interestRateBps: 500 }, XLM], // USDC interest changed
      governance:[GOV1, { ...GOV2, status: 'executed', executed: true }],
    };
    const diff = computeDiff(BASE, next);
    const reconstructed = applyDiff(BASE, diff);

    // Positions
    const addrs = reconstructed.positions.map((p) => p.address).sort();
    expect(addrs).toEqual(['C_ALICE', 'C_CAROL']);
    expect(reconstructed.positions.find((p) => p.address === 'C_ALICE')?.debt).toBe('5000');

    // Pools
    expect(reconstructed.pools.find((p) => p.asset === 'USDC')?.interestRateBps).toBe(500);

    // Governance
    expect(reconstructed.governance.find((g) => g.proposalId === 2)?.executed).toBe(true);
  });

  it('applies governance additions and removals', () => {
    const nextGov = [GOV1, { proposalId: 3, status: 'active', executed: false, votesFor: '10', votesAgainst: '1' }];
    const diff = computeDiff(BASE, { ...clone(BASE), governance: nextGov });
    const result = applyDiff(BASE, diff);
    const ids = result.governance.map((g) => g.proposalId);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
  });
});

// ── serialise / parse ─────────────────────────────────────────────────────────

describe('serialiseDiffEntry / parseDiffEntry', () => {
  const entry: DiffLogEntry = {
    seq: 1,
    recordedAt: '2026-10-01T00:00:00.000Z',
    diff: computeDiff(BASE, { ...clone(BASE), positions: [...BASE.positions, CAROL] }),
  };

  it('round-trips through serialise → parse', () => {
    const line = serialiseDiffEntry(entry);
    const parsed = parseDiffEntry(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.seq).toBe(1);
    expect(parsed?.recordedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(parsed?.diff.positions.added).toHaveLength(1);
  });

  it('produces a single line (no embedded newlines)', () => {
    const line = serialiseDiffEntry(entry);
    expect(line.includes('\n')).toBe(false);
  });

  it('parseDiffEntry returns null for garbage input', () => {
    expect(parseDiffEntry('not json at all')).toBeNull();
    expect(parseDiffEntry('')).toBeNull();
    expect(parseDiffEntry('{}')).toBeNull(); // missing required fields
  });

  it('parseDiffEntry returns null for a JSON object missing seq', () => {
    const bad = JSON.stringify({ recordedAt: '2026-01-01T00:00:00Z', diff: {} });
    expect(parseDiffEntry(bad)).toBeNull();
  });

  it('parseDiffEntry returns null for a non-object JSON value', () => {
    expect(parseDiffEntry('42')).toBeNull();
    expect(parseDiffEntry('"string"')).toBeNull();
  });

  it('handles whitespace-padded lines gracefully', () => {
    const line = '  ' + serialiseDiffEntry(entry) + '  ';
    const parsed = parseDiffEntry(line);
    expect(parsed?.seq).toBe(1);
  });
});
