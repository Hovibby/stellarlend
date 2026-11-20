/**
 * snapshotLoader integration tests.
 *
 * All file I/O is routed to a per-test temporary directory so the real
 * lending.snap.json is never touched.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  loadSnapshot,
  writeSnapshot,
  loadDiffLog,
  invalidateCache,
  getSnapshotMetrics,
  resetSnapshotMetrics,
} from '../snapshotLoader';
import type { CurrentSnapshotState, LendingSnapshotV1, LendingSnapshotV2 } from '../schema';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
  return dir;
}

function snapFile(dir: string): string {
  return path.join(dir, 'lending.snap.json');
}

function diffFile(dir: string): string {
  return path.join(dir, 'lending.snap.diff.jsonl');
}

function writeRaw(dir: string, content: unknown): void {
  fs.writeFileSync(snapFile(dir), JSON.stringify(content, null, 2), 'utf8');
}

const BASE_STATE: CurrentSnapshotState = {
  positions: [
    { address: 'C_ALICE', collateral: '10000', debt: '4000', healthFactor: '1.9' },
    { address: 'C_BOB',   collateral: '25000', debt: '15000', healthFactor: '1.25' },
  ],
  pools: [
    { asset: 'USDC', collateralFactorBps: 8000, interestRateBps: 450, supplyCap: '10000000' },
  ],
  governance: [
    { proposalId: 1, status: 'executed', executed: true, votesFor: '120', votesAgainst: '3' },
  ],
};

const V2_FIXTURE: LendingSnapshotV2 = {
  version: 2,
  kind: 'contract-state',
  recordedAt: '2026-09-25T01:05:26.712Z',
  seq: 0,
  state: BASE_STATE,
};

const V1_FIXTURE: LendingSnapshotV1 = {
  version: 1,
  kind: 'contract-state',
  recordedAt: '2026-09-25T01:05:26.712Z',
  state: {
    positions: [{ address: 'C_ALICE', collateral: '10000', debt: '4000', healthFactor: '1.9' }],
    pools: [{ asset: 'USDC', collateralFactorBps: 8000, interestRateBps: 450, supplyCap: '10000000' }],
    governance: [{ proposalId: 1, status: 'executed', executed: true, votesFor: '100', votesAgainst: '2' }],
  },
};

beforeEach(() => {
  invalidateCache();
  resetSnapshotMetrics();
});

// ── loadSnapshot ──────────────────────────────────────────────────────────────

describe('loadSnapshot', () => {
  describe('happy path', () => {
    it('loads a valid v2 snapshot', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      const result = loadSnapshot(snapFile(dir));
      expect(result.snapshot.version).toBe(2);
      expect(result.fromCache).toBe(false);
      expect(result.migrated).toBe(false);
      expect(result.snapshot.state.positions).toHaveLength(2);
    });

    it('migrates a v1 snapshot to v2 on load', () => {
      const dir = tmpDir();
      writeRaw(dir, V1_FIXTURE);
      const result = loadSnapshot(snapFile(dir));
      expect(result.migrated).toBe(true);
      expect(result.snapshot.version).toBe(2);
      expect(result.snapshot.seq).toBe(0);
    });

    it('increments the loads metric on each disk read', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      loadSnapshot(snapFile(dir));
      loadSnapshot(snapFile(dir)); // second call hits cache
      expect(getSnapshotMetrics().loads).toBe(2);
    });
  });

  describe('mtime-based cache', () => {
    it('returns fromCache=true on the second call without file change', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      loadSnapshot(snapFile(dir)); // prime cache
      const second = loadSnapshot(snapFile(dir));
      expect(second.fromCache).toBe(true);
    });

    it('increments cacheHits metric on cache hit', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      loadSnapshot(snapFile(dir));
      loadSnapshot(snapFile(dir));
      expect(getSnapshotMetrics().cacheHits).toBe(1);
    });

    it('re-reads from disk after invalidateCache()', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      loadSnapshot(snapFile(dir)); // prime
      invalidateCache();
      const result = loadSnapshot(snapFile(dir));
      expect(result.fromCache).toBe(false);
    });
  });

  describe('error cases', () => {
    it('throws when the file does not exist', () => {
      expect(() => loadSnapshot('/nonexistent/path/lending.snap.json')).toThrow();
    });

    it('throws and increments validationErrors on an invalid snapshot', () => {
      const dir = tmpDir();
      writeRaw(dir, { version: 2, kind: 'contract-state', recordedAt: 'bad', seq: 0, state: {} });
      expect(() => loadSnapshot(snapFile(dir))).toThrow(/validation failed/i);
      expect(getSnapshotMetrics().validationErrors).toBe(1);
    });

    it('throws on completely malformed JSON structure', () => {
      const dir = tmpDir();
      writeRaw(dir, { not: 'a snapshot at all' });
      expect(() => loadSnapshot(snapFile(dir))).toThrow();
    });
  });
});

// ── writeSnapshot ─────────────────────────────────────────────────────────────

describe('writeSnapshot', () => {
  describe('no-change guard', () => {
    it('returns written=false when state is unchanged', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      const result = writeSnapshot(BASE_STATE, snapFile(dir), diffFile(dir));
      expect(result.written).toBe(false);
      expect(result.diff.isEmpty).toBe(true);
    });

    it('does not append to the diff log when nothing changed', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      writeSnapshot(BASE_STATE, snapFile(dir), diffFile(dir));
      expect(fs.existsSync(diffFile(dir)) && fs.readFileSync(diffFile(dir), 'utf8').trim() === '')
        .toBeTruthy();
    });
  });

  describe('incremental write', () => {
    it('returns written=true and increments seq on a real change', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      const next: CurrentSnapshotState = {
        ...BASE_STATE,
        positions: [
          { address: 'C_ALICE', collateral: '10000', debt: '5000', healthFactor: '1.5' },
          ...BASE_STATE.positions.slice(1),
        ],
      };
      const result = writeSnapshot(next, snapFile(dir), diffFile(dir));
      expect(result.written).toBe(true);
      expect(result.diff.positions.modified).toHaveLength(1);
    });

    it('advances seq by 1 on each write', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      invalidateCache();

      const next1: CurrentSnapshotState = {
        ...BASE_STATE,
        positions: [{ address: 'C_ALICE', collateral: '10000', debt: '4001', healthFactor: '1.89' }, BASE_STATE.positions[1]!],
      };
      writeSnapshot(next1, snapFile(dir), diffFile(dir));
      invalidateCache();
      const snap1 = loadSnapshot(snapFile(dir)).snapshot;
      expect(snap1.seq).toBe(1);

      const next2: CurrentSnapshotState = {
        ...next1,
        positions: [{ address: 'C_ALICE', collateral: '10000', debt: '4002', healthFactor: '1.88' }, BASE_STATE.positions[1]!],
      };
      writeSnapshot(next2, snapFile(dir), diffFile(dir));
      invalidateCache();
      const snap2 = loadSnapshot(snapFile(dir)).snapshot;
      expect(snap2.seq).toBe(2);
    });

    it('appends exactly one JSONL line to the diff log per write', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);

      const changed: CurrentSnapshotState = {
        ...BASE_STATE,
        positions: [{ ...BASE_STATE.positions[0]!, debt: '9999' }, BASE_STATE.positions[1]!],
      };
      writeSnapshot(changed, snapFile(dir), diffFile(dir));

      const lines = fs.readFileSync(diffFile(dir), 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(1);
    });

    it('increments writes metric', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);
      const changed: CurrentSnapshotState = {
        ...BASE_STATE,
        positions: [{ ...BASE_STATE.positions[0]!, debt: '7777' }, BASE_STATE.positions[1]!],
      };
      writeSnapshot(changed, snapFile(dir), diffFile(dir));
      expect(getSnapshotMetrics().writes).toBe(1);
    });
  });

  describe('bootstrapping (no prior snapshot)', () => {
    it('creates the full snapshot file when none exists', () => {
      const dir = tmpDir();
      // No snapshot file — writeSnapshot must bootstrap
      writeSnapshot(BASE_STATE, snapFile(dir), diffFile(dir));
      expect(fs.existsSync(snapFile(dir))).toBe(true);
    });

    it('writes seq=1 on first write from bootstrap', () => {
      const dir = tmpDir();
      writeSnapshot(BASE_STATE, snapFile(dir), diffFile(dir));
      invalidateCache();
      const snap = loadSnapshot(snapFile(dir)).snapshot;
      // The bootstrap prev has empty state, so this IS a change → seq=1
      expect(snap.seq).toBe(1);
    });
  });

  describe('compaction', () => {
    it('truncates the diff log after COMPACTION_THRESHOLD entries', () => {
      const dir = tmpDir();
      writeRaw(dir, V2_FIXTURE);

      // Write 50 distinct changes to trigger compaction (threshold = 50)
      for (let i = 1; i <= 50; i++) {
        invalidateCache();
        const state: CurrentSnapshotState = {
          ...BASE_STATE,
          positions: [
            { address: 'C_ALICE', collateral: '10000', debt: String(4000 + i), healthFactor: '1.9' },
            BASE_STATE.positions[1]!,
          ],
        };
        writeSnapshot(state, snapFile(dir), diffFile(dir));
      }

      // After compaction the diff log should be empty (or contain very few lines)
      const diffContent = fs.readFileSync(diffFile(dir), 'utf8').trim();
      expect(diffContent).toBe('');
      expect(getSnapshotMetrics().compactions).toBeGreaterThanOrEqual(1);
    });
  });
});

// ── loadDiffLog ───────────────────────────────────────────────────────────────

describe('loadDiffLog', () => {
  it('returns empty entries when the diff file does not exist', () => {
    const result = loadDiffLog('/nonexistent/path/lending.snap.diff.jsonl');
    expect(result.entries).toHaveLength(0);
    expect(result.skippedLines).toBe(0);
  });

  it('parses all valid JSONL entries', () => {
    const dir = tmpDir();
    writeRaw(dir, V2_FIXTURE);

    const state1: CurrentSnapshotState = {
      ...BASE_STATE,
      positions: [{ ...BASE_STATE.positions[0]!, debt: '4001' }, BASE_STATE.positions[1]!],
    };
    const state2: CurrentSnapshotState = {
      ...BASE_STATE,
      positions: [{ ...BASE_STATE.positions[0]!, debt: '4002' }, BASE_STATE.positions[1]!],
    };

    writeSnapshot(state1, snapFile(dir), diffFile(dir));
    invalidateCache();
    writeSnapshot(state2, snapFile(dir), diffFile(dir));

    const { entries, skippedLines } = loadDiffLog(diffFile(dir));
    expect(entries).toHaveLength(2);
    expect(skippedLines).toBe(0);
    expect(entries[0]?.seq).toBe(1);
    expect(entries[1]?.seq).toBe(2);
  });

  it('skips unparseable lines and counts them', () => {
    const dir = tmpDir();
    const df = diffFile(dir);
    fs.writeFileSync(df, 'GARBAGE_LINE\n{"seq":1,"recordedAt":"2026-01-01T00:00:00Z","diff":{"positions":{"added":[],"removed":[],"modified":[]},"pools":{"added":[],"removed":[],"modified":[]},"governance":{"added":[],"removed":[],"modified":[]},"isEmpty":true}}\n', 'utf8');
    const { entries, skippedLines } = loadDiffLog(df);
    expect(entries).toHaveLength(1);
    expect(skippedLines).toBe(1);
  });

  it('ignores blank lines', () => {
    const dir = tmpDir();
    const df = diffFile(dir);
    fs.writeFileSync(df, '\n\n\n', 'utf8');
    const { entries, skippedLines } = loadDiffLog(df);
    expect(entries).toHaveLength(0);
    expect(skippedLines).toBe(0);
  });
});

// ── observability: getSnapshotMetrics ─────────────────────────────────────────

describe('getSnapshotMetrics', () => {
  it('returns a copy — mutations do not affect internal state', () => {
    const m1 = getSnapshotMetrics();
    (m1 as any).loads = 999;
    expect(getSnapshotMetrics().loads).toBe(0);
  });

  it('tracks migrations via the migrations counter', () => {
    const dir = tmpDir();
    writeRaw(dir, V1_FIXTURE);
    loadSnapshot(snapFile(dir));
    expect(getSnapshotMetrics().migrations).toBe(1);
  });

  it('records lastLoadMs as a non-negative number', () => {
    const dir = tmpDir();
    writeRaw(dir, V2_FIXTURE);
    loadSnapshot(snapFile(dir));
    expect(getSnapshotMetrics().lastLoadMs).toBeGreaterThanOrEqual(0);
  });

  it('records lastWriteMs after a successful write', () => {
    const dir = tmpDir();
    writeRaw(dir, V2_FIXTURE);
    const changed: CurrentSnapshotState = {
      ...BASE_STATE,
      positions: [{ ...BASE_STATE.positions[0]!, debt: '8888' }, BASE_STATE.positions[1]!],
    };
    writeSnapshot(changed, snapFile(dir), diffFile(dir));
    expect(getSnapshotMetrics().lastWriteMs).toBeGreaterThanOrEqual(0);
  });

  it('diffEntriesWritten counts only real (non-empty) writes', () => {
    const dir = tmpDir();
    writeRaw(dir, V2_FIXTURE);
    writeSnapshot(BASE_STATE, snapFile(dir), diffFile(dir)); // no-op
    expect(getSnapshotMetrics().diffEntriesWritten).toBe(0);

    const changed: CurrentSnapshotState = {
      ...BASE_STATE,
      positions: [{ ...BASE_STATE.positions[0]!, debt: '5555' }, BASE_STATE.positions[1]!],
    };
    writeSnapshot(changed, snapFile(dir), diffFile(dir));
    expect(getSnapshotMetrics().diffEntriesWritten).toBe(1);
  });
});
