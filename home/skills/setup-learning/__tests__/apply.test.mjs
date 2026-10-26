import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { activate, createHostApplicationAdapters, createTrustedApplicationAdapter, recordValidation, rollback, stageCandidate } from '../apply.mjs';
import { runCli } from '../cli.mjs';
import { loadState, pruneState, recordCandidates } from '../state.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const candidate = (id = 'candidate-1') => ({ id, patternKey: `small-diffs-${id}`, scope: { kind: 'global' }, artifactKind: 'skill', status: 'candidate', sourceEventIds: ['event-1'], baselineHash: null, diffHash: null, policyVersion: '1', version: 0 });
const validationMarker = (repo, name) => join(tmpdir(), `.setup-learning-${basename(repo)}-${name}`);

async function withRepo(fn, candidateValue = candidate()) {
  const repo = await mkdtemp(join(tmpdir(), 'setup-learning-apply-')); const stateDir = await mkdtemp(join(tmpdir(), 'setup-learning-state-'));
  let targetRoot;
  try {
    git(repo, ['init']); git(repo, ['config', 'user.email', 'test@example.invalid']); git(repo, ['config', 'user.name', 'Setup Learning Test']);
    await mkdir(join(repo, 'skills', 'setup-learning', '__tests__'), { recursive: true }); await mkdir(join(repo, 'tools'), { recursive: true });
    await writeFile(join(repo, 'skills', 'setup-learning', '__tests__', 'fixture.test.mjs'), "import assert from 'node:assert/strict'; import test from 'node:test'; test('fixture', () => assert.equal(process.env.SETUP_LEARNING_PRIVATE_SENTINEL, undefined));\n");
    await writeFile(join(repo, 'tools', 'dotfiles.mjs'), "import { appendFileSync, existsSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { basename, join } from 'node:path';\nconst marker = (name) => join(tmpdir(), `.setup-learning-${basename(process.cwd())}-${name}`);\nif (!['scan', 'verify'].includes(process.argv[2])) process.exitCode = 1;\nif (process.argv[2] === 'verify' && existsSync(marker('mutate-tree'))) appendFileSync('skills/example/SKILL.md', 'changed during validation\\n');\nif (process.argv[2] === 'verify' && existsSync(marker('mutate-review'))) appendFileSync(readFileSync(marker('mutate-review'), 'utf8'), ' ');\n");
    await writeFile(join(repo, 'README.md'), 'base\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']); const baseRef = git(repo, ['rev-parse', 'HEAD']);
    await mkdir(join(repo, 'skills', 'example'), { recursive: true }); await writeFile(join(repo, 'skills', 'example', 'SKILL.md'), 'version two\n'); await writeFile(join(repo, 'skills', 'example', 'reference.md'), 'reference two\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'fixture']);
    await recordCandidates(stateDir, [candidateValue]);
    const staged = await stageCandidate({ stateDir, candidateId: candidateValue.id, worktree: repo, baseRef, files: ['skills/example/SKILL.md', 'skills/example/reference.md'] });
    const commit = git(repo, ['rev-parse', 'HEAD']); const content = await readFile(join(repo, 'skills', 'example', 'SKILL.md')); const reference = await readFile(join(repo, 'skills', 'example', 'reference.md'));
    targetRoot = await mkdtemp(join(tmpdir(), 'setup-learning-target-'));
    await fn({ repo, stateDir, candidate: staged.candidate, commit, baseRef, sourceHash: sha(content), referenceHash: sha(reference), targetRoot });
  } finally { for (const name of ['mutate-tree', 'mutate-review']) await rm(validationMarker(repo, name), { force: true }); await rm(repo, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true }); if (targetRoot) await rm(targetRoot, { recursive: true, force: true }); }
}

