# Snapshots Runbook

**Scope:** `snapshots/`  
**Optimisation wave:** drips-wave · high · 200-points

---

## Overview

The `snapshots/` directory stores a point-in-time image of the StellarLend
lending contract state (positions, pools, governance proposals). This runbook
covers the schema, the write path, operational procedures, and how to
diagnose problems.

### File layout

```
snapshots/
├── lending.snap.json          Full snapshot — always the current canonical state
├── lending.snap.diff.jsonl    Append-only diff log (one JSON object per line)
├── schema.ts                  TypeScript types for v1 and v2 snapshots
├── validate.ts                Zero-dependency runtime validator
├── snapshotDiff.ts            Pure diff / patch logic (computeDiff, applyDiff)
├── snapshotLoader.ts          Read / write / compact with observability
├── tsconfig.json
├── package.json
├── RUNBOOK.md                 This file
└── __tests__/
    ├── validate.test.ts
    ├── snapshotDiff.test.ts
    └── snapshotLoader.test.ts
```

---

## Schema versions

| Version | Added fields | Notes |
|---|---|---|
| 1 | `positions`, `pools`, `governance` | Original schema |
| 2 | `seq` (required); `lastUpdatedLedger` on positions; `liquidationThresholdBps` on pools; `timelockAt` on governance | Current (`CURRENT_SNAPSHOT_VERSION = 2`) |

**Current version is 2.** `lending.snap.json` always stores the current
version. The loader migrates v1 files to v2 automatically on first read.

