import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createNativeWorkerDependencies, runWorker } from '../worker.mjs';
import { proposeCandidates } from '../learning.mjs';
import { createNativeActivationController, createNativeInventoryController, runCli } from '../cli.mjs';
import { appendEvent, loadState, recordCandidates, recordManifest, recordTransition, recordValidationReceipt } from '../state.mjs';

const execFile = promisify(execFileCallback);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const start = '2027-04-23T17:00:00.000Z';
const deadline = '2027-04-23T17:20:00.000Z';
const capabilities = { scheduler: 'available', gmail: 'pending', claudeCli: 'available', grok: 'pending' };

function event(id, session, extra = {}) {
  return { version: 1, id, host: 'codex', session, originEventId: `origin-${id}`, occurredAt: start, scope: { kind: 'repo', repo: 'repo-a' }, locator: `codex://fixture#b${id.slice(1)}`, kind: 'request', provenance: 'verified', ...extra };
}

function dependencies({ active = false, candidates = [] } = {}) {
  return {
    roots: () => [],
    scanHistory: async () => ({ events: [], buffers: [], nextCursors: {}, pending: [], lastVisited: null, historyBacklog: false }),
    readSnippet: async () => 'pedido sanitizado',
    analyzeBatch: async ({ events }) => ({ suggestions: events.map((item) => ({ patternKey: 'prefer-small-diffs', summary: 'Prefira mudanças pequenas.', scope: item.scope, supportEventIds: [item.id], correctionEventIds: [], contradicts: [], artifactKind: 'skill', diagnosis: 'instrução ambígua' })), processedIds: events.map(({ id }) => id), nonprocessedIds: [] }),
    catalog: async () => [],
    proposeCandidates: () => candidates,
    isIdle: async () => !active,
    handoff: async (candidate) => ({ candidateId: candidate.id, status: 'prepared', evidenceRef: `delivery:${candidate.id}` }),
  };
}

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'setup-learning-worker-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('interrompe antes de qualquer efeito quando o orçamento acabou', async () => withDir(async (stateDir) => {
  const result = await runWorker({ stateDir, now: () => deadline, deadline, capabilities, dependencies: dependencies() });
  assert.equal(result.reason, 'budget');
}));

test('intercala hosts e retoma após o último locator visitado', async () => withDir(async (stateDir) => {
  const roots = [
    { host: 'codex', path: 'codex-b', locator: 'codex://history/b' },
    { host: 'codex', path: 'codex-a', locator: 'codex://history/a' },
    { host: 'claude', path: 'claude-b', locator: 'claude://history/b' },
    { host: 'claude', path: 'claude-a', locator: 'claude://history/a' },
  ];
  const orders = []; const deps = dependencies(); deps.roots = () => roots;
  deps.scanHistory = async (input) => {
    orders.push({ locators: input.roots.map(({ locator }) => locator), budget: input.budget });
    return { events: [], buffers: [], nextCursors: {}, pending: [], lastVisited: input.roots[1].locator, historyBacklog: true };
  };
  const first = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  const second = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.deepEqual(orders[0].locators, ['codex://history/a', 'claude://history/a', 'codex://history/b', 'claude://history/b']);
  assert.deepEqual(orders[1].locators, ['codex://history/b', 'claude://history/b', 'codex://history/a', 'claude://history/a']);
  assert.deepEqual(orders[0].budget, { bytes: 8 * 1024 * 1024, lines: 10_000 });
  assert.equal(first.status, 'pending'); assert.ok(first.pendingReasons.includes('history_backlog'));
  assert.equal(second.status, 'pending'); assert.equal((await loadState(stateDir)).worker.historyAfter, 'claude://history/b');
}));