test('mantém candidato de projeto no handoff sem permitir stage ou apply nas roots globais', async () => withRepo(async (fixture) => {
  assert.equal(fixture.candidate.status, 'pending');
  const result = await activate({ ...fixture, receiptId: 'unavailable', targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo)], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.deepEqual(result, { status: 'pending', reason: 'project_scope_adapter_unavailable', hostStates: {} });
  await assert.rejects(readFile(installedPath(fixture.targetRoot)), { code: 'ENOENT' });
}, { ...candidate('project-candidate'), scope: { kind: 'repo', repo: 'repo-canonical' } }));

async function receipt({ stateDir, candidate, repo, commit }) {
  const reviewEvidenceRef = `review-${candidate.id}`; await mkdir(join(stateDir, 'review-evidence'), { recursive: true });
  await writeFile(join(stateDir, 'review-evidence', `${reviewEvidenceRef}.json`), JSON.stringify({ version: 1, id: reviewEvidenceRef, candidateId: candidate.id, commit, diffHash: candidate.diffHash, scope: 'slice-review', verdict: 'approve' }));
  return recordValidation({ stateDir, candidateId: candidate.id, worktree: repo, validationProfile: 'engine-skill', reviewEvidenceRef });
}
function target(root, sourceHash, sourceWorktree, extra = {}) {
  const sourcePath = extra.sourcePath ?? 'skills/example/SKILL.md';
  const host = extra.host ?? 'codex'; const smoke = extra.smoke ?? (async () => ({ passed: true, evidenceRef: 'fixture-smoke' }));
  return { adapter: createTrustedApplicationAdapter({ id: `${host}-fixture`, host, root, smoke }), expectedHash: extra.expectedHash ?? null, relativePath: sourcePath, sourcePath, sourceHash, sourceWorktree };
}
const installedPath = (root, sourcePath = 'skills/example/SKILL.md') => join(root, ...sourcePath.split('/'));

test('CLI keeps activation pending when no trusted runtime adapter is wired', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'setup-learning-cli-')); let stdout = ''; let stderr = '';
  try {
    const code = await runCli(['activate', '--state-dir', stateDir], { writeOut: (value) => { stdout += value; }, writeErr: (value) => { stderr += value; } });
    assert.equal(code, 0); assert.deepEqual(JSON.parse(stdout), { status: 'pending', route: 'activate' }); assert.match(stderr, /^pending:/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('does not accept a profile for the wrong artifact kind', async () => withRepo(async (fixture) => {
  const reviewEvidenceRef = `review-${fixture.candidate.id}`; await mkdir(join(fixture.stateDir, 'review-evidence'), { recursive: true });
  await writeFile(join(fixture.stateDir, 'review-evidence', `${reviewEvidenceRef}.json`), JSON.stringify({ version: 1, id: reviewEvidenceRef, candidateId: fixture.candidate.id, commit: fixture.commit, diffHash: fixture.candidate.diffHash, scope: 'slice-review', verdict: 'approve' }));
  assert.equal(await recordValidation({ stateDir: fixture.stateDir, candidateId: fixture.candidate.id, worktree: fixture.repo, validationProfile: 'engine-hook', reviewEvidenceRef }), null);
  assert.equal((await loadState(fixture.stateDir)).candidates[0].status, 'pending');
}));

test('stages only a closed static advisory hook template', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'setup-learning-hook-policy-')); const stateDir = await mkdtemp(join(tmpdir(), 'setup-learning-hook-state-'));
  try {
    git(repo, ['init']); git(repo, ['config', 'user.email', 'test@example.invalid']); git(repo, ['config', 'user.name', 'Setup Learning Test']);
    await writeFile(join(repo, 'README.md'), 'base\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']); const baseRef = git(repo, ['rev-parse', 'HEAD']);
    const file = 'home/hooks/setup-learning-generated/preference.json'; await mkdir(join(repo, 'home', 'hooks', 'setup-learning-generated'), { recursive: true });
    await writeFile(join(repo, file), JSON.stringify({ version: 1, kind: 'advisory-reminder', event: 'sessionStart', reminder: 'Prefira o helper existente.' })); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'valid hook']);
    await recordCandidates(stateDir, [{ ...candidate('hook-valid'), artifactKind: 'hook' }]);
    assert.equal((await stageCandidate({ stateDir, candidateId: 'hook-valid', worktree: repo, baseRef, files: [file] })).candidate.status, 'candidate');

    const validCommit = git(repo, ['rev-parse', 'HEAD']); await writeFile(join(repo, file), JSON.stringify({ version: 1, kind: 'advisory-reminder', event: 'sessionStart', reminder: 'Use {{dynamic}}.' })); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'invalid hook']);
    await recordCandidates(stateDir, [{ ...candidate('hook-invalid'), artifactKind: 'hook' }]);
    assert.equal((await stageCandidate({ stateDir, candidateId: 'hook-invalid', worktree: repo, baseRef: validCommit, files: [file] })).candidate.status, 'pending');
  } finally { await rm(repo, { recursive: true, force: true }); await rm(stateDir, { recursive: true, force: true }); }
});

