import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateCandidate, validateEvent, validateSuggestion } from '../contracts.mjs';
import {
  appendEvent,
  loadState,
  pruneState,
  recoverStateLock,
  rejectCandidate,
  recordCandidates,
  recordCapabilityEvidence,
  recordWorkerProgress,
  recordSkillInventoryEvidence,
  recordSource,
  recordTransition,
  withStateLock,
} from '../state.mjs';

const timestamp = '2027-01-23T00:00:00.000Z';

function event(id, occurredAt = timestamp) {
  return {
    version: 1,
    id,
    host: 'codex',
    session: 'session-1',
    originEventId: `origin-${id}`,
    occurredAt,
    scope: { kind: 'global' },
    locator: `codex://${id}`,
    kind: 'request',
    provenance: 'verified',
  };
}

function candidate(id = 'candidate-1') {
  return {
    id,
    patternKey: 'prefer-small-diffs',
    scope: { kind: 'global' },
    artifactKind: 'skill',
    status: 'candidate',
    sourceEventIds: ['event-1'],
    baselineHash: null,
    diffHash: null,
    policyVersion: '1',
    version: 0,
  };
}

async function stateDir() {
  return mkdtemp(join(tmpdir(), 'setup-learning-'));
}

async function withDir(fn) {
  const dir = await stateDir();
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('rejects schema extras, raw bodies, unknown evidence, and staged null hashes', async () => {
  assert.throws(() => validateEvent({ ...event('event-1'), extra: true }), /extra/);
  assert.throws(() => validateEvent({ ...event('event-1'), prompt: 'raw body' }), /extra/);
  assert.throws(() => validateEvent({ ...event('event-1'), locator: 'raw body' }), /locator/);
  assert.throws(() => validateEvent({ ...event('event-1'), occurredAt: '2027-02-30T00:00:00.000Z' }), /ISO UTC/);
  assert.throws(() => validateSuggestion({
    patternKey: 'x', summary: 'x', scope: { kind: 'global' }, supportEventIds: ['missing'],
    correctionEventIds: [], contradicts: [], artifactKind: 'skill', diagnosis: 'x',
  }, { eventIds: ['event-1'] }), /eventIds/);
  assert.throws(() => validateCandidate({ ...candidate(), baselineHash: null, diffHash: 'a'.repeat(64), status: 'candidate' }), /hashes/);
  const schema = JSON.parse(await readFile(new URL('../references/candidate.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.scope.oneOf.every(({ additionalProperties }) => additionalProperties === false), true);
  assert.equal(schema.properties.sourceEventIds.uniqueItems, true);
  assert.equal(schema.oneOf.length, 2);
});

test('appends an immutable signal before materializing an event and replays idempotently after a crash', async () => withDir(async (dir) => {
  const value = event('event-1');
  await appendEvent(dir, value);
  await appendEvent(dir, value);
  assert.deepEqual((await loadState(dir)).events, [value]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'signals', 'event-1.json'), 'utf8')), value);
  assert.equal((await readFile(join(dir, 'journal.jsonl'), 'utf8')).trim().split('\n').length, 1);
}));

test('records a typed lifecycle source without turning it into a human event', async () => withDir(async (dir) => {
  await recordSource(dir, { host: 'codex', event: 'SessionStart', session: 'session-1', occurredAt: timestamp, locator: 'codex://hook/a' });
  const state = await loadState(dir);
  assert.equal(state.events.length, 0); assert.deepEqual(state.sources, [{ host: 'codex', event: 'SessionStart', session: 'session-1', occurredAt: timestamp, locator: 'codex://hook/a' }]);
}));

test('persists only ordered controller capability evidence', async () => withDir(async (dir) => {
  const available = { capability: 'scheduler', status: 'available', evidenceRef: 'automation:observed-1', observedAt: timestamp };
  await recordCapabilityEvidence(dir, available);
  assert.deepEqual((await loadState(dir)).capabilities.scheduler, available);
  await assert.rejects(recordCapabilityEvidence(dir, { ...available, status: 'pending', evidenceRef: 'automation:stale', observedAt: '2027-01-22T00:00:00.000Z' }), /stale/);
  await assert.rejects(recordCapabilityEvidence(dir, { ...available, extra: true }), /extra/);
  assert.deepEqual((await loadState(dir)).capabilities.scheduler, available);
}));

test('persiste somente inventário skills/list fechado e monotônico', async () => withDir(async (dir) => {
  const inventory = { source: 'skills/list', evidenceRef: 'skills-list:observed-1', observedAt: timestamp, skills: [{ path: '.agents/skills/demo/SKILL.md', hash: 'a'.repeat(64), disabled: true }] };
  await recordSkillInventoryEvidence(dir, inventory);
  assert.deepEqual((await loadState(dir)).skillInventory, inventory);
  await assert.rejects(recordSkillInventoryEvidence(dir, { ...inventory, observedAt: '2027-01-22T00:00:00.000Z' }), /stale/);
  await assert.rejects(recordSkillInventoryEvidence(dir, { ...inventory, skills: [{ ...inventory.skills[0], path: '../config.toml' }] }), /inventory/);
  assert.deepEqual((await loadState(dir)).skillInventory, inventory);
}));

test('does not replace an existing immutable signal for a reused event id', async () => withDir(async (dir) => {
  await appendEvent(dir, event('event-1'));
  await assert.rejects(appendEvent(dir, { ...event('event-1'), locator: 'codex://changed' }), /immutable/i);
  assert.equal(JSON.parse(await readFile(join(dir, 'signals', 'event-1.json'), 'utf8')).locator, 'codex://event-1');
}));

test('recovers only a partial final journal line but marks middle corruption pending', async () => withDir(async (dir) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'event', value: event('event-1') })}\n{`, 'utf8');
  assert.equal((await loadState(dir)).events.length, 1);
  await appendEvent(dir, event('event-2'));
  const recovered = await loadState(dir);
  assert.deepEqual(recovered.events.map(({ id }) => id), ['event-1', 'event-2']);
  assert.equal(recovered.pending, undefined);

  await rm(join(dir, 'snapshot.json'));
  await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'event', value: event('event-1') })}\nnot-json\n${JSON.stringify({ type: 'event', value: event('event-2') })}\n`, 'utf8');
  const state = await loadState(dir);
  assert.equal(state.events.length, 1);
  assert.equal(state.pending?.reason, 'journal_corruption');
}));

