import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { validateCandidate } from './contracts.mjs';
import { validateAdvisoryTemplate } from './adapters.mjs';
import { loadState, recordStagedCandidate, recordTransition, recordValidationReceipt, validateDiffManifest, withApplicationIntent } from './state.mjs';

const execFile = promisify(execFileCallback);
const protectedPaths = [
  'home/hooks/', 'home/AGENTS.md',
  'install.ps1', 'install.sh', 'manifest.json', 'mcp.json', 'tools/dotfiles.mjs',
];
const protectedSkills = new Set([
  'academy-acervo', 'automate', 'autopilot', 'consult-claude', 'create-hook', 'create-rule',
  'create-skill', 'create-subagent', 'entrega', 'find-skills', 'git-guardrails', 'goal', 'loop',
  'migrate-to-skills', 'new-repo', 'novo-projeto-chiarelli', 'onboard', 'origin', 'review',
  'review-bugbot', 'review-security', 'sdk', 'setup-engineering-pipeline', 'setup-ia-sanitize',
  'setup-learning', 'share', 'shell', 'split-to-prs', 'stripe-projects', 'sync-dotfiles',
  'to-issues', 'to-prd', 'trail-code', 'triage', 'two-axis-review', 'update-cli-config',
  'update-cursor-settings', 'upgrade-stripe',
]);
const allowedGenerated = /^home\/hooks\/setup-learning-generated\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const preferencesStart = '<!-- setup-learning:preferences:start -->';
const preferencesEnd = '<!-- setup-learning:preferences:end -->';
export const managedPreferences = Object.freeze({
  concise_handoffs: 'Mantenha handoffs concisos e acionáveis.',
  practical_examples: 'Inclua exemplos práticos quando ajudarem a executar a tarefa.',
  explicit_dates: 'Use datas explícitas quando referências relativas puderem causar ambiguidade.',
  scannable_structure: 'Organize comparações e sequências em listas curtas e fáceis de conferir.',
});
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value);

export function renderManagedPreferences(ids, newline = '\n') {
  if (!Array.isArray(ids) || !['\n', '\r\n'].includes(newline) || ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !Object.hasOwn(managedPreferences, id))) throw new TypeError('managed preference ids are invalid');
  const selected = Object.keys(managedPreferences).filter((id) => ids.includes(id));
  if (selected.length !== ids.length || selected.some((id, index) => id !== ids[index])) throw new TypeError('managed preference ids must use catalog order');
  return selected.map((id) => `- [${id}] ${managedPreferences[id]}`).join(newline);
}

function pathKey(value) { return typeof value === 'string' ? value.replace(/\\/g, '/') : ''; }
function reasonForPath(value) {
  const path = pathKey(value);
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').some((part) => part === '..' || part === '')) return 'path outside allowed worktree';
  if (/(^|\/)\.env(?:\.|$)/i.test(path) || path === 'config.toml' || path.endsWith('/config.toml')) return 'runtime configuration is protected';
  if (path === 'mcp.json' || path.endsWith('/mcp.json')) return 'MCP installation is protected and pending-install';
  if (path === 'home/AGENTS.md') return 'AGENTS requires a verified preferences-only diff';
  if (allowedGenerated.test(path)) return null;
  if (protectedPaths.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))) return 'protected path';
  if (path.startsWith('skills/')) {
    const [, skill, file] = path.split('/');
    if (!skill || !file || protectedSkills.has(skill) || /(guard|security|seguran|auth|install|promot)/i.test(skill)) return 'protected skill';
    return null;
  }
  return 'path outside policy allowlist';
}