test('conclui somente quando todas as fontes chegaram ao EOF', async () => withDir(async (stateDir) => {
  const deps = dependencies(); deps.roots = () => [{ host: 'codex', path: 'codex-a', locator: 'codex://history/a' }];
  deps.scanHistory = async ({ roots }) => ({ events: [], buffers: [], nextCursors: {}, pending: [], lastVisited: roots[0].locator, historyBacklog: false });
  const result = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(result.status, 'complete'); assert.equal(result.reason, null); assert.deepEqual(result.pendingReasons, []);
  assert.equal((await loadState(stateDir)).worker.historyAfter, 'codex://history/a');
}));

test('CLI worker constrói dependências nativas sem injeção de funções', async () => withDir(async (stateDir) => {
  let stdout = ''; let stderr = '';
  const code = await runCli(['worker', '--state-dir', stateDir, '--deadline', start, '--mode', 'manual'], { now: () => start, writeOut: (value) => { stdout += value; }, writeErr: (value) => { stderr += value; } });
  assert.equal(code, 0); assert.equal(JSON.parse(stdout).reason, 'budget'); assert.equal(stderr, '');
}));

test('fluxo nativo deriva escopo de cwd verificado sem confiar no scope do modelo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-learning-native-e2e-'));
  try {
    const runCase = async (name, cwds, expectedScope, expectedCandidate = true) => {
      const home = join(root, `home-${name}`); const stateDir = join(root, `state-${name}`); const sessions = join(home, '.codex', 'sessions'); await mkdir(sessions, { recursive: true });
      for (let index = 0; index < cwds.length; index += 1) {
        const header = { type: 'session_meta', payload: { id: `session-${name}-${index}`, source: 'cli', cwd: cwds[index] }, timestamp: `2027-04-23T17:00:0${index}.000Z` };
        const message = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Pedido humano ${index}.` }] }, timestamp: `2027-04-23T17:00:1${index}.000Z` };
        await writeFile(join(sessions, `${index}.jsonl`), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
      }
      const runner = async ({ eventIds }) => [{ patternKey: `native-${name}`, summary: 'Padronize pedidos humanos recorrentes.', scope: { kind: 'repo', repo: 'invented-by-model' }, supportEventIds: eventIds, correctionEventIds: [], contradicts: [], artifactKind: 'skill', diagnosis: 'instrução ambígua' }];
      const deps = createNativeWorkerDependencies({ home, runner }); deps.isIdle = async () => true; deps.handoff = async (candidate) => ({ candidateId: candidate.id, status: 'prepared', evidenceRef: `delivery:${name}` });
      const result = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' }); const state = await loadState(stateDir);
      assert.equal(Boolean(result.candidateId), expectedCandidate); assert.equal(state.events.length, 3);
      if (expectedCandidate) { if (expectedScope) assert.deepEqual(state.candidates[0].scope, expectedScope); assert.equal(state.worker.handoff.status, 'handed_off'); }
      else { assert.equal(state.candidates.length, 0); assert.equal(state.events.every(({ provenance }) => provenance === 'uncertain'), true); }
    };
    const repos = [];
    for (let index = 0; index < 3; index += 1) { const repo = join(root, `repo-${index}`); await mkdir(repo); await execFile('git', ['init'], { cwd: repo }); repos.push(repo); }
    await runCase('project', [repos[0], repos[0], repos[0]], undefined);
    const projectState = await loadState(join(root, 'state-project')); assert.equal(projectState.candidates[0].scope.kind, 'repo');
    await runCase('transversal', repos, { kind: 'global' });
    const globalHome = join(root, 'home-global'); await mkdir(globalHome, { recursive: true });
    const globalSessions = join(globalHome, '.codex', 'sessions'); await mkdir(globalSessions, { recursive: true });
    for (let index = 0; index < 3; index += 1) await writeFile(join(globalSessions, `${index}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: `session-global-${index}`, source: 'cli', cwd: globalHome }, timestamp: `2027-04-23T17:00:0${index}.000Z` })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Pedido global ${index}.` }] }, timestamp: `2027-04-23T17:00:1${index}.000Z` })}\n`);
    const globalRunner = async ({ eventIds }) => [{ patternKey: 'native-global', summary: 'Padronize pedidos globais recorrentes.', scope: { kind: 'repo', repo: 'invented-by-model' }, supportEventIds: eventIds, correctionEventIds: [], contradicts: [], artifactKind: 'skill', diagnosis: 'instrução ambígua' }];
    const globalDeps = createNativeWorkerDependencies({ home: globalHome, runner: globalRunner }); globalDeps.isIdle = async () => true; globalDeps.handoff = async (candidate) => ({ candidateId: candidate.id, status: 'prepared', evidenceRef: 'delivery:global' });
    const globalResult = await runWorker({ stateDir: join(root, 'state-global'), now: () => start, deadline, capabilities, dependencies: globalDeps, mode: 'manual' }); assert.ok(globalResult.candidateId); assert.deepEqual((await loadState(join(root, 'state-global'))).candidates[0].scope, { kind: 'global' });
    await runCase('unknown', [join(root, 'missing'), join(root, 'missing'), join(root, 'missing')], null, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exige scheduler no ciclo agendado mas permite backfill manual sem ficção de capability', async () => withDir(async (stateDir) => {
  const unavailable = { ...capabilities, scheduler: 'pending' };
  const scheduled = await runWorker({ stateDir, now: () => start, deadline, capabilities: unavailable, dependencies: dependencies() });
  assert.equal(scheduled.reason, 'scheduler');
  const manual = await runWorker({ stateDir, now: () => start, deadline, capabilities: unavailable, mode: 'manual', dependencies: dependencies() });
  assert.notEqual(manual.reason, 'scheduler');
  assert.equal(manual.capabilities.scheduler, 'pending');
}));