test('does not write when the host is active or idle proof is unknown', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r);
  const result = await activate({ ...fixture, receiptId: r.id, targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo)], probeIdle: async () => ({ idle: false, reason: 'session-active' }) });
  assert.equal(result.status, 'pending');
  await assert.rejects(readFile(join(fixture.targetRoot, 'skills', 'example', 'SKILL.md')), { code: 'ENOENT' });
}));

test('uses the private receipt and applies only after CAS and smoke pass', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r);
  assert.deepEqual(r.commands.map(({ id }) => id), ['setup-learning-tests', 'dotfiles-scan', 'dotfiles-verify', 'git-diff-check']);
  assert.equal(r.runtime.node, process.version); assert.equal(r.runtime.platform, process.platform); assert.equal(r.runtime.arch, process.arch);
  const applied = await activate({ ...fixture, receiptId: r.id, targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo)], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(applied.status, 'local_applied', JSON.stringify(applied));
  assert.equal(await readFile(join(fixture.targetRoot, 'skills', 'example', 'SKILL.md'), 'utf8'), 'version two\n');
  assert.equal((await readdir(join(fixture.targetRoot, 'skills', 'example'))).some((name) => name.includes('.setup-learning-')), false);
  const stale = await activate({ ...fixture, receiptId: 'stale', targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo)], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(stale.status, 'pending');
}));

test('writes a shared skill once and verifies Codex and Claude access separately', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r); const probed = [];
  const smokes = Object.fromEntries(['codex', 'claude', 'cursor'].map((host) => [host, async () => { probed.push(host); return { passed: true, evidenceRef: `${host}-access` }; }]));
  const adapters = createHostApplicationAdapters({ home: fixture.targetRoot, smokes });
  const result = await activate({
    ...fixture, receiptId: r.id,
    targets: [{ adapter: adapters.skill, expectedHash: null, relativePath: 'example/SKILL.md', sourcePath: 'skills/example/SKILL.md', sourceHash: fixture.sourceHash, sourceWorktree: fixture.repo }],
    probeIdle: async () => ({ idle: true, reason: 'reload-documented' }),
  });
  assert.equal(result.status, 'local_applied'); assert.deepEqual(probed.sort(), ['claude', 'codex']);
  assert.equal(await readFile(join(fixture.targetRoot, '.agents', 'skills', 'example', 'SKILL.md'), 'utf8'), 'version two\n');
  await assert.rejects(readFile(join(fixture.targetRoot, '.claude', 'skills', 'example', 'SKILL.md')), { code: 'ENOENT' });
}));

test('keeps an applied host while another host remains pending', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r);
  const pending = target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { host: 'claude', smoke: async () => ({ passed: false, evidenceRef: 'smoke-failed' }) });
  const result = await activate({ ...fixture, receiptId: r.id, targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo), pending], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(result.status, 'local_applied');
  assert.equal(result.hostStates.codex.status, 'local_applied'); assert.equal(result.hostStates.claude.status, 'pending');
}));