async function git(worktree, args, allowFailure = false) {
  try { return await execFile('git', args, { cwd: worktree, encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); } catch (error) { if (allowFailure) return { stdout: error.stdout ?? Buffer.alloc(0), stderr: error.stderr ?? Buffer.alloc(0), code: error.code }; throw error; }
}
function preferencesBlock(value) {
  if (typeof value !== 'string') return null;
  const start = value.indexOf(preferencesStart); const endStart = value.indexOf(preferencesEnd, start + preferencesStart.length);
  if (start < 0 || endStart < 0 || value.indexOf(preferencesEnd) !== endStart || value.indexOf(preferencesStart, start + 1) >= 0 || value.indexOf(preferencesEnd, endStart + 1) >= 0) return null;
  const end = endStart + preferencesEnd.length; const block = value.slice(start, end);
  const match = /^<!-- setup-learning:preferences:start -->(\r?\n)([\s\S]+)\1<!-- setup-learning:preferences:end -->$/.exec(block);
  if (!match) return null;
  const ids = match[2].split(match[1]).map((line) => /^- \[([a-z_]+)\] /.exec(line)?.[1]);
  if (ids.some((id) => id === undefined)) return null;
  let rendered; try { rendered = renderManagedPreferences(ids, match[1]); } catch { return null; }
  if (match[2] !== rendered) return null;
  return { prefix: value.slice(0, start), suffix: value.slice(end) };
}
function preferencesOnly(before, after) {
  const prior = before ?? ''; const next = preferencesBlock(after); if (!next) return false;
  const current = preferencesBlock(prior);
  if (current) return next.prefix === current.prefix && next.suffix === current.suffix;
  if (prior.includes(preferencesStart) || prior.includes(preferencesEnd)) return false;
  return next.prefix === prior && (prior.length === 0 || /\r?\n$/.test(prior)) && /^(?:\r?\n)?$/.test(next.suffix);
}
function realDiffSync({ worktree, baseRef, commit }) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseRef, commit], { cwd: worktree, windowsHide: true, stdio: 'ignore' });
    const raw = execFileSync('git', ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', `${baseRef}..${commit}`], { cwd: worktree, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
    if (raw.length % 2 !== 0) return null;
    const files = [];
    for (let index = 0; index < raw.length; index += 2) files.push({ status: raw[index], path: pathKey(raw[index + 1]) });
    const patch = execFileSync('git', ['diff', '--no-ext-diff', '--binary', `${baseRef}..${commit}`], { cwd: worktree, windowsHide: true });
    return { files, patch };
  } catch { return null; }
}
function treeBlobSync(worktree, ref, file) {
  try {
    const line = execFileSync('git', ['ls-tree', '-z', ref, '--', file], { cwd: worktree, encoding: 'utf8', windowsHide: true });
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([^\0]+)\0$/.exec(line);
    if (!match || pathKey(match[4]) !== file) return null;
    return { mode: match[1], type: match[2], object: match[3], content: execFileSync('git', ['cat-file', 'blob', match[3]], { cwd: worktree, windowsHide: true }) };
  } catch { return null; }
}

/** Evaluates only a Git-bound, content-verified diff. */
export function evaluatePolicy({ candidate, diffManifest, policy = {} }) {
  const reasons = [];
  try { validateCandidate(candidate); } catch { return { allowed: false, reasons: ['candidate is invalid'] }; }
  if (candidate.status !== 'candidate') reasons.push('candidate status is not eligible for apply');
  if (candidate.scope.kind === 'repo') reasons.push('project-scoped candidate requires a project-local adapter');
  try { validateDiffManifest(diffManifest); } catch { return { allowed: false, reasons: ['diff manifest is invalid'] }; }
  if (candidate.artifactKind === 'mcp') reasons.push('MCP installation is protected and pending-install');
  if (typeof policy.worktree !== 'string') return { allowed: false, reasons: [...reasons, 'real diff evidence is required'] };
  const actual = realDiffSync({ worktree: policy.worktree, baseRef: diffManifest.baseRef, commit: diffManifest.commit });
  if (!actual) return { allowed: false, reasons: [...reasons, 'real diff evidence is required'] };
  const declared = new Map(diffManifest.files.map((file) => [file.relativePath, file]));
  if (actual.files.length !== declared.size || actual.files.some(({ path }) => !declared.has(path))) reasons.push('real diff differs from manifest');
  const expectedKind = candidate.artifactKind === 'skill' ? 'skills/' : candidate.artifactKind === 'agents' ? 'home/AGENTS.md' : candidate.artifactKind === 'hook' ? 'home/hooks/setup-learning-generated/' : null;
  if (expectedKind && actual.files.some(({ path }) => expectedKind.endsWith('/') ? !path.startsWith(expectedKind) : path !== expectedKind)) reasons.push('candidate artifact kind differs from real diff');
  for (const { status, path } of actual.files) {
    const declaredFile = declared.get(path); const before = treeBlobSync(policy.worktree, diffManifest.baseRef, path); const after = treeBlobSync(policy.worktree, diffManifest.commit, path);
    const reason = reasonForPath(path);
    if (reason && reason !== 'AGENTS requires a verified preferences-only diff') reasons.push(`${path}: ${reason}`);
    if (!['A', 'M'].includes(status) || !after || after.type !== 'blob' || !['100644', '100755'].includes(after.mode)) reasons.push(`${path}: candidate must be an added or modified regular file`);
    if (declaredFile && (!after || hash(after.content) !== declaredFile.afterHash || hash(after.content) !== declaredFile.sourceHash || (before === null ? declaredFile.beforeHash !== null : hash(before.content) !== declaredFile.beforeHash))) reasons.push(`${path}: Git blob hash differs from manifest`);
    if (allowedGenerated.test(path) && after) {
      try { validateAdvisoryTemplate(JSON.parse(after.content.toString('utf8'))); } catch { reasons.push(`${path}: advisory template is invalid`); }
    }
    if (path === 'home/AGENTS.md' && !preferencesOnly(before?.content.toString('utf8') ?? null, after?.content.toString('utf8') ?? null)) reasons.push('AGENTS protected content changed outside preferences block');
  }
  if (hash(actual.patch) !== diffManifest.diffHash) reasons.push('real diff hash differs from manifest');
  const baselineHash = hash(canonical(diffManifest.files.map(({ relativePath, beforeHash }) => ({ relativePath, beforeHash }))));
  if (baselineHash !== diffManifest.baselineHash || candidate.baselineHash !== diffManifest.baselineHash || candidate.diffHash !== diffManifest.diffHash) reasons.push('candidate hashes differ from verified manifest');
  return { allowed: reasons.length === 0, reasons };
}