test('uses byte cursors for UTF-8 journal entries', async () => withDir(async (dir) => {
  const value = { ...event('event-1'), locator: 'codex://ação' };
  await appendEvent(dir, value);
  const state = await loadState(dir);
  const bytes = Buffer.byteLength(await readFile(join(dir, 'journal.jsonl'), 'utf8'));
  assert.equal(state.cursors.import, bytes);
  assert.ok(bytes > (await readFile(join(dir, 'journal.jsonl'), 'utf8')).length);
}));

test('normalizes legacy worker snapshots and journals without historyAfter', async () => withDir(async (dir) => {
  const imports = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`codex://history/${index}`, String(index)]));
  const events = Array.from({ length: 7 }, (_, index) => event(`legacy-${index}`));
  const legacyWorker = { imports, analyzedEventIds: events.map(({ id }) => id), handoff: null };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ events, worker: legacyWorker }), 'utf8');
  await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'worker', value: legacyWorker })}\n`, 'utf8');
  const loaded = await loadState(dir);
  assert.equal(loaded.events.length, 7); assert.equal(Object.keys(loaded.worker.imports).length, 32); assert.equal(loaded.worker.historyAfter, null);
  await recordWorkerProgress(dir, { ...loaded.worker, historyAfter: 'claude://history/next' });
  assert.equal((await loadState(dir)).worker.historyAfter, 'claude://history/next');
  await assert.rejects(recordWorkerProgress(dir, { ...(await loadState(dir)).worker, arbitrary: true }), /invalid fields/);
  await assert.rejects(recordWorkerProgress(dir, { ...(await loadState(dir)).worker, historyAfter: 'codex://C:\\raw\\path' }), /historyAfter/);
}));

test('refuses an existing lock unless its identity is demonstrably this writer', async () => withDir(async (dir) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.lock'), JSON.stringify({ writerId: 'other', pid: 999999 }), 'utf8');
  await assert.rejects(withStateLock(dir, async () => {}), /lock.*pending/i);
  await rm(join(dir, '.lock'));
  let secondWriterBlocked = false;
  await withStateLock(dir, async () => {
    await assert.rejects(withStateLock(dir, async () => {}), /lock.*pending/i);
    secondWriterBlocked = true;
  });
  assert.equal(secondWriterBlocked, true);

  const replacement = { writerId: 'replacement', pid: 999998 };
  await assert.rejects(withStateLock(dir, async () => {
    await writeFile(join(dir, '.lock'), JSON.stringify(replacement), 'utf8');
  }), /lock.*pending/i);
  assert.deepEqual(JSON.parse(await readFile(join(dir, '.lock'), 'utf8')), replacement);
  await rm(join(dir, '.lock'));
}));

test('recovers only an unchanged expired lock whose PID is proven dead', async () => withDir(async (dir) => {
  await mkdir(dir, { recursive: true }); const identity = { writerId: 'writer-stale', pid: 999999, createdAt: '2027-01-23T00:00:00.000Z' };
  await writeFile(join(dir, '.lock'), JSON.stringify(identity));
  assert.deepEqual(await recoverStateLock(dir, { now: () => Date.parse('2027-01-23T00:01:00.000Z'), isAlive: () => true }), { status: 'pending', reason: 'pid_active' });
  let release; const held = new Promise((resolve) => { release = resolve; }); let guarded; const guardReached = new Promise((resolve) => { guarded = resolve; });
  const first = recoverStateLock(dir, { now: () => Date.parse('2027-01-23T00:01:00.000Z'), isAlive: () => false, afterGuard: async () => { guarded(); await held; } });
  await guardReached; const second = await recoverStateLock(dir, { now: () => Date.parse('2027-01-23T00:01:00.000Z'), isAlive: () => false }); assert.deepEqual(second, { status: 'pending', reason: 'recovery_active' }); release();
  assert.deepEqual(await first, { status: 'recovered', writerId: 'writer-stale' });
  await withStateLock(dir, async () => {});
}));

test('never removes a recent, malformed, or orphan-recovery guard', async () => withDir(async (dir) => {
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, '.lock'), JSON.stringify({ writerId: 'recent', pid: 999999, createdAt: '2027-01-23T00:00:45.000Z' }));
  assert.deepEqual(await recoverStateLock(dir, { now: () => Date.parse('2027-01-23T00:01:00.000Z'), isAlive: () => false }), { status: 'pending', reason: 'ttl_active' });
  await writeFile(join(dir, '.lock'), '{invalid'); assert.deepEqual(await recoverStateLock(dir, { now: () => Date.parse('2027-01-23T00:01:00.000Z'), isAlive: () => false }), { status: 'pending', reason: 'identity_invalid' });
  await writeFile(join(dir, '.recovery.lock'), JSON.stringify({ writerId: 'unknown' })); assert.deepEqual(await recoverStateLock(dir), { status: 'pending', reason: 'recovery_active' });
}));

test('records a candidate transition with compare-and-swap versioning', async () => withDir(async (dir) => {
  await withStateLock(dir, async () => {
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ candidates: [candidate()] }), 'utf8');
  });
  const changed = await recordTransition(dir, {
    candidateId: 'candidate-1', expectedVersion: 0,
    event: { previousStatus: 'candidate', status: 'pending', at: timestamp, reason: 'needs review' },
  });
  assert.equal(changed.status, 'pending');
  assert.equal(changed.version, 1);
  await assert.rejects(recordTransition(dir, {
    candidateId: 'candidate-1', expectedVersion: 0,
    event: { previousStatus: 'candidate', status: 'pending', at: timestamp, reason: 'stale' },
  }), /version/);
  await assert.rejects(recordTransition(dir, {
    candidateId: 'candidate-1', expectedVersion: 1,
    event: { previousStatus: 'pending', status: 'invented', at: timestamp, reason: 'invalid' },
  }), /status/);
  await assert.rejects(recordTransition(dir, {
    candidateId: 'candidate-1', expectedVersion: 1, extra: true,
    event: { previousStatus: 'pending', status: 'rejected', at: timestamp, reason: 'invalid' },
  }), /extra/);
  await assert.rejects(recordTransition(dir, {
    candidateId: 'candidate-1', expectedVersion: 1,
    event: { previousStatus: 'pending', status: 'local_applied', at: timestamp, reason: 'not staged' },
  }), /hashes/);
}));

test('rejects through a closed auditable route and persists a tombstone', async () => withDir(async (dir) => {
  await recordCandidates(dir, [candidate()]);
  const rejected = await rejectCandidate(dir, { candidateId: 'candidate-1', expectedVersion: 0, at: timestamp, reason: 'policy_denied', evidenceRef: 'review:closed-1' });
  assert.equal(rejected.status, 'rejected'); const state = await loadState(dir); assert.deepEqual(state.tombstones, [{ candidateId: 'candidate-1', patternKey: 'prefer-small-diffs', rejectedAt: timestamp, reason: 'policy_denied', evidenceRef: 'review:closed-1' }]);
  await assert.rejects(rejectCandidate(dir, { candidateId: 'candidate-1', expectedVersion: 1, at: timestamp, reason: 'free_text', evidenceRef: 'review:closed-2' }), /rejection/);
}));

test('prunes lifecycle sources older than ninety days', async () => withDir(async (dir) => {
  await recordSource(dir, { host: 'codex', event: 'SessionStart', session: 'old-session', occurredAt: '2027-01-22T23:59:59.999Z', locator: 'codex://hook/old' });
  await recordSource(dir, { host: 'codex', event: 'SessionStart', session: 'keep-session', occurredAt: '2027-01-23T00:00:00.000Z', locator: 'codex://hook/keep' });
  const result = await pruneState(dir, '2027-04-23T00:00:00.000Z'); assert.equal(result.removedSources, 1); assert.deepEqual((await loadState(dir)).sources.map(({ session }) => session), ['keep-session']);
}));

test('prunes retention boundaries while preserving active manifests and sources', async () => withDir(async (dir) => {
  const now = '2027-04-23T00:00:00.000Z';
  await assert.rejects(pruneState(dir, '2027-04-23'), /ISO UTC/);
  await withStateLock(dir, async () => {
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({
      manifests: [
        { id: 'active-1', active: true, createdAt: '2026-01-01T00:00:00.000Z', backupRef: 'active-backup' },
        { id: 'off-91', active: false, createdAt: '2027-01-22T00:00:00.000Z', deactivatedAt: '2027-01-21T23:59:59.999Z', backupRef: 'off-backup' },
        { id: 'old-181', active: false, createdAt: '2026-10-24T23:59:59.999Z', backupRef: 'old-backup' },
      ],
      evidence: [{ id: 'active-backup' }, { id: 'off-backup' }, { id: 'old-backup' }],
      tombstones: [{ patternKey: 'rejected-pattern', rejectedAt: '2026-01-01T00:00:00.000Z' }],
    }), 'utf8');
  });
  await appendEvent(dir, event('keep-90', '2027-01-23T00:00:00.000Z'));
  await appendEvent(dir, event('remove-91', '2027-01-22T23:59:59.999Z'));
  const result = await pruneState(dir, now);
  assert.equal(result.removedEvents, 1);
  assert.equal(result.removedEvidence, 3);
  assert.deepEqual(result.preservedManifests, ['active-1']);
  const state = await loadState(dir);
  assert.deepEqual(state.events.map(({ id }) => id), ['keep-90']);
  assert.equal(state.manifests.find((item) => item.active).id, 'active-1');
  assert.deepEqual(state.tombstones, [{ patternKey: 'rejected-pattern', rejectedAt: '2026-01-01T00:00:00.000Z' }]);
  assert.equal((await readFile(join(dir, 'journal.jsonl'), 'utf8')).includes('remove-91'), false);
  await assert.rejects(readFile(join(dir, 'signals', 'remove-91.json'), 'utf8'), { code: 'ENOENT' });
}));

test('does not prune a state with middle journal corruption', async () => withDir(async (dir) => {
  const raw = `${JSON.stringify({ type: 'event', value: event('remove-91', '2027-01-22T23:59:59.999Z') })}\nnot-json\n${JSON.stringify({ type: 'event', value: event('event-2') })}\n`;
  await writeFile(join(dir, 'journal.jsonl'), raw, 'utf8');
  const result = await pruneState(dir, '2027-04-23T00:00:00.000Z');
  assert.equal(result.removedEvents, 0);
  assert.equal(result.pending?.reason, 'journal_corruption');
  assert.equal(await readFile(join(dir, 'journal.jsonl'), 'utf8'), raw);
}));

test('maps valid event identifiers to portable signal filenames', async () => withDir(async (dir) => {
  await appendEvent(dir, event('event:1'));
  await appendEvent(dir, event('CON'));
  await appendEvent(dir, event('Event'));
  await appendEvent(dir, event('event'));
  assert.equal(JSON.parse(await readFile(join(dir, 'signals', 'event%3A1.json'), 'utf8')).id, 'event:1');
  assert.equal(JSON.parse(await readFile(join(dir, 'signals', '%43%4F%4E.json'), 'utf8')).id, 'CON');
  assert.equal(JSON.parse(await readFile(join(dir, 'signals', '%45vent.json'), 'utf8')).id, 'Event');
  assert.equal(JSON.parse(await readFile(join(dir, 'signals', 'event.json'), 'utf8')).id, 'event');
}));

test('refuses state paths that escape through a symlink or junction', async () => withDir(async (dir) => {
  const outside = await stateDir();
  try {
    await symlink(outside, join(dir, 'signals'), 'junction');
    await assert.rejects(appendEvent(dir, event('event-1')), /containment/i);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}));

test('refuses a state directory that is itself a symlink or junction', async () => withDir(async (dir) => {
  const outside = await stateDir();
  const linkedState = join(dir, 'linked-state');
  try {
    await symlink(outside, linkedState, 'junction');
    await assert.rejects(appendEvent(linkedState, event('event-1')), /containment/i);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}));

test('refuses a state directory below a symlink or junction ancestor', async () => withDir(async (dir) => {
  const outside = await stateDir();
  const linkedParent = join(dir, 'linked-parent');
  try {
    await symlink(outside, linkedParent, 'junction');
    await assert.rejects(appendEvent(join(linkedParent, 'nested-state'), event('event-1')), /containment/i);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}));