When bumping the version:
1. Add a new entry to the version history table in `schema.ts`.
2. Add the new TypeScript types (extend the previous version's interfaces).
3. Add the new version to the `LendingSnapshot` union.
4. Add a migration branch to `snapshotLoader.migrate()`.
5. Update this table.

---

## Performance: what changed and why

### Before

Every snapshot update rewrote the entire `lending.snap.json` from scratch:
O(N) JSON serialisation + a full fsync, even when only one position changed.
At 10 000+ positions this produced measurable write latency and unnecessary
GC pressure on the writing process.

There was also no validation, no schema versioning, and no way to audit what
changed between two snapshots.

### After

**Incremental writes.** `writeSnapshot()` calls `computeDiff()` before
writing. If the state is identical to the previous snapshot the write is
skipped entirely (`written: false`). When changes exist:

1. A diff entry is appended to `lending.snap.diff.jsonl` (append-only, cheap).
2. The full `lending.snap.json` is rewritten with the new state and an
   incremented `seq` counter.

This keeps the full file always up to date for readers while giving operators
a machine-readable audit log of every change.

**Mtime-based load cache.** `loadSnapshot()` caches the last loaded snapshot
in memory and skips the disk read on subsequent calls when the file's mtime
has not changed. A cold read (file changed or first call) validates and
optionally migrates the snapshot before caching it.

**Automatic compaction.** When the diff log reaches 50 entries the log is
truncated to empty. The full snapshot already contains the cumulative state,
so the diff log at that point is a pure audit artifact. Adjust
`COMPACTION_THRESHOLD` in `snapshotLoader.ts` if you need a longer audit
window.

---

## Reading a snapshot

```ts
import { loadSnapshot } from './snapshotLoader';

const { snapshot, fromCache, migrated, durationMs } = loadSnapshot();
console.log(snapshot.seq, snapshot.state.positions.length);
```

`loadSnapshot()` throws if:
- The file does not exist.
- The file contains invalid JSON.
- Validation fails (see error message for field-level details).

For a non-throwing path, wrap in try/catch and inspect `getSnapshotMetrics().validationErrors`.

---

## Writing a snapshot

```ts
import { writeSnapshot } from './snapshotLoader';
import type { CurrentSnapshotState } from './schema';

const nextState: CurrentSnapshotState = { positions: [...], pools: [...], governance: [...] };
const result = writeSnapshot(nextState);

if (result.written) {
  console.log(`seq ${result.diff} written, compacted=${result.compacted}`);
} else {
  console.log('No changes — write skipped');
}
```

`writeSnapshot()` is synchronous. It performs two file operations on a real
write (append diff log + rewrite full snapshot). Both operations use Node's
synchronous `fs` API so there is no partial-write window between them in the
single-threaded Node process.

---

## Validating a snapshot manually

```ts
import { validateSnapshot } from './validate';

const raw = JSON.parse(require('fs').readFileSync('snapshots/lending.snap.json', 'utf8'));
const result = validateSnapshot(raw);

if (!result.ok) {
  console.error(result.errors);   // full list of field-level errors
} else {
  console.log('Valid', result.snapshot.version);
}
```

---

## Reading the diff log

```ts
import { loadDiffLog } from './snapshotLoader';

const { entries, skippedLines } = loadDiffLog();
for (const entry of entries) {
  console.log(`seq ${entry.seq} @ ${entry.recordedAt}:`);
  console.log('  positions added:', entry.diff.positions.added.length);
  console.log('  positions removed:', entry.diff.positions.removed.length);
  console.log('  positions modified:', entry.diff.positions.modified.length);
}
if (skippedLines > 0) {
  console.warn(`${skippedLines} unparseable lines skipped`);
}
```

Each diff entry carries the full `StateDiff` shape — a list of added,
removed, and modified entities per collection. Entries are ordered by `seq`
(ascending). A gap in seq values means compaction occurred between those two
points; the full snapshot at the time of compaction is the authoritative
state.

---

## Replaying diffs onto a base snapshot

If you have an older full snapshot and a diff log, you can reconstruct the
current state without re-reading the full file:

```ts
import { applyDiff } from './snapshotDiff';

let state = olderSnapshot.state;
for (const entry of diffEntries) {
  state = applyDiff(state, entry.diff);
}
// state is now equivalent to the current full snapshot
```

This is useful for external audit tools and analytics pipelines that need to
replay history without loading large JSON blobs.

---

## Observability

`getSnapshotMetrics()` returns a snapshot of all counters and timers:

```ts
import { getSnapshotMetrics } from './snapshotLoader';

const m = getSnapshotMetrics();
```

| Metric | Description |
|---|---|
| `loads` | Total calls to `loadSnapshot()` |
| `cacheHits` | Calls that returned from the mtime cache without a disk read |
| `writes` | Successful `writeSnapshot()` calls that produced a file change |
| `compactions` | Number of times the diff log was truncated |
| `migrations` | v1 → v2 migrations performed on load |
| `validationErrors` | Calls that threw due to a validation failure |
| `diffEntriesWritten` | Total diff entries appended to the JSONL log |
| `lastLoadMs` | Duration of the most recent load (ms) |
| `lastWriteMs` | Duration of the most recent write (ms) |
| `lastCompactionMs` | Duration of the most recent compaction (ms) |

Wire these into your existing metrics exporter (Prometheus, Datadog, etc.)
by calling `getSnapshotMetrics()` on each scrape interval.

Structured log lines are emitted on every significant operation using the
format `[<ISO-8601>] [snapshot:<LEVEL>] <message> <JSON meta>`. Route them
to your log aggregator alongside the API process logs.

---

## CI

```bash
cd snapshots
npm test          # jest --coverage --verbose
```

All tests run against temporary directories created with `os.tmpdir()` —
they never touch `lending.snap.json`.

---

## Operational procedures

### Forcing a cache invalidation

If the snapshot file was updated by an out-of-process tool (e.g. a migration
script), call `invalidateCache()` before the next `loadSnapshot()` call to
force a fresh disk read:

```ts
import { invalidateCache } from './snapshotLoader';
invalidateCache();
```

### Manual compaction

The diff log compacts automatically at 50 entries. To compact manually:

```ts
import { writeSnapshot, loadSnapshot } from './snapshotLoader';
// Write the current state again — if unchanged, the write is skipped.
// To force compaction, write a trivial state change and then revert it,
// or truncate the diff log file directly after verifying the full snapshot
// is consistent:
require('fs').writeFileSync('snapshots/lending.snap.diff.jsonl', '', 'utf8');
```

### Recovering from a corrupt snapshot

1. Check `getSnapshotMetrics().validationErrors` — if > 0, the last load failed.
2. Run `validateSnapshot()` manually to see the full error list.
3. If the full snapshot is corrupt, restore from your last known-good backup.
4. Replay the diff log entries that post-date the backup using `applyDiff()` to
   reconstruct the current state, then call `writeSnapshot()` with the result.

### Upgrading the schema to a new version

1. Bump `CURRENT_SNAPSHOT_VERSION` in `schema.ts`.
2. Add the new TypeScript types (extend previous version interfaces).
3. Add a migration function and call it from `migrate()` in `snapshotLoader.ts`.
4. Update the version table in this runbook.
5. The existing `lending.snap.json` will be migrated automatically on the
   next `loadSnapshot()` call; `writeSnapshot()` will then rewrite it in the
   new version format.

---

## Related issues

- drips-wave snapshots optimisation (this change)
- drips-wave bots optimisation (`bots/liquidation-bot/README.md`)