async function evaluateRealPolicy({ candidate, diffManifest, policy }) {
  return evaluatePolicy({ candidate, diffManifest, policy });
}

async function regularWithin(worktree, file) {
  const root = resolve(worktree); const relativePath = pathKey(file);
  if (!relativePath || relativePath.startsWith('/') || /^[A-Za-z]:\//.test(relativePath)) throw new Error('file violates worktree containment');
  const target = resolve(root, ...relativePath.split('/'));
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('file violates worktree containment');
  let cursor = root;
  for (const part of relativePath.split('/')) {
    const info = await lstat(cursor); if (info.isSymbolicLink()) throw new Error('candidate path cannot traverse a symbolic link or junction');
    cursor = resolve(cursor, part);
  }
  const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new Error('candidate file must be a regular non-symbolic file');
  return { target, relativePath };
}

async function cleanWorktree(worktree) {
  const status = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.stdout.length > 0) throw new Error('candidate worktree is dirty');
}

async function treeBlob(worktree, ref, file) {
  const listed = await git(worktree, ['ls-tree', '-z', ref, '--', file]);
  const match = /^(\d+) (\w+) ([a-f0-9]+)\t([^\0]+)\0$/.exec(listed.stdout.toString('utf8'));
  if (!match || pathKey(match[4]) !== file || match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) throw new Error('candidate commit entry must be a regular file');
  return { mode: match[1], content: (await git(worktree, ['cat-file', 'blob', match[3]])).stdout };
}