test('rolls back only unchanged owned files and marks third-party changes urgent', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r); const item = target(fixture.targetRoot, fixture.sourceHash, fixture.repo);
  await activate({ ...fixture, receiptId: r.id, targets: [item], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  const path = installedPath(fixture.targetRoot); await writeFile(path, 'third party\n');
  const pending = await rollback({ ...fixture, receiptId: r.id, targets: [item], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(pending.status, 'pending'); assert.match(pending.reason, /urgent/i);
  assert.equal(await readFile(path, 'utf8'), 'third party\n');
}));

test('rejects target symlinks and receipt hashes that do not bind the staged candidate', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r); const outside = join(fixture.targetRoot, 'outside'); await writeFile(outside, 'outside');
  const link = join(fixture.targetRoot, 'skills'); await symlink(outside, link, 'junction');
  const result = await activate({ ...fixture, receiptId: r.id, targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo)], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(result.status, 'pending');
}));

test('returns pending for the losing concurrent activation instead of overwriting its CAS state', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r); let smokeCalls = 0; const item = target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { smoke: async () => { smokeCalls += 1; await new Promise((resolve) => setTimeout(resolve, 25)); return { passed: true, evidenceRef: 'fixture-smoke' }; } });
  const results = await Promise.allSettled([1, 2].map(() => activate({ ...fixture, receiptId: r.id, targets: [item], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) })));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 2);
  assert.equal(results.some(({ value }) => value?.status === 'local_applied'), true);
  assert.equal(results.some(({ value }) => value?.status === 'pending'), true);
  assert.equal(smokeCalls, 1);
}));

test('persists ownership before the write and resumes after a post-write interruption', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r); const item = target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { smoke: async () => { throw new Error('untrusted diagnostic'); } });
  const interrupted = await activate({ ...fixture, receiptId: r.id, targets: [item], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(interrupted.status, 'pending');
  assert.equal(JSON.stringify(interrupted).includes('untrusted diagnostic'), false);
  assert.equal(await readFile(installedPath(fixture.targetRoot), 'utf8'), 'version two\n');
  const afterInterruption = await loadState(fixture.stateDir);
  assert.equal(afterInterruption.applications[0].entries[0].phase, 'prepared');
  assert.equal(afterInterruption.applications[0].entries[0].backup, null);

  const busy = await activate({ ...fixture, receiptId: r.id, targets: [item], probeIdle: async () => ({ idle: false, reason: 'session-active' }) });
  assert.equal(busy.status, 'pending');
  assert.equal((await loadState(fixture.stateDir)).applications[0].entries[0].phase, 'prepared');

  const resumed = await activate({ ...fixture, receiptId: r.id, targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo)], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(resumed.status, 'local_applied');
  assert.equal((await loadState(fixture.stateDir)).applications[0].entries[0].phase, 'local_applied');
}));

test('preserves third-party bytes written after an interrupted application', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r);
  const interrupted = target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { smoke: async () => { throw new Error('process interrupted'); } });
  await activate({ ...fixture, receiptId: r.id, targets: [interrupted], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  const path = installedPath(fixture.targetRoot); await writeFile(path, 'third party after crash\n');
  const recovered = await activate({ ...fixture, receiptId: r.id, targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo)], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(recovered.status, 'pending'); assert.equal(await readFile(path, 'utf8'), 'third party after crash\n');
  assert.equal((await loadState(fixture.stateDir)).applications[0].entries[0].reason, 'target_changed');
}));

test('preserves third-party bytes written during smoke', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r); const path = installedPath(fixture.targetRoot);
  const item = target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { smoke: async () => { await writeFile(path, 'third party during smoke\n'); return { passed: true, evidenceRef: 'fixture-smoke' }; } });
  const result = await activate({ ...fixture, receiptId: r.id, targets: [item], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(result.status, 'pending'); assert.equal(await readFile(path, 'utf8'), 'third party during smoke\n');
  assert.equal((await loadState(fixture.stateDir)).applications[0].entries[0].reason, 'target_changed');
}));