test('CLI agendada usa somente capability observada e persistida pelo controlador', async () => withDir(async (stateDir) => {
  let stdout = ''; const io = { now: () => start, workerDependencies: dependencies(), writeOut: (value) => { stdout += value; }, writeErr: () => {} };
  await runCli(['worker', '--state-dir', stateDir, '--deadline', deadline], io);
  assert.equal(JSON.parse(stdout).reason, 'scheduler'); stdout = '';
  const evidence = { capability: 'scheduler', status: 'available', evidenceRef: 'automation:observed-1', observedAt: start };
  await runCli(['record-capability', '--state-dir', stateDir, '--result', JSON.stringify(evidence)], io); stdout = '';
  await runCli(['worker', '--state-dir', stateDir, '--deadline', deadline], io);
  const observed = JSON.parse(stdout); assert.notEqual(observed.reason, 'scheduler'); assert.equal(observed.capabilities.scheduler, 'available');
}));

test('controlador registra inventário skills/list somente em memória antes do worker', async () => withDir(async (stateDir) => {
  const observed = { evidenceRef: 'skills-list:observed-1', skills: [{ path: '.agents/skills/demo/SKILL.md', hash: 'a'.repeat(64), disabled: true }] };
  const inventoryController = createNativeInventoryController({ observeSkills: async () => observed }); let stdout = '';
  await runCli(['worker', '--state-dir', stateDir, '--mode', 'manual', '--deadline', deadline], { now: () => start, inventoryController, workerDependencies: dependencies(), writeOut: (value) => { stdout += value; }, writeErr: () => {} });
  assert.ok(JSON.parse(stdout)); assert.deepEqual((await loadState(stateDir)).skillInventory, { source: 'skills/list', observedAt: start, ...observed });
}));

test('preserva o candidato quando sessão ativa impede apenas o handoff', async () => withDir(async (stateDir) => {
  const candidate = { id: 'c1', patternKey: 'prefer-small-diffs', scope: { kind: 'repo', repo: 'repo-a' }, artifactKind: 'skill', status: 'candidate', sourceEventIds: ['e1', 'e2', 'e3'], baselineHash: null, diffHash: null, policyVersion: '1', version: 0 };
  const result = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: dependencies({ active: true, candidates: [candidate] }) });
  assert.equal(result.reason, 'active-session');
  assert.equal(result.candidateId, 'c1');
}));