export async function stageCandidate({ stateDir, candidateId, worktree, baseRef, files }) {
  if (typeof stateDir !== 'string' || typeof candidateId !== 'string' || typeof worktree !== 'string' || typeof baseRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,255}$/.test(baseRef) || baseRef.includes('..') || !Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length) throw new TypeError('stage input is invalid');
  const state = await loadState(stateDir); const current = state.candidates.find((item) => item.id === candidateId); if (!current) throw new Error('candidate not found'); validateCandidate(current);
  if (current.baselineHash !== null || current.diffHash !== null) throw new Error('candidate already staged');
  await cleanWorktree(worktree);
  const commit = (await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.toString('utf8').trim();
  const baseCommit = (await git(worktree, ['rev-parse', '--verify', `${baseRef}^{commit}`])).stdout.toString('utf8').trim();
  const entries = [];
  for (const value of files) {
    const file = await regularWithin(worktree, value);
    const after = await treeBlob(worktree, commit, file.relativePath); const beforeResult = await git(worktree, ['ls-tree', '-z', baseCommit, '--', file.relativePath]);
    const before = beforeResult.stdout.length === 0 ? null : await treeBlob(worktree, baseCommit, file.relativePath);
    entries.push({ relativePath: file.relativePath, sourceHash: hash(after.content), beforeHash: before === null ? null : hash(before.content), afterHash: hash(after.content) });
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  const actual = realDiffSync({ worktree, baseRef: baseCommit, commit }); if (!actual) throw new Error('base ref is not an ancestor of staged commit');
  const declared = new Set(entries.map((entry) => entry.relativePath)); if (actual.files.length !== declared.size || actual.files.some(({ path, status }) => !declared.has(path) || !['A', 'M'].includes(status))) throw new Error('staged commit contains files outside candidate declaration');
  const baselineHash = hash(canonical(entries.map(({ relativePath, beforeHash }) => ({ relativePath, beforeHash }))));
  const diffHash = hash(actual.patch);
  const manifest = { files: entries, baseRef: baseCommit, baselineHash, diffHash, commit };
  const updated = { ...current, baselineHash, diffHash, version: current.version + 1 };
  validateCandidate(updated);
  const policy = await evaluateRealPolicy({ candidate: updated, diffManifest: manifest, policy: { worktree } });
  const staged = { candidate: policy.allowed ? updated : { ...updated, status: 'pending' }, manifest };
  await cleanWorktree(worktree);
  if ((await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.toString('utf8').trim() !== commit) throw new Error('candidate worktree changed during staging');
  const manifestRecord = { id: `m-${hash(candidateId).slice(0, 40)}`, candidateId, active: false, createdAt: new Date().toISOString(), manifest };
  staged.candidate = await recordStagedCandidate(stateDir, { candidateId, expectedVersion: current.version, candidate: staged.candidate, manifest: manifestRecord });
  return staged;
}

const baseValidationProfile = Object.freeze([
  { id: 'setup-learning-tests', command: process.execPath, args: ['--test'] },
  { id: 'dotfiles-scan', command: process.execPath, args: ['tools/dotfiles.mjs', 'scan'] },
  { id: 'dotfiles-verify', command: process.execPath, args: ['tools/dotfiles.mjs', 'verify'] },
]);
const validationProfiles = Object.freeze({ 'engine-skill': baseValidationProfile, 'engine-hook': baseValidationProfile, 'engine-agents': baseValidationProfile });
const profileForKind = Object.freeze({ skill: 'engine-skill', hook: 'engine-hook', agents: 'engine-agents' });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const timestamp = () => new Date().toISOString();
const adapterConfigs = new WeakMap();
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reasons = Object.freeze({
  receipt: 'receipt_invalid', concurrent: 'concurrent_activation', pending: 'activation_pending', applied: 'applied', already: 'already_applied',
  projectScope: 'project_scope_adapter_unavailable',
  idle: 'idle_unavailable', baseline: 'target_baseline_diverged', changed: 'target_changed', smoke: 'smoke_failed', smokeError: 'smoke_error',
  rollback: 'rolled_back', rollbackPending: 'urgent_rollback_pending', rollbackTarget: 'rollback_target_mismatch', rollbackSmoke: 'rollback_smoke_failed',
  rollbackBackup: 'rollback_backup_unavailable',
});

function pending(reason, hostStates = {}) { return { status: 'pending', reason, hostStates }; }
function receiptFor(state, candidate, receiptId) {
  const receipt = state.receipts?.[receiptId];
  return receipt && receipt.candidateId === candidate.id && receipt.diffHash === candidate.diffHash && receipt.baselineHash === candidate.baselineHash && receipt.policyVersion === candidate.policyVersion ? receipt : null;
}

/** Creates a fixed-root adapter in trusted code. CLI data cannot construct one. */
export function createTrustedApplicationAdapter({ id, host, root, sourcePrefix = '', smoke }) {
  if (!safeIdentifier.test(id) || !['codex', 'claude', 'cursor', 'grok'].includes(host) || typeof root !== 'string' || typeof sourcePrefix !== 'string' || (sourcePrefix && (!validRelativePath(sourcePrefix.slice(0, -1)) || !sourcePrefix.endsWith('/'))) || typeof smoke !== 'function') throw new TypeError('application adapter is invalid');
  const adapter = Object.freeze({ id, host }); adapterConfigs.set(adapter, Object.freeze({ root: resolve(root), sourcePrefix, smoke })); return adapter;
}
function validRelativePath(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:\//.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..'); }
async function noLinkedAncestor(path) {
  const root = parse(path).root; let cursor = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('linked target'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}
async function targetPath(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).sort().join(',') !== 'adapter,expectedHash,relativePath,sourceHash,sourcePath,sourceWorktree') throw new TypeError('target is invalid');
  const config = adapterConfigs.get(target.adapter);
  const mapped = config && target.sourcePath?.startsWith(config.sourcePrefix) ? target.sourcePath.slice(config.sourcePrefix.length) : null;
  if (!config || !validRelativePath(target.relativePath) || target.relativePath !== mapped || typeof target.sourceWorktree !== 'string' || !/^[a-f0-9]{64}$/.test(target.sourceHash) || (target.expectedHash !== null && !/^[a-f0-9]{64}$/.test(target.expectedHash))) throw new TypeError('target is invalid');
  const path = resolve(config.root, ...target.relativePath.split('/'));
  if (path === config.root || !path.startsWith(`${config.root}${sep}`)) throw new Error('target outside adapter root');
  await noLinkedAncestor(path);
  try { const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile()) throw new Error('target is not a regular file'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return { path, config, host: target.adapter.host };
}

/** Fixed host roots. Skills are written once and probed independently from Codex and Claude. */
export function createHostApplicationAdapters({ home = homedir(), smokes }) {
  if (!smokes || !['codex', 'claude', 'cursor'].every((host) => typeof smokes[host] === 'function')) throw new TypeError('host smoke adapters are required');
  const canonicalSkillSmoke = async (input) => {
    const [codex, claude] = await Promise.all([smokes.codex(input), smokes.claude(input)]);
    if (codex?.passed !== true || claude?.passed !== true || !validEvidence(codex.evidenceRef) || !validEvidence(claude.evidenceRef)) return { passed: false };
    return { passed: true, evidenceRef: `access-${digest(`${codex.evidenceRef}:${claude.evidenceRef}`).slice(0, 40)}` };
  };
  return Object.freeze({
    skill: createTrustedApplicationAdapter({ id: 'shared-skill', host: 'codex', root: join(home, '.agents', 'skills'), sourcePrefix: 'skills/', smoke: canonicalSkillSmoke }),
    hooks: Object.freeze({
      codex: createTrustedApplicationAdapter({ id: 'codex-hook', host: 'codex', root: join(home, '.codex', 'hooks'), sourcePrefix: 'home/hooks/', smoke: smokes.codex }),
      claude: createTrustedApplicationAdapter({ id: 'claude-hook', host: 'claude', root: join(home, '.claude', 'hooks'), sourcePrefix: 'home/hooks/', smoke: smokes.claude }),
      cursor: createTrustedApplicationAdapter({ id: 'cursor-hook', host: 'cursor', root: join(home, '.cursor', 'hooks'), sourcePrefix: 'home/hooks/', smoke: smokes.cursor }),
    }),
    agents: createTrustedApplicationAdapter({ id: 'codex-agents', host: 'codex', root: join(home, '.codex'), sourcePrefix: 'home/', smoke: smokes.codex }),
  });
}

async function atomicReplace(path, value, expectedHash) {
  const directory = dirname(path);
  await noLinkedAncestor(directory);
  await mkdir(directory, { recursive: true });
  await noLinkedAncestor(path);
  const before = await currentFile(path); const beforeHash = before === null ? null : digest(before);
  if (beforeHash !== expectedHash) throw new Error('target changed before atomic replace');
  if (value === null) {
    if (before !== null) await rm(path);
    if (await currentFile(path) !== null) throw new Error('target deletion was not durable');
    return;
  }
  const temporary = join(directory, `.${basename(path)}.setup-learning-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close(); handle = null;
    await noLinkedAncestor(path);
    const current = await currentFile(path); const currentHash = current === null ? null : digest(current);
    if (currentHash !== expectedHash) throw new Error('target changed during atomic replace');
    await rename(temporary, path);
    const installed = await currentFile(path);
    if (installed === null || digest(installed) !== digest(value)) throw new Error('atomic replace hash mismatch');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function committedSource(worktree, receipt, manifest, target) {
  const declared = manifest.files.find(({ relativePath, sourceHash }) => relativePath === target.sourcePath && sourceHash === target.sourceHash);
  if (!declared) throw new Error('target source is outside staged manifest');
  const entry = await treeBlob(worktree, receipt.commit, target.sourcePath);
  if (digest(entry.content) !== target.sourceHash) throw new Error('receipt source hash differs from target');
  return entry.content;
}
async function currentFile(path) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('target must be a regular non-symbolic file'); return await readFile(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function idleFor(probeIdle, host) {
  try { const result = await probeIdle(host); return result?.idle === true && ['host-idle', 'reload-documented'].includes(result.reason) ? result : null; } catch { return null; }
}
function applicationId(candidateId, receiptId) { return `a-${digest(`${candidateId}:${receiptId}`).slice(0, 40)}`; }
function applicationEntryId(application, host, path) { return `e-${digest(`${application}:${host}:${path}`).slice(0, 40)}`; }
function statesFor(state, candidateId, receiptId) { return state.hostStates?.[candidateId]?.[receiptId] ?? {}; }
function candidateBound(current, supplied, receipt) { return current && supplied.id === current.id && supplied.diffHash === current.diffHash && supplied.baselineHash === current.baselineHash && supplied.policyVersion === current.policyVersion && receipt.diffHash === current.diffHash && receipt.baselineHash === current.baselineHash && receipt.policyVersion === current.policyVersion; }
function transition(current, status, reason) { return current.status === status ? null : { candidateId: current.id, expectedVersion: current.version, event: { previousStatus: current.status, status, at: timestamp(), reason } }; }
function applicationEntry({ id, host, path, baselineHash, backup, appliedHash, phase, reason, evidenceRef = null, backupCreatedAt = null, deactivatedAt = null }) { return { id, host, path, baselineHash, backup, appliedHash, phase, reason, evidenceRef, backupCreatedAt, deactivatedAt }; }
function replaceEntry(application, entry) { const index = application.entries.findIndex(({ id }) => id === entry.id); if (index < 0) application.entries.push(entry); else application.entries[index] = entry; application.updatedAt = timestamp(); }
function validEvidence(value) { return typeof value === 'string' && safeIdentifier.test(value) ? value : null; }
async function reviewEvidence(stateDir, reference, candidate, manifest) {
  if (!safeIdentifier.test(reference)) return null;
  const root = resolve(stateDir); const path = resolve(root, 'review-evidence', `${reference}.json`);
  if (!path.startsWith(`${root}${sep}`)) return null;
  try {
    await noLinkedAncestor(path); const raw = await readFile(path, 'utf8'); const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'candidateId,commit,diffHash,id,scope,verdict,version' || value.version !== 1 || value.id !== reference || value.candidateId !== candidate.id || value.commit !== manifest.commit || value.diffHash !== manifest.diffHash || value.scope !== 'slice-review' || value.verdict !== 'approve') return null;
    const evidenceHash = digest(raw); return { hash: evidenceHash, ref: `review-evidence:${reference}:${evidenceHash}` };
  } catch { return null; }
}
async function validationPending(stateDir, candidateId) {
  const state = await loadState(stateDir); const candidate = state.candidates.find(({ id }) => id === candidateId);
  if (candidate?.status === 'candidate') await recordTransition(stateDir, { candidateId, expectedVersion: candidate.version, event: { previousStatus: 'candidate', status: 'pending', at: timestamp(), reason: 'validation_failed' } });
}

function validationEnvironment() {
  const allowed = ['APPDATA', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'NO_COLOR', 'PATH', 'PATHEXT', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR'];
  return Object.fromEntries(allowed.flatMap((name) => typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []));
}

/** Records only a successful protected validation profile bound to the staged commit. */
export async function recordValidation({ stateDir, candidateId, worktree, validationProfile, reviewEvidenceRef }) {
  if (typeof stateDir !== 'string' || typeof candidateId !== 'string' || typeof worktree !== 'string' || typeof reviewEvidenceRef !== 'string' || !Object.hasOwn(validationProfiles, validationProfile)) throw new TypeError('validation input is invalid');
  const state = await loadState(stateDir); const candidate = state.candidates.find(({ id }) => id === candidateId); const record = [...state.manifests].reverse().find(({ candidateId: id }) => id === candidateId);
  if (!candidate || !record) return null; const evidence = await reviewEvidence(stateDir, reviewEvidenceRef, candidate, record.manifest); if (!evidence) { await validationPending(stateDir, candidateId); return null; }
  const policy = evaluatePolicy({ candidate, diffManifest: record.manifest, policy: { worktree } }); if (!policy.allowed || validationProfile !== profileForKind[candidate.artifactKind]) { await validationPending(stateDir, candidateId); return null; }
  try {
    await cleanWorktree(worktree); const commit = (await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.toString('utf8').trim();
    if (commit !== record.manifest.commit) { await validationPending(stateDir, candidateId); return null; }
    const beforeTree = (await git(worktree, ['ls-tree', '-r', '-z', commit])).stdout;
    const commands = [];
    // The reviewed checkout still executes code; the narrow environment limits credential exposure but is not a sandbox.
    const env = validationEnvironment();
    for (const profile of validationProfiles[validationProfile]) { await execFile(profile.command, profile.args, { cwd: worktree, windowsHide: true, env, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }); commands.push({ id: profile.id, exitCode: 0 }); }
    await git(worktree, ['diff', '--check', `${record.manifest.baseRef}..${commit}`]); commands.push({ id: 'git-diff-check', exitCode: 0 });
    await cleanWorktree(worktree); const finalCommit = (await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.toString('utf8').trim(); const afterTree = (await git(worktree, ['ls-tree', '-r', '-z', finalCommit])).stdout;
    const finalEvidence = await reviewEvidence(stateDir, reviewEvidenceRef, candidate, record.manifest);
    if (finalCommit !== commit || !beforeTree.equals(afterTree) || finalEvidence?.hash !== evidence.hash) { await validationPending(stateDir, candidateId); return null; }
    let lockfileHash = null;
    for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) { try { lockfileHash = digest((await treeBlob(worktree, commit, name)).content); break; } catch {} }
    const receipt = { id: `r-${digest(`${candidateId}:${record.manifest.commit}:${record.manifest.diffHash}`).slice(0, 40)}`, candidateId, commit, diffHash: candidate.diffHash, baselineHash: candidate.baselineHash, policyVersion: candidate.policyVersion, commands, treeHash: digest(afterTree), lockfileHash, runtime: { node: process.version, platform: process.platform, arch: process.arch }, reviewEvidenceRef: evidence.ref, completedAt: timestamp() };
    return recordValidationReceipt(stateDir, receipt);
  } catch {
    await validationPending(stateDir, candidateId);
    return null;
  }
}

/** Applies a staged, reviewed artifact only through a closed-over trusted adapter. */
export async function activate({ stateDir, candidate, receiptId, targets, probeIdle }) {
  if (typeof stateDir !== 'string' || typeof receiptId !== 'string' || !Array.isArray(targets) || targets.length === 0 || typeof probeIdle !== 'function') throw new TypeError('activation input is invalid');
  validateCandidate(candidate); if (candidate.scope.kind === 'repo') return pending(reasons.projectScope); const state = await loadState(stateDir); const current = state.candidates.find(({ id }) => id === candidate.id); const receipt = current && receiptFor(state, current, receiptId); const manifestRecord = current && [...state.manifests].reverse().find(({ candidateId }) => candidateId === current.id);
  if (!current || !receipt || !manifestRecord || !['candidate', 'pending', 'local_applied'].includes(current.status)) return pending(reasons.receipt, current ? statesFor(state, current.id, receiptId) : {});
  try {
    return await withApplicationIntent(stateDir, { applicationId: applicationId(current.id, receiptId), candidateId: current.id, receiptId }, async (context) => {
      let activeCandidate = context.candidate; let application = context.application; let hostStates = {}; let performed = false; let interrupted = false;
      if (!candidateBound(activeCandidate, candidate, context.receipt) || !['candidate', 'pending', 'local_applied'].includes(activeCandidate.status)) return pending(reasons.receipt);
      const save = async (nextTransition = null, supersedes = []) => { const saved = await context.checkpoint({ application, transition: nextTransition, supersedes }); activeCandidate = saved.candidate; application = saved.application; hostStates = saved.hostStates; };
      for (const target of targets) {
        let location; let source;
        try { location = await targetPath(target); source = await committedSource(target.sourceWorktree, context.receipt, manifestRecord.manifest, target); } catch { continue; }
        const entryId = applicationEntryId(application.id, location.host, location.path); let entry = application.entries.find(({ id }) => id === entryId);
        if (entry && (entry.appliedHash !== target.sourceHash || entry.baselineHash !== target.expectedHash || entry.path !== location.path)) continue;
        if (entry?.phase === 'local_applied' || entry?.phase === 'superseded' || (entry?.phase === 'pending' && entry.reason === reasons.baseline)) continue;
        if (!(await idleFor(probeIdle, location.host))) {
          entry = applicationEntry({ id: entryId, host: location.host, path: location.path, baselineHash: target.expectedHash, backup: entry?.backup ?? null, appliedHash: target.sourceHash, phase: entry?.phase === 'prepared' ? 'prepared' : 'pending', reason: reasons.idle, backupCreatedAt: entry?.backupCreatedAt ?? null, deactivatedAt: entry?.deactivatedAt ?? null }); replaceEntry(application, entry); await save(); continue;
        }
        let actual = await currentFile(location.path); const actualHash = actual === null ? null : digest(actual);
        if (entry?.phase === 'prepared' && actualHash !== entry.appliedHash && actualHash !== entry.baselineHash) { replaceEntry(application, { ...entry, phase: 'pending', reason: reasons.changed, evidenceRef: null }); await save(); continue; }
        if (entry?.phase !== 'prepared') {
          if (actualHash !== target.expectedHash) { entry = applicationEntry({ id: entryId, host: location.host, path: location.path, baselineHash: target.expectedHash, backup: null, appliedHash: target.sourceHash, phase: 'pending', reason: reasons.baseline }); replaceEntry(application, entry); await save(); continue; }
          entry = applicationEntry({ id: entryId, host: location.host, path: location.path, baselineHash: actualHash, backup: actual === null ? null : actual.toString('base64'), appliedHash: target.sourceHash, phase: 'prepared', reason: 'application_prepared', backupCreatedAt: actual === null ? null : timestamp() }); replaceEntry(application, entry); await save();
        }
        performed = true;
        if (actualHash !== entry.appliedHash) await atomicReplace(location.path, source, actualHash);
        let smoke;
        try { smoke = await location.config.smoke({ host: location.host, path: location.path, expectedHash: entry.appliedHash }); } catch { interrupted = true; continue; }
        actual = await currentFile(location.path);
        if (smoke?.passed !== true || validEvidence(smoke.evidenceRef) === null) {
          if (actual !== null && digest(actual) === entry.appliedHash) await atomicReplace(location.path, entry.backup === null ? null : Buffer.from(entry.backup, 'base64'), entry.appliedHash);
          replaceEntry(application, { ...entry, phase: 'pending', reason: reasons.smoke, evidenceRef: null }); await save(); continue;
        }
        if (actual === null || digest(actual) !== entry.appliedHash) { replaceEntry(application, { ...entry, phase: 'pending', reason: reasons.changed, evidenceRef: null }); await save(); continue; }
        const supersedes = context.applications.flatMap((other) => other.candidateId === activeCandidate.id ? [] : other.entries.filter((prior) => prior.host === entry.host && prior.path === entry.path && prior.phase === 'local_applied').map(({ id }) => id));
        replaceEntry(application, { ...entry, phase: 'local_applied', reason: reasons.applied, evidenceRef: validEvidence(smoke.evidenceRef) }); await save(transition(activeCandidate, 'local_applied', reasons.applied), supersedes);
      }
      const hasApplied = application.entries.some(({ phase }) => phase === 'local_applied');
      if (!hasApplied && !interrupted && activeCandidate.status === 'candidate') await save(transition(activeCandidate, 'pending', reasons.pending));
      if (!performed && hasApplied) return pending(reasons.already, hostStates);
      return { status: hasApplied ? 'local_applied' : 'pending', reason: hasApplied ? reasons.applied : (interrupted ? reasons.smokeError : reasons.pending), hostStates };
    });
  } catch { const fresh = await loadState(stateDir); return pending(reasons.concurrent, statesFor(fresh, current.id, receiptId)); }
}

/** Restores only the private backup whose currently owned bytes still match. */
export async function rollback({ stateDir, candidate, receiptId, targets, probeIdle }) {
  if (typeof stateDir !== 'string' || typeof receiptId !== 'string' || !Array.isArray(targets) || typeof probeIdle !== 'function') throw new TypeError('rollback input is invalid');
  validateCandidate(candidate); const state = await loadState(stateDir); const current = state.candidates.find(({ id }) => id === candidate.id); const receipt = current && receiptFor(state, current, receiptId);
  if (!current || !receipt || current.status !== 'local_applied') return pending(reasons.receipt, current ? statesFor(state, current.id, receiptId) : {});
  try {
    return await withApplicationIntent(stateDir, { applicationId: applicationId(current.id, receiptId), candidateId: current.id, receiptId }, async (context) => {
      let activeCandidate = context.candidate; let application = context.application; let hostStates = {}; let conflict = false; let changed = false;
      if (!candidateBound(activeCandidate, candidate, context.receipt) || activeCandidate.status !== 'local_applied') return pending(reasons.receipt);
      const descriptors = [];
      for (const target of targets) { try { descriptors.push({ target, location: await targetPath(target) }); } catch {} }
      const save = async (nextTransition = null) => { const saved = await context.checkpoint({ application, transition: nextTransition, supersedes: [] }); activeCandidate = saved.candidate; application = saved.application; hostStates = saved.hostStates; };
      for (const original of [...application.entries]) {
        const retryablePending = original.phase === 'pending' && [reasons.rollbackTarget, reasons.idle].includes(original.reason);
        if (!['local_applied', 'rollback_prepared'].includes(original.phase) && !retryablePending) continue;
        const descriptor = descriptors.find(({ target, location }) => location.host === original.host && location.path === original.path && target.sourceHash === original.appliedHash);
        if (!descriptor) { replaceEntry(application, { ...original, phase: 'pending', reason: reasons.rollbackTarget, evidenceRef: null }); await save(); conflict = true; continue; }
        if (!(await idleFor(probeIdle, original.host))) { replaceEntry(application, { ...original, phase: original.phase === 'rollback_prepared' ? 'rollback_prepared' : 'pending', reason: reasons.idle, evidenceRef: null }); await save(); conflict = true; continue; }
        let actual = await currentFile(original.path); let actualHash = actual === null ? null : digest(actual);
        if (original.phase === 'local_applied' || retryablePending) {
          if (actualHash !== original.appliedHash) { replaceEntry(application, { ...original, phase: 'pending', reason: reasons.changed, evidenceRef: null }); await save(); conflict = true; continue; }
          if (original.baselineHash !== null && original.backup === null) { replaceEntry(application, { ...original, phase: 'pending', reason: reasons.rollbackBackup, evidenceRef: null }); await save(); conflict = true; continue; }
          replaceEntry(application, { ...original, phase: 'rollback_prepared', reason: 'rollback_prepared', evidenceRef: null }); await save();
          await atomicReplace(original.path, original.backup === null ? null : Buffer.from(original.backup, 'base64'), original.appliedHash); actual = await currentFile(original.path); actualHash = actual === null ? null : digest(actual);
        }
        const restoredHash = original.backup === null ? null : digest(Buffer.from(original.backup, 'base64'));
        if (actualHash !== restoredHash) { replaceEntry(application, { ...original, phase: 'pending', reason: reasons.changed, evidenceRef: null }); await save(); conflict = true; continue; }
        let smoke; try { smoke = await descriptor.location.config.smoke({ host: original.host, path: original.path, rollback: true, expectedHash: restoredHash }); } catch { conflict = true; continue; }
        actual = await currentFile(original.path); actualHash = actual === null ? null : digest(actual);
        if (smoke?.passed !== true || validEvidence(smoke.evidenceRef) === null) { replaceEntry(application, { ...original, phase: 'rollback_prepared', reason: reasons.rollbackSmoke, evidenceRef: null }); await save(); conflict = true; continue; }
        if (actualHash !== restoredHash) { replaceEntry(application, { ...original, phase: 'pending', reason: reasons.changed, evidenceRef: null }); await save(); conflict = true; continue; }
        replaceEntry(application, { ...original, phase: 'rolled_back', reason: reasons.rollback, evidenceRef: validEvidence(smoke.evidenceRef), deactivatedAt: timestamp() }); await save(); changed = true;
      }
      const remaining = application.entries.some(({ phase }) => ['local_applied', 'prepared', 'pending', 'rollback_prepared'].includes(phase));
      if (!remaining && activeCandidate.status === 'local_applied') await save(transition(activeCandidate, 'rolled_back', reasons.rollback));
      return { status: conflict || remaining ? 'pending' : (changed ? 'rolled_back' : 'pending'), reason: conflict || remaining ? reasons.rollbackPending : reasons.rollback, hostStates };
    });
  } catch { const fresh = await loadState(stateDir); return pending(reasons.concurrent, statesFor(fresh, current.id, receiptId)); }
}