test('tracks and rolls back two files on the same host independently', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r);
  const targets = [
    target(fixture.targetRoot, fixture.sourceHash, fixture.repo),
    target(fixture.targetRoot, fixture.referenceHash, fixture.repo, { sourcePath: 'skills/example/reference.md' }),
  ];
  const applied = await activate({ ...fixture, receiptId: r.id, targets, probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(applied.hostStates.codex.entries.length, 2);
  const rolledBack = await rollback({ ...fixture, receiptId: r.id, targets, probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(rolledBack.status, 'rolled_back');
  await assert.rejects(readFile(installedPath(fixture.targetRoot)), { code: 'ENOENT' });
  await assert.rejects(readFile(installedPath(fixture.targetRoot, 'skills/example/reference.md')), { code: 'ENOENT' });
}));

test('rejects rollback through a different path and recovers a rollback interrupted after restore', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r); let interruptRollback = true;
  const item = target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { smoke: async ({ rollback: restoring }) => { if (restoring && interruptRollback) throw new Error('process interrupted'); return { passed: true, evidenceRef: 'fixture-smoke' }; } });
  await activate({ ...fixture, receiptId: r.id, targets: [item], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  const wrongPath = target(fixture.targetRoot, fixture.referenceHash, fixture.repo, { sourcePath: 'skills/example/reference.md' });
  const mismatch = await rollback({ ...fixture, receiptId: r.id, targets: [wrongPath], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(mismatch.status, 'pending'); assert.equal(await readFile(installedPath(fixture.targetRoot), 'utf8'), 'version two\n');

  const recoveredTarget = target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { smoke: async ({ rollback: restoring }) => { if (restoring && interruptRollback) throw new Error('process interrupted'); return { passed: true, evidenceRef: 'fixture-smoke' }; } });
  const firstRollback = await rollback({ ...fixture, receiptId: r.id, targets: [recoveredTarget], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(firstRollback.status, 'pending'); await assert.rejects(readFile(installedPath(fixture.targetRoot)), { code: 'ENOENT' });
  const busy = await rollback({ ...fixture, receiptId: r.id, targets: [recoveredTarget], probeIdle: async () => ({ idle: false, reason: 'session-active' }) });
  assert.equal(busy.status, 'pending');
  assert.equal((await loadState(fixture.stateDir)).applications[0].entries[0].phase, 'rollback_prepared');
  interruptRollback = false;
  const resumed = await rollback({ ...fixture, receiptId: r.id, targets: [recoveredTarget], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(resumed.status, 'rolled_back');
}));

test('retries a pending host without losing an already applied host', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r); let claudeIdle = false;
  const codex = target(fixture.targetRoot, fixture.sourceHash, fixture.repo);
  const claude = target(fixture.targetRoot, fixture.referenceHash, fixture.repo, { host: 'claude', sourcePath: 'skills/example/reference.md' });
  const first = await activate({ ...fixture, receiptId: r.id, targets: [codex, claude], probeIdle: async (host) => ({ idle: host === 'codex' || claudeIdle, reason: 'reload-documented' }) });
  assert.equal(first.status, 'local_applied'); assert.equal(first.hostStates.claude.status, 'pending');
  claudeIdle = true;
  const retried = await activate({ ...fixture, receiptId: r.id, targets: [codex, claude], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(retried.status, 'local_applied'); assert.equal(retried.hostStates.codex.status, 'local_applied'); assert.equal(retried.hostStates.claude.status, 'local_applied');
}));

test('does not supersede the predecessor until the replacement passes smoke', async () => withRepo(async (fixture) => {
  const firstReceipt = await receipt(fixture); assert.ok(firstReceipt);
  await mkdir(join(fixture.targetRoot, 'skills', 'example'), { recursive: true }); await writeFile(installedPath(fixture.targetRoot), 'version one\n');
  const firstTarget = target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { expectedHash: sha('version one\n') });
  await activate({ ...fixture, receiptId: firstReceipt.id, targets: [firstTarget], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });

  await writeFile(join(fixture.repo, 'skills', 'example', 'SKILL.md'), 'version three\n'); git(fixture.repo, ['add', '.']); git(fixture.repo, ['commit', '-m', 'replacement']);
  await recordCandidates(fixture.stateDir, [candidate('candidate-2')]);
  const second = await stageCandidate({ stateDir: fixture.stateDir, candidateId: 'candidate-2', worktree: fixture.repo, baseRef: fixture.baseRef, files: ['skills/example/SKILL.md', 'skills/example/reference.md'] });
  const secondReceipt = await receipt({ ...fixture, candidate: second.candidate, commit: git(fixture.repo, ['rev-parse', 'HEAD']) }); assert.ok(secondReceipt);
  const replacement = target(fixture.targetRoot, sha('version three\n'), fixture.repo, { expectedHash: fixture.sourceHash, smoke: async () => ({ passed: false, evidenceRef: 'fixture-smoke' }) });
  const failed = await activate({ ...fixture, candidate: second.candidate, receiptId: secondReceipt.id, targets: [replacement], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(failed.status, 'pending');
  assert.equal((await loadState(fixture.stateDir)).applications[0].entries[0].phase, 'local_applied');

  const applied = await activate({ ...fixture, candidate: second.candidate, receiptId: secondReceipt.id, targets: [target(fixture.targetRoot, sha('version three\n'), fixture.repo, { expectedHash: fixture.sourceHash })], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(applied.status, 'local_applied');
  const state = await loadState(fixture.stateDir);
  const predecessorApplication = state.applications.find(({ candidateId }) => candidateId === 'candidate-1');
  assert.equal(predecessorApplication.entries[0].phase, 'superseded');
  const replacementApplication = state.applications.find(({ candidateId }) => candidateId === 'candidate-2');
  assert.equal(replacementApplication.entries[0].phase, 'local_applied');
  assert.equal(Buffer.from(predecessorApplication.entries[0].backup, 'base64').toString('utf8'), 'version one\n');
  assert.equal(Buffer.from(replacementApplication.entries[0].backup, 'base64').toString('utf8'), 'version two\n');
  assert.equal(state.manifests.find(({ candidateId }) => candidateId === 'candidate-1').active, false);
  const activeManifest = state.manifests.find(({ candidateId }) => candidateId === 'candidate-2');
  assert.equal(activeManifest.active, true);

  const predecessorBackup = predecessorApplication.entries[0].backup; const replacementBackup = replacementApplication.entries[0].backup;
  const after = (value, days, milliseconds = 0) => new Date(Date.parse(value) + days * 24 * 60 * 60 * 1000 + milliseconds).toISOString();
  assert.equal((await pruneState(fixture.stateDir, after(predecessorApplication.entries[0].deactivatedAt, 90))).removedEvidence, 0);
  assert.equal((await loadState(fixture.stateDir)).applications.find(({ candidateId }) => candidateId === 'candidate-1').entries[0].backup, predecessorBackup);
  assert.equal((await pruneState(fixture.stateDir, after(predecessorApplication.entries[0].deactivatedAt, 90, 1))).removedEvidence, 1);
  assert.equal((await loadState(fixture.stateDir)).applications.find(({ candidateId }) => candidateId === 'candidate-1').entries[0].backup, null);

  assert.equal((await pruneState(fixture.stateDir, after(replacementApplication.entries[0].backupCreatedAt, 180))).removedEvidence, 0);
  const expired = await pruneState(fixture.stateDir, after(replacementApplication.entries[0].backupCreatedAt, 180, 1));
  assert.equal(expired.removedEvidence, 1); assert.deepEqual(expired.preservedManifests, [activeManifest.id]);
  const pruned = await loadState(fixture.stateDir); assert.equal(pruned.applications.find(({ candidateId }) => candidateId === 'candidate-2').entries[0].backup, null);
  assert.equal((await readFile(join(fixture.stateDir, 'journal.jsonl'), 'utf8')).includes(replacementBackup), false);
  const rollbackAfterExpiry = await rollback({ ...fixture, candidate: second.candidate, receiptId: secondReceipt.id, targets: [target(fixture.targetRoot, sha('version three\n'), fixture.repo, { expectedHash: fixture.sourceHash })], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(rollbackAfterExpiry.status, 'pending'); assert.equal(await readFile(installedPath(fixture.targetRoot), 'utf8'), 'version three\n');
}));

test('preserves a stale target and requires a new candidate instead of accepting a changed baseline', async () => withRepo(async (fixture) => {
  const r = await receipt(fixture); assert.ok(r); const path = join(fixture.targetRoot, 'skills', 'example', 'SKILL.md'); await mkdir(join(fixture.targetRoot, 'skills', 'example'), { recursive: true }); await writeFile(path, 'third party\n');
  const stale = await activate({ ...fixture, receiptId: r.id, targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { expectedHash: sha('expected baseline\n') })], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(stale.status, 'pending'); assert.equal(await readFile(path, 'utf8'), 'third party\n');
  const retriedWithChangedClaim = await activate({ ...fixture, receiptId: r.id, targets: [target(fixture.targetRoot, fixture.sourceHash, fixture.repo, { expectedHash: sha('third party\n') })], probeIdle: async () => ({ idle: true, reason: 'reload-documented' }) });
  assert.equal(retriedWithChangedClaim.status, 'pending'); assert.equal(await readFile(path, 'utf8'), 'third party\n');
}));

test('does not issue a receipt when validation changes the checked out tree', async () => withRepo(async (fixture) => {
  await writeFile(validationMarker(fixture.repo, 'mutate-tree'), '1');
  try {
    assert.equal(await receipt(fixture), null);
    assert.equal((await loadState(fixture.stateDir)).candidates[0].status, 'pending');
  } finally {
    await rm(validationMarker(fixture.repo, 'mutate-tree'), { force: true });
  }
}));

test('does not treat an invented review string as evidence', async () => withRepo(async (fixture) => {
  const value = await recordValidation({ stateDir: fixture.stateDir, candidateId: fixture.candidate.id, worktree: fixture.repo, validationProfile: 'engine-skill', reviewEvidenceRef: `review:${fixture.commit}:invented` });
  assert.equal(value, null);
}));

test('does not issue a receipt when review evidence changes during validation', async () => withRepo(async (fixture) => {
  const reviewEvidenceRef = 'review-changing'; const directory = join(fixture.stateDir, 'review-evidence'); const path = join(directory, `${reviewEvidenceRef}.json`); await mkdir(directory, { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, id: reviewEvidenceRef, candidateId: fixture.candidate.id, commit: fixture.commit, diffHash: fixture.candidate.diffHash, scope: 'slice-review', verdict: 'approve' }));
  await writeFile(validationMarker(fixture.repo, 'mutate-review'), path);
  try {
    assert.equal(await recordValidation({ stateDir: fixture.stateDir, candidateId: fixture.candidate.id, worktree: fixture.repo, validationProfile: 'engine-skill', reviewEvidenceRef }), null);
    assert.equal((await loadState(fixture.stateDir)).candidates[0].status, 'pending');
  } finally {
    await rm(validationMarker(fixture.repo, 'mutate-review'), { force: true });
  }
}));

test('validation strips unrelated parent environment variables', async () => withRepo(async (fixture) => {
  process.env.SETUP_LEARNING_PRIVATE_SENTINEL = 'synthetic-private-value';
  try { assert.ok(await receipt(fixture)); } finally { delete process.env.SETUP_LEARNING_PRIVATE_SENTINEL; }
}));