test('limita o handoff ao primeiro candidato elegível por prioridade', async () => withDir(async (stateDir) => {
  const candidate = (id) => ({ id, patternKey: `pattern-${id}`, scope: { kind: 'repo', repo: 'repo-a' }, artifactKind: 'skill', status: 'candidate', sourceEventIds: ['e1', 'e2', 'e3'], baselineHash: null, diffHash: null, policyVersion: '1', version: 0 });
  const result = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: dependencies({ candidates: [candidate('c1'), candidate('c2')] }) });
  assert.equal(result.candidateId, 'c1');
  assert.deepEqual(result.handoff, { candidateId: 'c1', status: 'prepared', evidenceRef: 'delivery:c1' });
}));

test('recupera backlog de três sessões em ciclos separados sem persistir o snippet', async () => withDir(async (stateDir) => {
  let cycle = 0;
  const seenContexts = [];
  const deps = dependencies();
  deps.analyzeBatch = async ({ events, knownPatterns }) => {
    seenContexts.push(knownPatterns);
    return { suggestions: events.map((item) => ({ patternKey: 'prefer-small-diffs', summary: 'Prefira mudanças pequenas.', scope: item.scope, supportEventIds: [item.id], correctionEventIds: [], contradicts: [], artifactKind: 'skill', diagnosis: 'instrução ambígua' })), processedIds: events.map(({ id }) => id), nonprocessedIds: [] };
  };
  deps.proposeCandidates = proposeCandidates;
  for (const session of ['s1', 's2', 's3']) {
    cycle += 1; await appendEvent(stateDir, event(`e${cycle}`, session));
    await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  }
  const state = await loadState(stateDir);
  assert.deepEqual(state.worker.analyzedEventIds, ['e1', 'e2', 'e3']);
  assert.equal(state.patterns.length, 1);
  assert.deepEqual(state.patterns[0].supportEventIds, ['e1', 'e2', 'e3']);
  assert.equal(state.worker.handoff.status, 'handed_off');
  assert.ok(seenContexts[2].some(({ patternKey }) => patternKey === 'prefer-small-diffs'));
  assert.doesNotMatch(JSON.stringify(state), /pedido sanitizado/);
}));

test('rejeita relógio e deadline inválidos e limita o analyzer ao orçamento restante', async () => withDir(async (stateDir) => {
  await assert.rejects(runWorker({ stateDir, now: () => 'inválido', deadline, capabilities, dependencies: dependencies(), mode: 'manual' }), /ISO UTC/);
  await assert.rejects(runWorker({ stateDir, now: () => start, deadline: 'inválido', capabilities, dependencies: dependencies(), mode: 'manual' }), /ISO UTC/);
  await appendEvent(stateDir, event('e1', 's1'));
  let timeoutMs;
  const deps = dependencies();
  deps.analyzeBatch = async (input) => { timeoutMs = input.timeoutMs; return { suggestions: [], processedIds: ['e1'], nonprocessedIds: [] }; };
  let calls = 0;
  const now = () => (++calls < 4 ? start : '2027-04-23T17:19:30.000Z');
  await runWorker({ stateDir, now, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(timeoutMs, 30_000);
}));

test('mantém lote incompleto pendente e recuperável', async () => withDir(async (stateDir) => {
  await appendEvent(stateDir, event('e1', 's1')); await appendEvent(stateDir, event('e2', 's2'));
  const deps = dependencies();
  deps.analyzeBatch = async () => ({ suggestions: [{ patternKey: 'prefer-small-diffs', summary: 'Prefira mudanças pequenas.', scope: { kind: 'repo', repo: 'repo-a' }, supportEventIds: ['e1'], correctionEventIds: [], contradicts: [], artifactKind: 'skill', diagnosis: 'instrução ambígua' }], processedIds: ['e1'], nonprocessedIds: ['e2'] });
  const result = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(result.status, 'pending'); assert.equal(result.reason, 'partial'); assert.ok(result.pendingReasons.includes('analysis_pending'));
  assert.deepEqual((await loadState(stateDir)).worker.analyzedEventIds, ['e1']);
}));

test('importação pendente não bloqueia candidato com evidência já completa', async () => withDir(async (stateDir) => {
  let proposed = false; const candidate = { id: 'c1', patternKey: 'prefer-small-diffs', scope: { kind: 'repo', repo: 'repo-a' }, artifactKind: 'skill', status: 'candidate', sourceEventIds: ['e1', 'e2', 'e3'], baselineHash: null, diffHash: null, policyVersion: '1', version: 0 }; const deps = dependencies();
  deps.scanHistory = async () => ({ events: [], buffers: [], nextCursors: {}, pending: [{ locator: 'codex://fixture#b0', reason: 'invalid_utf8' }] });
  deps.proposeCandidates = () => { proposed = true; return [candidate]; };
  const result = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(result.reason, 'partial'); assert.equal(result.candidateId, 'c1'); assert.equal(proposed, true); assert.ok(result.pendingReasons.includes('import_pending'));
}));

test('lote parcial ainda propõe evidência completa sem contar item incerto', async () => withDir(async (stateDir) => {
  for (const [id, session] of [['e1', 's1'], ['e2', 's2'], ['e3', 's3'], ['e4', 's4']]) await appendEvent(stateDir, { ...event(id, session), provenance: id === 'e4' ? 'uncertain' : 'verified' });
  const deps = dependencies(); deps.proposeCandidates = proposeCandidates;
  deps.analyzeBatch = async () => ({ suggestions: [{ patternKey: 'prefer-small-diffs', summary: 'Prefira mudanças pequenas.', scope: { kind: 'repo', repo: 'repo-a' }, supportEventIds: ['e1', 'e2', 'e3'], correctionEventIds: [], contradicts: [], artifactKind: 'skill', diagnosis: 'instrução ambígua' }], processedIds: ['e1', 'e2', 'e3'], nonprocessedIds: ['e4'] });
  const result = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(result.reason, 'partial'); assert.ok(result.candidateId); assert.deepEqual((await loadState(stateDir)).candidates[0].sourceEventIds, ['e1', 'e2', 'e3']);
}));

test('persiste um pending por ciclo sem bloquear o próximo candidato', async () => withDir(async (stateDir) => {
  const candidate = (id, status) => ({ id, patternKey: `pattern-${id}`, scope: { kind: 'repo', repo: 'repo-a' }, artifactKind: 'skill', status, sourceEventIds: ['e1'], baselineHash: null, diffHash: null, policyVersion: '1', version: 0 });
  const deps = dependencies({ candidates: [candidate('c1', 'pending'), candidate('c2', 'candidate')] });
  const first = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(first.candidateId, 'c1'); assert.equal(first.reason, 'candidate_pending'); assert.deepEqual((await loadState(stateDir)).candidates.map(({ id }) => id), ['c1']);
  const second = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(second.candidateId, 'c2'); assert.deepEqual((await loadState(stateDir)).candidates.map(({ id }) => id), ['c1', 'c2']);
}));

test('retoma o handoff persistido sem executar uma segunda entrega', async () => withDir(async (stateDir) => {
  const candidate = { id: 'c1', patternKey: 'prefer-small-diffs', scope: { kind: 'repo', repo: 'repo-a' }, artifactKind: 'skill', status: 'candidate', sourceEventIds: ['e1'], baselineHash: null, diffHash: null, policyVersion: '1', version: 0 };
  const deps = dependencies({ candidates: [candidate] }); let handoffs = 0;
  deps.handoff = async (value) => { handoffs += 1; return { candidateId: value.id, status: 'prepared', evidenceRef: 'delivery:c1' }; };
  await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  const resumed = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(resumed.reason, 'handoff_in_progress'); assert.equal(resumed.handoff.status, 'handed_off'); assert.equal(handoffs, 1);
}));

test('libera handoff terminal e permite exatamente o próximo padrão', async () => withDir(async (stateDir) => {
  const candidate = (id, patternKey) => ({ id, patternKey, scope: { kind: 'repo', repo: 'repo-a' }, artifactKind: 'skill', status: 'candidate', sourceEventIds: ['e1', 'e2', 'e3'], baselineHash: null, diffHash: null, policyVersion: '1', version: 0 });
  const first = candidate('c1', 'pattern-one'); const reopened = candidate('c3', 'pattern-one'); const second = candidate('c2', 'pattern-two'); const deps = dependencies({ candidates: [first] });
  await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  await recordTransition(stateDir, { candidateId: 'c1', expectedVersion: 0, event: { previousStatus: 'candidate', status: 'rejected', at: start, reason: 'review_rejected' } });
  deps.proposeCandidates = () => [reopened, second];
  const next = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  const state = await loadState(stateDir);
  assert.equal(next.candidateId, 'c2'); assert.equal(state.worker.handoff.candidateId, 'c2'); assert.deepEqual(state.candidates.map(({ id }) => id), ['c1', 'c2']);
}));

test('controlador conclui o handoff preparado com prova durável', async () => withDir(async (stateDir) => {
  const candidate = { id: 'c1', patternKey: 'prefer-small-diffs', scope: { kind: 'repo', repo: 'repo-a' }, artifactKind: 'skill', status: 'candidate', sourceEventIds: ['e1'], baselineHash: null, diffHash: null, policyVersion: '1', version: 0 };
  const deps = dependencies({ candidates: [candidate] }); deps.isIdle = async () => null;
  const prepared = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(prepared.reason, 'controller'); assert.equal((await loadState(stateDir)).worker.handoff.evidenceRef, null);
  let stdout = '';
  await runCli(['finish-handoff', '--state-dir', stateDir, '--result', JSON.stringify({ candidateId: 'c1', evidenceRef: 'linear:LEO-999' })], { writeOut: (value) => { stdout += value; } });
  assert.equal(JSON.parse(stdout).handoff.status, 'handed_off'); assert.equal((await loadState(stateDir)).worker.handoff.evidenceRef, 'linear:LEO-999');
}));

test('controlador nativo monta targets fixos e executa activate e rollback reais', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-learning-activation-')); const repo = join(root, 'repo'); const home = join(root, 'home'); const stateDir = join(root, 'state');
  try {
    const sourcePath = join(repo, 'skills', 'demo', 'SKILL.md'); const targetPath = join(home, '.agents', 'skills', 'demo', 'SKILL.md'); const before = Buffer.from('old\n'); const after = Buffer.from('new\n');
    await mkdir(join(sourcePath, '..'), { recursive: true }); await mkdir(join(targetPath, '..'), { recursive: true }); await writeFile(sourcePath, after); await writeFile(targetPath, before);
    await execFile('git', ['init'], { cwd: repo }); await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo }); await execFile('git', ['config', 'user.name', 'Test'], { cwd: repo }); await execFile('git', ['config', 'core.autocrlf', 'false'], { cwd: repo }); await execFile('git', ['add', '.'], { cwd: repo }); await execFile('git', ['commit', '-m', 'fixture'], { cwd: repo });
    const commit = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim(); const baselineHash = sha256('baseline'); const diffHash = sha256('diff'); const sourceHash = sha256(after); const beforeHash = sha256(before);
    const candidate = { id: 'c1', patternKey: 'demo-skill', scope: { kind: 'global' }, artifactKind: 'skill', status: 'candidate', sourceEventIds: ['e1'], baselineHash, diffHash, policyVersion: '1', version: 0 };
    await recordCandidates(stateDir, [candidate]);
    await recordManifest(stateDir, { id: 'm1', candidateId: 'c1', active: false, createdAt: start, manifest: { files: [{ relativePath: 'skills/demo/SKILL.md', sourceHash, beforeHash, afterHash: sourceHash }], baseRef: commit, baselineHash, diffHash, commit } });
    await recordValidationReceipt(stateDir, { id: 'r1', candidateId: 'c1', commit, diffHash, baselineHash, policyVersion: '1', commands: [{ id: 'fixture', exitCode: 0 }], treeHash: sha256('tree'), lockfileHash: null, runtime: { node: process.version }, reviewEvidenceRef: `review-evidence:fixture:${sha256('review')}`, completedAt: start });
    const smoke = async () => ({ passed: true, evidenceRef: 'smoke:observed' }); const controller = createNativeActivationController({ home, sourceWorktree: repo, smokes: { codex: smoke, claude: smoke, cursor: smoke }, probeIdle: async () => ({ idle: true, reason: 'host-idle' }) });
    let stdout = ''; const io = { activationController: controller, writeOut: (value) => { stdout += value; }, writeErr: () => {} };
    await runCli(['activate', '--state-dir', stateDir, '--candidate', 'c1', '--receipt', 'r1'], io); assert.equal(JSON.parse(stdout).status, 'local_applied'); assert.equal(await readFile(targetPath, 'utf8'), 'new\n'); stdout = '';
    const same = { ...candidate, status: 'candidate', baselineHash: null, diffHash: null };
    const withoutNovelty = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: dependencies({ candidates: [same] }), mode: 'manual' });
    assert.equal(withoutNovelty.candidateId, null); assert.equal((await loadState(stateDir)).candidates.length, 1);
    for (const value of [event('e2', 's2'), event('e3', 's3'), event('e4', 's4', { kind: 'correction' })]) await appendEvent(stateDir, value);
    const updateDeps = dependencies({ active: true }); updateDeps.proposeCandidates = proposeCandidates;
    updateDeps.catalog = async () => [{ path: '.agents/skills/demo/SKILL.md', kind: 'skill', scope: { kind: 'repo', repo: 'repo-a' }, hash: sourceHash, enabled: true, summary: 'Prefira mudanças pequenas na skill demo.' }];
    updateDeps.analyzeBatch = async () => ({ suggestions: [{ patternKey: 'demo-skill', summary: 'Prefira mudanças pequenas na skill demo.', scope: { kind: 'repo', repo: 'repo-a' }, supportEventIds: ['e2', 'e3', 'e4'], correctionEventIds: ['e4'], contradicts: [], artifactKind: 'skill', diagnosis: 'instrução ambígua' }], processedIds: ['e2', 'e3', 'e4'], nonprocessedIds: [] });
    const update = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: updateDeps, mode: 'manual' }); const updatedState = await loadState(stateDir);
    assert.notEqual(update.candidateId, 'c1'); assert.equal(updatedState.candidates.length, 2); assert.equal(updatedState.candidates[0].status, 'local_applied');
    await runCli(['rollback', '--state-dir', stateDir, '--candidate', 'c1', '--receipt', 'r1'], io); assert.equal(JSON.parse(stdout).status, 'rolled_back'); assert.equal(await readFile(targetPath, 'utf8'), 'old\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lease separado impede dois workers sem bloquear o journal curto', async () => withDir(async (stateDir) => {
  await appendEvent(stateDir, event('e1', 's1'));
  let release; let started;
  const analyzing = new Promise((resolve) => { started = resolve; }); const gate = new Promise((resolve) => { release = resolve; });
  const deps = dependencies();
  deps.analyzeBatch = async () => { started(); await gate; return { suggestions: [], processedIds: ['e1'], nonprocessedIds: [] }; };
  const first = runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  await analyzing;
  const second = await runWorker({ stateDir, now: () => start, deadline, capabilities, dependencies: deps, mode: 'manual' });
  assert.equal(second.reason, 'concurrent-worker');
  await appendEvent(stateDir, event('e2', 's2'));
  release(); await first;
  assert.equal((await loadState(stateDir)).events.length, 2);
}));
