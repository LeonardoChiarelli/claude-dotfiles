import { appendFile, lstat, mkdir, open, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { validateCandidate, validateEvent, validateSuggestion } from './contracts.mjs';
import { digestSnapshot, gmailSendRequest } from './digest.mjs';

const names = { journal: 'journal.jsonl', snapshot: 'snapshot.json', lock: '.lock', workerLock: '.worker.lock', recoveryLock: '.recovery.lock' };
const day = 24 * 60 * 60 * 1000;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash = /^[a-f0-9]{64}$/;
const commitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const encodedHistorySegment = /^(?:[A-Za-z0-9._~!'()*+-]|%[A-Fa-f0-9]{2})+$/;
const cursorHistorySegment = /^[A-Za-z0-9._-]+$/;
const statuses = new Set(['candidate', 'pending', 'rejected', 'local_applied', 'synced', 'merged', 'remote_active', 'rolled_back']);
const hosts = new Set(['codex', 'claude', 'cursor', 'grok']);
const applicationPhases = new Set(['prepared', 'pending', 'local_applied', 'rollback_prepared', 'rolled_back', 'superseded']);
const applicationReasons = new Set(['application_prepared', 'idle_unavailable', 'target_baseline_diverged', 'target_changed', 'smoke_failed', 'applied', 'rollback_prepared', 'rollback_smoke_failed', 'rollback_target_mismatch', 'rollback_backup_unavailable', 'rolled_back']);
const initialState = () => ({ events: [], sources: [], patterns: [], candidates: [], manifests: [], tombstones: [], hostStates: {}, receipts: {}, applications: [], installations: [], capabilities: {}, skillInventory: null, worker: { imports: {}, analyzedEventIds: [], handoff: null, historyAfter: null }, cursors: { import: 0, analysis: 0 }, ledger: [] });

async function contained(stateDir, ...parts) {
  const root = resolve(stateDir); const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) throw new Error('state path violates containment');
  const anchor = parse(target).root; let cursor = anchor;
  for (const part of target.slice(anchor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('state path violates containment through symlink'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return target;
}
async function atomicText(path, value) { const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`); await writeFile(temp, value, { encoding: 'utf8', flag: 'wx' }); await rename(temp, path); }
async function atomicJson(path, value) { await atomicText(path, `${JSON.stringify(value)}\n`); }
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; } }
function merge(state) { return { ...initialState(), ...state, applications: Array.isArray(state.applications) ? state.applications : [], installations: Array.isArray(state.installations) ? state.installations : [], capabilities: state.capabilities && typeof state.capabilities === 'object' && !Array.isArray(state.capabilities) ? state.capabilities : {}, skillInventory: state.skillInventory && typeof state.skillInventory === 'object' && !Array.isArray(state.skillInventory) ? state.skillInventory : null, ledger: Array.isArray(state.ledger) ? state.ledger : [], worker: { imports: {}, analyzedEventIds: [], handoff: null, historyAfter: null, ...(state.worker ?? {}) }, cursors: { import: 0, analysis: 0, ...(state.cursors ?? {}) } }; }
function addEvent(state, value) { const event = validateEvent(value); if (!state.events.some((item) => item.id === event.id)) state.events.push(event); }
function addCandidate(state, value) { const candidate = validateCandidate(value); const existing = state.candidates.find((item) => item.id === candidate.id); if (existing && existing.version === candidate.version && JSON.stringify(existing) !== JSON.stringify(candidate)) throw new Error('candidate identity conflict'); if (existing && existing.version < candidate.version) throw new Error('candidate version conflict'); if (!existing) state.candidates.push(candidate); }
function suggestionContext(state, value, replay) {
  return replay
    ? { eventIds: value?.supportEventIds ?? [], knownPatternKeys: state.patterns.map(({ key }) => key) }
    : { eventIds: state.events.map((item) => item.id), events: state.events, knownPatternKeys: state.patterns.map(({ key }) => key) };
}
function addSuggestion(state, value, replay = false) { const suggestion = validateSuggestion(value, suggestionContext(state, value, replay)); if (!state.suggestions?.some((item) => JSON.stringify(item) === JSON.stringify(suggestion))) state.suggestions = [...(state.suggestions ?? []), suggestion]; }
function addPattern(state, value, replay = false) {
  exact(value, ['key', 'scope', 'supportEventIds', 'correctionEventIds', 'contradicts', 'lastHumanCorrectionAt'], 'pattern');
  validateSuggestion({ patternKey: value.key, summary: 'padrão generalizado', scope: value.scope, supportEventIds: value.supportEventIds, correctionEventIds: value.correctionEventIds, contradicts: value.contradicts, artifactKind: 'skill', diagnosis: 'instrução ambígua' }, suggestionContext(state, value, replay));
  if (typeof value.lastHumanCorrectionAt !== 'string' || Number.isNaN(Date.parse(value.lastHumanCorrectionAt))) throw new TypeError('pattern lastHumanCorrectionAt is invalid');
  const existing = state.patterns.find((item) => item.key === value.key);
  if (existing && JSON.stringify(existing.scope) !== JSON.stringify(value.scope)) throw new Error('pattern identity conflict');
  if (!existing) state.patterns.push(structuredClone(value));
  else {
    existing.supportEventIds = [...new Set([...existing.supportEventIds, ...value.supportEventIds])];
    existing.correctionEventIds = [...new Set([...existing.correctionEventIds, ...value.correctionEventIds])];
    existing.contradicts = [...new Set([...existing.contradicts, ...value.contradicts])];
    if (Date.parse(value.lastHumanCorrectionAt) > Date.parse(existing.lastHumanCorrectionAt)) existing.lastHumanCorrectionAt = value.lastHumanCorrectionAt;
  }
}
export function validateDiffManifest(value) {
  exact(value, ['files', 'baseRef', 'baselineHash', 'diffHash', 'commit'], 'diff manifest');
  if (!commitHash.test(value.baseRef) || !hash.test(value.baselineHash) || !hash.test(value.diffHash) || !commitHash.test(value.commit) || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 256) throw new TypeError('diff manifest is invalid');
  const paths = new Set();
  for (const file of value.files) {
    exact(file, ['relativePath', 'sourceHash', 'beforeHash', 'afterHash'], 'diff manifest file');
    const path = file.relativePath;
    if (typeof path !== 'string' || path.length === 0 || path.length > 512 || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').some((part) => part === '' || part === '.' || part === '..') || paths.has(path)) throw new TypeError('diff manifest path is invalid');
    if (!hash.test(file.sourceHash) || !hash.test(file.afterHash) || (file.beforeHash !== null && !hash.test(file.beforeHash)) || file.sourceHash !== file.afterHash) throw new TypeError('diff manifest file hash is invalid');
    paths.add(path);
  }
  return value;
}
function addManifest(state, value) {
  exact(value, value?.deactivatedAt === undefined ? ['id', 'candidateId', 'active', 'createdAt', 'manifest'] : ['id', 'candidateId', 'active', 'createdAt', 'deactivatedAt', 'manifest'], 'manifest');
  if (!identifier.test(value.id) || !identifier.test(value.candidateId) || typeof value.active !== 'boolean' || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) throw new TypeError('manifest is invalid');
  if (value.deactivatedAt !== undefined && (typeof value.deactivatedAt !== 'string' || Number.isNaN(Date.parse(value.deactivatedAt)) || new Date(value.deactivatedAt).toISOString() !== value.deactivatedAt)) throw new TypeError('manifest is invalid');
  validateDiffManifest(value.manifest);
  const existing = state.manifests.find((item) => item.id === value.id);
  if (existing && JSON.stringify({ id: existing.id, candidateId: existing.candidateId, createdAt: existing.createdAt, manifest: existing.manifest }) !== JSON.stringify({ id: value.id, candidateId: value.candidateId, createdAt: value.createdAt, manifest: value.manifest })) throw new Error('manifest identity conflict');
  if (!existing) state.manifests.push(value);
}
function exact(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name} extra key: ${key}`);
  for (const key of keys) if (!(key in value)) throw new TypeError(`${name} missing key: ${key}`);
}
function validateTransition(change) {
  exact(change, ['candidateId', 'expectedVersion', 'event'], 'transition');
  if (typeof change.candidateId !== 'string' || !identifier.test(change.candidateId)) throw new TypeError('transition candidateId is invalid');
  if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0) throw new TypeError('transition expectedVersion is invalid');
  exact(change.event, change.event?.host === undefined ? ['previousStatus', 'status', 'at', 'reason'] : ['previousStatus', 'status', 'at', 'reason', 'host'], 'transition event');
  if (!statuses.has(change.event.previousStatus) || !statuses.has(change.event.status)) throw new TypeError('transition status is invalid');
  if (typeof change.event.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(change.event.at) || Number.isNaN(Date.parse(change.event.at)) || new Date(change.event.at).toISOString() !== change.event.at) throw new TypeError('transition at is invalid');
  if (typeof change.event.reason !== 'string' || change.event.reason.length === 0 || change.event.reason.length > 1024) throw new TypeError('transition reason is invalid');
  if (change.event.host !== undefined && !hosts.has(change.event.host)) throw new TypeError('transition host is invalid');
  return change;
}
function validateReceipt(value) {
  exact(value, ['id', 'candidateId', 'commit', 'diffHash', 'baselineHash', 'policyVersion', 'commands', 'treeHash', 'lockfileHash', 'runtime', 'reviewEvidenceRef', 'completedAt'], 'validation receipt');
  if (!identifier.test(value.id) || !identifier.test(value.candidateId) || !commitHash.test(value.commit) || !hash.test(value.diffHash) || !hash.test(value.baselineHash) || !hash.test(value.treeHash) || (value.lockfileHash !== null && !hash.test(value.lockfileHash))) throw new TypeError('validation receipt is invalid');
  if (typeof value.policyVersion !== 'string' || value.policyVersion.length === 0 || !Array.isArray(value.commands) || value.commands.length === 0 || value.commands.some((item) => !item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'exitCode,id' || !identifier.test(item.id) || item.exitCode !== 0) || !value.runtime || typeof value.runtime !== 'object' || Array.isArray(value.runtime) || typeof value.reviewEvidenceRef !== 'string' || !/^review-evidence:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}:[a-f0-9]{64}$/.test(value.reviewEvidenceRef) || typeof value.completedAt !== 'string' || Number.isNaN(Date.parse(value.completedAt))) throw new TypeError('validation receipt is invalid');
  return value;
}
function validateApplication(value) {
  exact(value, ['id', 'candidateId', 'receiptId', 'entries', 'updatedAt'], 'application');
  if (!identifier.test(value.id) || !identifier.test(value.candidateId) || !identifier.test(value.receiptId) || !Array.isArray(value.entries) || typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt) throw new TypeError('application is invalid');
  const ids = new Set();
  for (const entry of value.entries) {
    exact(entry, ['id', 'host', 'path', 'baselineHash', 'backup', 'appliedHash', 'phase', 'reason', 'evidenceRef', 'backupCreatedAt', 'deactivatedAt'], 'application entry');
    if (!identifier.test(entry.id) || ids.has(entry.id) || !hosts.has(entry.host) || typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.length > 1024 || (entry.baselineHash !== null && !hash.test(entry.baselineHash)) || (entry.backup !== null && (typeof entry.backup !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.backup))) || !hash.test(entry.appliedHash) || !applicationPhases.has(entry.phase) || !applicationReasons.has(entry.reason) || (entry.evidenceRef !== null && !identifier.test(entry.evidenceRef))) throw new TypeError('application entry is invalid');
    if (entry.backup !== null && entry.backupCreatedAt === null) throw new TypeError('application entry is invalid');
    for (const at of [entry.backupCreatedAt, entry.deactivatedAt]) if (at !== null && (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at)) throw new TypeError('application entry is invalid');
    ids.add(entry.id);
  }
  return value;
}
function validateApplicationEvent(value) {
  exact(value, ['type', 'value', 'transition', 'supersedes'], 'journal application'); validateApplication(value.value);
  if (value.transition !== null) validateTransition(value.transition);
  if (!Array.isArray(value.supersedes) || value.supersedes.some((item) => typeof item !== 'string' || !identifier.test(item)) || new Set(value.supersedes).size !== value.supersedes.length) throw new TypeError('application supersedes is invalid');
  return value;
}
function validateJournalEntry(value) {
  if (value?.type === 'source') { exact(value, ['type', 'value'], 'journal source'); validateSource(value.value); return value; }
  if (value?.type === 'event') { exact(value, ['type', 'value'], 'journal event'); validateEvent(value.value); return value; }
  if (value?.type === 'candidate') { exact(value, ['type', 'value'], 'journal candidate'); validateCandidate(value.value); return value; }
  if (value?.type === 'stage') { exact(value, ['type', 'candidateId', 'expectedVersion', 'candidate', 'manifest'], 'journal stage'); if (typeof value.candidateId !== 'string' || !identifier.test(value.candidateId) || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0) throw new TypeError('journal stage is invalid'); validateCandidate(value.candidate); addManifest(initialState(), value.manifest); if (value.candidate.id !== value.candidateId || value.candidate.version !== value.expectedVersion + 1 || value.manifest.candidateId !== value.candidateId || value.candidate.baselineHash !== value.manifest.manifest.baselineHash || value.candidate.diffHash !== value.manifest.manifest.diffHash) throw new TypeError('journal stage is inconsistent'); return value; }
  if (value?.type === 'suggestion') { exact(value, ['type', 'value'], 'journal suggestion'); validateSuggestion(value.value, { eventIds: value.value?.supportEventIds ?? [], knownPatternKeys: value.value?.contradicts ?? [] }); return value; }
  if (value?.type === 'pattern') { exact(value, ['type', 'value'], 'journal pattern'); addPattern({ ...initialState(), patterns: (value.value?.contradicts ?? []).map((key) => ({ key })) }, value.value, true); return value; }
  if (value?.type === 'manifest') { exact(value, ['type', 'value'], 'journal manifest'); addManifest(initialState(), value.value); return value; }
  if (value?.type === 'transition') { exact(value, ['type', 'candidateId', 'expectedVersion', 'event'], 'journal transition'); validateTransition({ candidateId: value.candidateId, expectedVersion: value.expectedVersion, event: value.event }); return value; }
  if (value?.type === 'receipt') { exact(value, ['type', 'value'], 'journal receipt'); validateReceipt(value.value); return value; }
  if (value?.type === 'application') return validateApplicationEvent(value);
  if (value?.type === 'digest') { exact(value, ['type', 'value'], 'journal digest'); validateDigest(value.value); return value; }
  if (value?.type === 'worker') { exact(value, ['type', 'value'], 'journal worker'); validateWorker(value.value); return value; }
  if (value?.type === 'installation') { exact(value, ['type', 'value'], 'journal installation'); validateInstallation(value.value); return value; }
  if (value?.type === 'capability') { exact(value, ['type', 'value'], 'journal capability'); validateCapability(value.value); return value; }
  if (value?.type === 'skill_inventory') { exact(value, ['type', 'value'], 'journal skill inventory'); validateSkillInventory(value.value); return value; }
  if (value?.type === 'rejection') { exact(value, ['type', 'value'], 'journal rejection'); validateRejection(value.value); return value; }
  throw new TypeError('journal entry type is invalid');
}
function validateWorker(value) {
  const keys = Object.keys(value ?? {}).sort().join(',');
  if (keys !== ['imports', 'analyzedEventIds', 'handoff'].sort().join(',') && keys !== ['imports', 'analyzedEventIds', 'handoff', 'historyAfter'].sort().join(',')) throw new TypeError('worker progress has invalid fields');
  if (!value.imports || typeof value.imports !== 'object' || Array.isArray(value.imports)) throw new TypeError('worker imports are invalid');
  for (const [locator, cursor] of Object.entries(value.imports)) if (typeof locator !== 'string' || !/^(codex|claude|cursor|grok):\/\//.test(locator) || (typeof cursor !== 'string' && (!Number.isSafeInteger(cursor) || cursor < 0))) throw new TypeError('worker imports are invalid');
  if (!Array.isArray(value.analyzedEventIds) || value.analyzedEventIds.some((id) => !identifier.test(id)) || new Set(value.analyzedEventIds).size !== value.analyzedEventIds.length) throw new TypeError('worker analyzedEventIds are invalid');
  if (value.handoff !== null) {
    exact(value.handoff, ['candidateId', 'status', 'requestedAt', 'evidenceRef'], 'worker handoff');
    if (!identifier.test(value.handoff.candidateId) || !['prepared', 'handed_off'].includes(value.handoff.status) || typeof value.handoff.requestedAt !== 'string' || Number.isNaN(Date.parse(value.handoff.requestedAt)) || new Date(value.handoff.requestedAt).toISOString() !== value.handoff.requestedAt || (value.handoff.status === 'prepared' ? value.handoff.evidenceRef !== null : !identifier.test(value.handoff.evidenceRef))) throw new TypeError('worker handoff is invalid');
  }
  if (value.historyAfter !== undefined && value.historyAfter !== null && !validHistoryLocator(value.historyAfter)) throw new TypeError('worker historyAfter is invalid');
  return value;
}
function validHistoryLocator(value) {
  if (typeof value !== 'string' || value.length > 900) return false;
  for (const prefix of ['codex://history/', 'claude://history/', 'grok://history/']) if (value.startsWith(prefix)) return value.slice(prefix.length).split('/').every((part) => encodedHistorySegment.test(part));
  if (value.startsWith('cursor://projects/')) return value.slice('cursor://projects/'.length).split('/').every((part) => cursorHistorySegment.test(part));
  return false;
}
function applyWorker(state, value) { validateWorker(value); state.worker = { historyAfter: null, ...structuredClone(value) }; }
function validateInstallation(value) {
  exact(value, ['id', 'host', 'artifactKind', 'status', 'contentHash', 'observedAt', 'evidenceRef'], 'installation fact');
  if (!identifier.test(value.id) || !hosts.has(value.host) || !['skill', 'hook', 'agents', 'mcp'].includes(value.artifactKind) || !['installed', 'disabled', 'pending'].includes(value.status) || !hash.test(value.contentHash) || typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt || !identifier.test(value.evidenceRef)) throw new TypeError('installation fact is invalid');
  return value;
}
function addInstallation(state, value) {
  validateInstallation(value); const existing = state.installations.find(({ id }) => id === value.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('installation fact conflict');
  if (!existing) state.installations.push(structuredClone(value));
}
function validateCapability(value) {
  exact(value, ['capability', 'status', 'evidenceRef', 'observedAt'], 'capability evidence');
  if (!['scheduler', 'gmail', 'claudeCli', 'grok'].includes(value.capability) || !['available', 'pending'].includes(value.status) || !identifier.test(value.evidenceRef) || typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt) throw new TypeError('capability evidence is invalid');
  return value;
}
function applyCapability(state, value) {
  validateCapability(value); const current = state.capabilities[value.capability];
  if (current && Date.parse(value.observedAt) < Date.parse(current.observedAt)) return;
  if (current && value.observedAt === current.observedAt && JSON.stringify(current) !== JSON.stringify(value)) throw new Error('capability evidence conflict');
  state.capabilities[value.capability] = structuredClone(value);
}
function validateSkillInventory(value) {
  exact(value, ['source', 'evidenceRef', 'observedAt', 'skills'], 'skill inventory');
  if (value.source !== 'skills/list' || !identifier.test(value.evidenceRef) || typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt || !Array.isArray(value.skills) || value.skills.length > 5_000) throw new TypeError('skill inventory is invalid');
  const paths = new Set();
  for (const skill of value.skills) {
    exact(skill, ['path', 'hash', 'disabled'], 'skill inventory entry');
    if (typeof skill.path !== 'string' || skill.path.length > 512 || !/^(?:\.agents\/skills|\.codex\/plugins\/cache)\/[A-Za-z0-9][A-Za-z0-9._/-]*\/SKILL\.md$/.test(skill.path) || skill.path.split('/').some((part) => part === '.' || part === '..') || paths.has(skill.path) || !hash.test(skill.hash) || typeof skill.disabled !== 'boolean') throw new TypeError('skill inventory entry is invalid');
    paths.add(skill.path);
  }
  return value;
}
function applySkillInventory(state, value) {
  validateSkillInventory(value); const current = state.skillInventory;
  if (current && Date.parse(value.observedAt) < Date.parse(current.observedAt)) return;
  if (current && value.observedAt === current.observedAt && JSON.stringify(current) !== JSON.stringify(value)) throw new Error('skill inventory conflict');
  state.skillInventory = structuredClone(value);
}
function validateSource(value) {
  exact(value, ['host', 'event', 'session', 'occurredAt', 'locator'], 'source');
  if (!hosts.has(value.host) || !['SessionStart', 'Stop'].includes(value.event) || !identifier.test(value.session) || typeof value.occurredAt !== 'string' || Number.isNaN(Date.parse(value.occurredAt)) || typeof value.locator !== 'string' || !value.locator.startsWith(`${value.host}://`) || /\s/.test(value.locator)) throw new TypeError('source is invalid');
  return value;
}
function sameSource(left, right) { return ['host', 'event', 'session', 'locator'].every((key) => left[key] === right[key]); }
function addSource(state, value) { const source = validateSource(value); if (!state.sources.some((item) => sameSource(item, source))) state.sources.push(source); }
function validateDigest(value) {
  exact(value, value?.state === 'sent' ? ['id', 'to', 'subject', 'text', 'html', 'contentHash', 'snapshotHash', 'interval', 'preparedAt', 'state', 'messageId', 'evidenceRef'] : ['id', 'to', 'subject', 'text', 'html', 'contentHash', 'snapshotHash', 'interval', 'preparedAt', 'state'], 'digest ledger');
  if (typeof value.id !== 'string' || !identifier.test(value.id) || value.to !== 'leonardo@chiarelli.dev' || typeof value.subject !== 'string' || !value.subject.includes(`[SL:${value.id}]`) || !hash.test(value.contentHash) || !hash.test(value.snapshotHash) || !value.interval || Object.keys(value.interval).sort().join(',') !== 'date,timeZone' || !/^\d{4}-\d{2}-\d{2}$/.test(value.interval.date) || value.interval.timeZone !== 'America/Sao_Paulo' || typeof value.preparedAt !== 'string' || Number.isNaN(Date.parse(value.preparedAt)) || !['prepared', 'sending', 'unknown', 'sent'].includes(value.state)) throw new TypeError('digest ledger is invalid');
  gmailSendRequest(value);
  if (value.state === 'sent' && (typeof value.messageId !== 'string' || typeof value.evidenceRef !== 'string' || !identifier.test(value.messageId) || !identifier.test(value.evidenceRef))) throw new TypeError('digest ledger is invalid');
  return value;
}
function applyDigest(state, value) {
  const index = state.ledger.findIndex(({ id }) => id === value.id);
  if (index < 0) {
    if (value.state !== 'prepared') throw new Error('digest transition is invalid');
    state.ledger.push(structuredClone(value)); return;
  }
  const current = state.ledger[index];
  for (const key of ['to', 'subject', 'text', 'html', 'contentHash', 'snapshotHash', 'interval', 'preparedAt']) if (JSON.stringify(current[key]) !== JSON.stringify(value[key])) throw new Error('digest identity conflict');
  if (current.state === value.state) {
    if (JSON.stringify(current) !== JSON.stringify(value)) throw new Error('digest state conflict');
    return;
  }
  const allowed = { prepared: ['sending'], sending: ['sent', 'unknown'], unknown: ['sent'], sent: [] };
  if (!allowed[current.state].includes(value.state)) throw new Error('digest transition is invalid');
  state.ledger[index] = structuredClone(value);
}
function recoverSending(state) { for (const entry of state.ledger) if (entry.state === 'sending') entry.state = 'unknown'; }
function applyTransition(state, value) { const candidate = state.candidates.find((item) => item.id === value.candidateId); if (!candidate || candidate.version !== value.expectedVersion || candidate.status !== value.event.previousStatus) return; candidate.status = value.event.status; candidate.version += 1; }
function validateRejection(value) {
  exact(value, ['candidateId', 'expectedVersion', 'at', 'reason', 'evidenceRef'], 'rejection');
  if (!identifier.test(value.candidateId) || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0 || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at || !new Set(['review_rejected', 'scope_invalid', 'policy_denied', 'duplicate_existing']).has(value.reason) || !identifier.test(value.evidenceRef)) throw new TypeError('rejection is invalid');
  return value;
}
function applyRejection(state, value) {
  const candidate = state.candidates.find((item) => item.id === value.candidateId); if (!candidate || candidate.version !== value.expectedVersion || !['candidate', 'pending'].includes(candidate.status)) return;
  candidate.status = 'rejected'; candidate.version += 1;
  if (!state.tombstones.some(({ patternKey }) => patternKey === candidate.patternKey)) state.tombstones.push({ candidateId: candidate.id, patternKey: candidate.patternKey, rejectedAt: value.at, reason: value.reason, evidenceRef: value.evidenceRef });
}
function applyReceipt(state, value) { if (!state.receipts[value.id]) state.receipts[value.id] = value; }
function rebuildHostStates(state) {
  const result = {};
  for (const application of state.applications) {
    const byHost = {};
    for (const entry of application.entries) (byHost[entry.host] ??= []).push(entry);
    const hostsForReceipt = {};
    for (const [host, entries] of Object.entries(byHost)) {
      const status = entries.some(({ phase }) => ['prepared', 'pending', 'rollback_prepared'].includes(phase))
        ? 'pending'
        : entries.some(({ phase }) => phase === 'local_applied') ? 'local_applied' : 'rolled_back';
      hostsForReceipt[host] = { status, entries: entries.map(({ id, path, appliedHash, phase, reason, evidenceRef }) => ({ id, path, appliedHash, phase, reason, evidenceRef })) };
    }
    ((result[application.candidateId] ??= {})[application.receiptId] = hostsForReceipt);
  }
  state.hostStates = result;
}
function applyApplication(state, value) {
  const index = state.applications.findIndex(({ id }) => id === value.value.id);
  if (index < 0) state.applications.push(structuredClone(value.value)); else state.applications[index] = structuredClone(value.value);
  const current = state.applications.find(({ id }) => id === value.value.id);
  const installed = current.entries.some(({ phase }) => phase === 'local_applied');
  const inactive = current.entries.length > 0 && current.entries.every(({ phase }) => ['rolled_back', 'superseded'].includes(phase));
  for (const manifest of state.manifests) if (manifest.candidateId === current.candidateId) {
    if (installed) { manifest.active = true; delete manifest.deactivatedAt; }
    else if (inactive && manifest.active) { manifest.active = false; manifest.deactivatedAt = value.value.updatedAt; }
  }
  const supersededCandidates = new Set();
  for (const application of state.applications) for (const entry of application.entries) if (value.supersedes.includes(entry.id) && entry.phase === 'local_applied') { entry.phase = 'superseded'; entry.reason = 'rolled_back'; entry.evidenceRef = null; entry.deactivatedAt = value.value.updatedAt; supersededCandidates.add(application.candidateId); }
  for (const manifest of state.manifests) if (supersededCandidates.has(manifest.candidateId) && manifest.active) { manifest.active = false; manifest.deactivatedAt = value.value.updatedAt; }
  if (value.transition !== null) applyTransition(state, value.transition);
  rebuildHostStates(state);
}
function applyStage(state, value) { const index = state.candidates.findIndex((item) => item.id === value.candidateId); if (index < 0 || state.candidates[index].version !== value.expectedVersion || value.candidate.id !== value.candidateId || value.candidate.version !== value.expectedVersion + 1 || value.manifest.candidateId !== value.candidateId) return; addManifest(state, value.manifest); state.candidates[index] = value.candidate; }
function signalName(eventId) { const encoded = eventId.replace(/[A-Z:]/g, (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`); return `${/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(encoded) ? `%${encoded}` : encoded}.json`; }

async function journal(stateDir) {
  let raw; try { raw = await readFile(await contained(stateDir, names.journal), 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return { entries: [], bytes: 0 }; throw error; }
  const lines = raw.split('\n'); const entries = []; let bytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const hasNewline = index < lines.length - 1;
    if (!lines[index]) { if (hasNewline) bytes += 1; continue; }
    let value;
    try { value = JSON.parse(lines[index]); } catch { if (!hasNewline) return { entries, bytes, partial: true }; return { entries, bytes, pending: { reason: 'journal_corruption', line: index + 1 } }; }
    try { entries.push(validateJournalEntry(value)); } catch { return { entries, bytes, pending: { reason: 'journal_corruption', line: index + 1 } }; }
    bytes += Buffer.byteLength(lines[index]) + (hasNewline ? 1 : 0);
  }
  return { entries, bytes, needsNewline: raw.length > 0 && !raw.endsWith('\n') };
}
async function loadUnlocked(stateDir) {
  await mkdir(await contained(stateDir), { recursive: true });
  const state = merge(await readJson(await contained(stateDir, names.snapshot), initialState())); const log = await journal(stateDir);
  validateWorker(state.worker);
  if (state.skillInventory !== null) validateSkillInventory(state.skillInventory);
  const snapshotLedger = state.ledger.map((entry) => structuredClone(validateDigest(entry)));
  if (log.entries.some(({ type }) => type === 'digest')) state.ledger = [];
  else state.ledger = snapshotLedger;
  for (const entry of log.entries) { if (entry.type === 'source') addSource(state, entry.value); if (entry.type === 'event') addEvent(state, entry.value); if (entry.type === 'candidate') addCandidate(state, entry.value); if (entry.type === 'stage') applyStage(state, entry); if (entry.type === 'suggestion') addSuggestion(state, entry.value, true); if (entry.type === 'pattern') addPattern(state, entry.value, true); if (entry.type === 'manifest') addManifest(state, entry.value); if (entry.type === 'transition') applyTransition(state, entry); if (entry.type === 'rejection') applyRejection(state, entry.value); if (entry.type === 'receipt') applyReceipt(state, entry.value); if (entry.type === 'application') applyApplication(state, entry); if (entry.type === 'digest') applyDigest(state, entry.value); if (entry.type === 'worker') applyWorker(state, entry.value); if (entry.type === 'installation') addInstallation(state, entry.value); if (entry.type === 'capability') applyCapability(state, entry.value); if (entry.type === 'skill_inventory') applySkillInventory(state, entry.value); }
  recoverSending(state);
  rebuildHostStates(state);
  state.cursors.import = log.bytes; if (log.pending) state.pending = log.pending; return state;
}
async function snapshot(stateDir, state) { await atomicJson(await contained(stateDir, names.snapshot), state); }
async function addJournal(stateDir, entry) {
  validateJournalEntry(entry); const path = await contained(stateDir, names.journal); const log = await journal(stateDir);
  if (log.pending) throw new Error('journal corruption pending');
  if (log.partial) await truncate(path, log.bytes);
  else if (log.needsNewline) await appendFile(path, '\n', 'utf8');
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** @template T @param {string} stateDir @param {() => Promise<T>} fn @returns {Promise<T>} */
export async function withStateLock(stateDir, fn) {
  await mkdir(await contained(stateDir), { recursive: true }); const lock = await contained(stateDir, names.lock); const identity = { writerId: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }; let handle;
  try { handle = await open(lock, 'wx'); await handle.writeFile(JSON.stringify(identity), 'utf8'); } catch (error) { if (error?.code === 'EEXIST') throw new Error('state lock pending: existing identity is not provably this writer'); throw error; } finally { await handle?.close(); }
  let result; let failure;
  try { result = await fn(); } catch (error) { failure = error; }
  let current; try { current = await readJson(lock, undefined); } catch { throw new Error('state lock pending: ownership cannot be verified'); }
  if (current?.writerId !== identity.writerId || current.pid !== identity.pid || current.createdAt !== identity.createdAt) throw new Error('state lock pending: ownership changed');
  await rm(lock); if (failure) throw failure; return result;
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; } }
/** Recovers only a stale lock whose PID is proven dead and whose identity is unchanged. */
export async function recoverStateLock(stateDir, { now = Date.now, isAlive = processAlive, afterGuard = async () => {} } = {}) {
  await mkdir(await contained(stateDir), { recursive: true }); const guard = await contained(stateDir, names.recoveryLock); const guardIdentity = { writerId: randomUUID(), pid: process.pid, createdAt: new Date(now()).toISOString() }; let handle;
  try { handle = await open(guard, 'wx'); await handle.writeFile(JSON.stringify(guardIdentity), 'utf8'); } catch (error) { if (error?.code === 'EEXIST') return { status: 'pending', reason: 'recovery_active' }; throw error; } finally { await handle?.close(); }
  let outcome;
  try {
    await afterGuard();
    const lock = await contained(stateDir, names.lock); let raw;
    try { raw = await readFile(lock, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') { outcome = { status: 'clear' }; return outcome; } throw error; }
    let identity; try { identity = JSON.parse(raw); } catch { outcome = { status: 'pending', reason: 'identity_invalid' }; return outcome; }
    if (!identity || Object.keys(identity).sort().join(',') !== 'createdAt,pid,writerId' || !identifier.test(identity.writerId) || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.createdAt !== 'string' || Number.isNaN(Date.parse(identity.createdAt))) { outcome = { status: 'pending', reason: 'identity_invalid' }; return outcome; }
    if (now() - Date.parse(identity.createdAt) < 30_000) { outcome = { status: 'pending', reason: 'ttl_active' }; return outcome; }
    if (isAlive(identity.pid)) { outcome = { status: 'pending', reason: 'pid_active' }; return outcome; }
    if (await readFile(lock, 'utf8') !== raw) { outcome = { status: 'pending', reason: 'identity_changed' }; return outcome; }
    const quarantine = await contained(stateDir, `.lock.recovered-${identity.writerId}`); await rename(lock, quarantine); await rm(quarantine); outcome = { status: 'recovered', writerId: identity.writerId }; return outcome;
  } finally {
    const current = await readJson(guard, undefined); if (current?.writerId === guardIdentity.writerId && current.pid === guardIdentity.pid && current.createdAt === guardIdentity.createdAt) await rm(guard);
  }
}
/** Serializes worker cycles without blocking short state, collector, or digest writes. */
export async function withWorkerLease(stateDir, fn) {
  await mkdir(await contained(stateDir), { recursive: true }); const lock = await contained(stateDir, names.workerLock); const identity = { writerId: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }; let handle;
  try { handle = await open(lock, 'wx'); await handle.writeFile(JSON.stringify(identity), 'utf8'); } catch (error) { if (error?.code === 'EEXIST') return { acquired: false, result: null }; throw error; } finally { await handle?.close(); }
  try { return { acquired: true, result: await fn() }; } finally {
    const current = await readJson(lock, undefined); if (current?.writerId !== identity.writerId || current.pid !== identity.pid || current.createdAt !== identity.createdAt) throw new Error('worker lease pending: ownership changed'); await rm(lock);
  }
}
/** @param {string} stateDir @param {unknown} value */
export async function appendEvent(stateDir, value) {
  const event = validateEvent(value);
  await withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending');
    const signals = await contained(stateDir, 'signals'); await mkdir(signals, { recursive: true }); const signal = await contained(stateDir, 'signals', signalName(event.id));
    const existingSignal = await readJson(signal, undefined);
    if (existingSignal !== undefined && JSON.stringify(existingSignal) !== JSON.stringify(event)) throw new Error('immutable signal conflict');
    if (existingSignal === undefined) await atomicJson(signal, event);
    if (state.events.some((item) => item.id === event.id)) return;
    await addJournal(stateDir, { type: 'event', value: event }); addEvent(state, event); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state);
  });
}
/** Records only lifecycle metadata. A source is not a human Event. */
export async function recordSource(stateDir, value) {
  validateSource(value);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending');
    const existing = state.sources.find((item) => sameSource(item, value)); if (existing) return existing;
    await addJournal(stateDir, { type: 'source', value }); addSource(state, value); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return value;
  });
}
/** @param {string} stateDir */
export async function loadState(stateDir) { return loadUnlocked(stateDir); }
function cursorOffset(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  if (/^(0|[1-9]\d*)$/.test(value)) return Number(value);
  try { const parsed = JSON.parse(value); return Number.isSafeInteger(parsed?.offset) && parsed.offset >= 0 ? parsed.offset : null; } catch { return null; }
}
function assertWorkerAdvance(state, value) {
  const previousIds = new Set(state.worker.analyzedEventIds);
  if ([...previousIds].some((id) => !value.analyzedEventIds.includes(id))) throw new Error('worker analyzedEventIds cannot regress');
  for (const [locator, previous] of Object.entries(state.worker.imports)) if (Object.hasOwn(value.imports, locator) && (cursorOffset(value.imports[locator]) ?? -1) < (cursorOffset(previous) ?? 0)) throw new Error('worker import cursor cannot regress');
  const before = state.worker.handoff; const after = value.handoff;
  if (before && after && (before.candidateId !== after.candidateId || before.requestedAt !== after.requestedAt || (before.status === 'handed_off' && (after.status !== 'handed_off' || before.evidenceRef !== after.evidenceRef)))) throw new Error('worker handoff cannot regress');
  if (before && after === null && state.candidates.some(({ id, status }) => id === before.candidateId && status === 'candidate')) throw new Error('active worker handoff cannot be cleared');
}
/** Commits only durable import cursors and IDs whose suggestions and patterns already exist. */
export async function recordWorkerProgress(stateDir, value) {
  validateWorker(value);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending');
    assertWorkerAdvance(state, value);
    if (JSON.stringify(state.worker) === JSON.stringify(value)) return state.worker;
    await addJournal(stateDir, { type: 'worker', value }); applyWorker(state, value); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.worker;
  });
}
/** Records proof returned by the native controller after it starts the fixed candidate delivery. */
export async function finishWorkerHandoff(stateDir, value) {
  exact(value, ['candidateId', 'evidenceRef'], 'worker handoff result');
  if (!identifier.test(value.candidateId) || !identifier.test(value.evidenceRef)) throw new TypeError('worker handoff result is invalid');
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.worker.handoff;
    if (!current || current.candidateId !== value.candidateId || !['prepared', 'handed_off'].includes(current.status)) throw new Error('worker handoff is unavailable');
    const next = { ...current, status: 'handed_off', evidenceRef: value.evidenceRef }; assertWorkerAdvance(state, { ...state.worker, handoff: next });
    if (current.status === 'handed_off') { if (current.evidenceRef !== value.evidenceRef) throw new Error('worker handoff evidence conflict'); return current; }
    const worker = { ...state.worker, handoff: next }; await addJournal(stateDir, { type: 'worker', value: worker }); applyWorker(state, worker); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return next;
  });
}
/** Releases a handoff whose candidate is terminal or returned to policy-pending. */
export async function releaseTerminalWorkerHandoff(stateDir) {
  const terminal = new Set(['pending', 'rejected', 'local_applied', 'synced', 'merged', 'remote_active', 'rolled_back']);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.worker.handoff;
    if (!current) return null; const candidate = state.candidates.find(({ id }) => id === current.candidateId);
    if (!candidate || !terminal.has(candidate.status)) return current;
    const worker = { ...state.worker, handoff: null }; assertWorkerAdvance(state, worker); await addJournal(stateDir, { type: 'worker', value: worker }); applyWorker(state, worker); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return null;
  });
}
/** Persists only controller-observed capability evidence. */
export async function recordCapabilityEvidence(stateDir, value) {
  validateCapability(value);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.capabilities[value.capability];
    if (current && Date.parse(value.observedAt) < Date.parse(current.observedAt)) throw new Error('capability evidence is stale');
    if (current && value.observedAt === current.observedAt) { if (JSON.stringify(current) !== JSON.stringify(value)) throw new Error('capability evidence conflict'); return current; }
    await addJournal(stateDir, { type: 'capability', value }); applyCapability(state, value); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.capabilities[value.capability];
  });
}
/** Persists the latest closed, controller-observed native skills/list inventory. */
export async function recordSkillInventoryEvidence(stateDir, value) {
  validateSkillInventory(value);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.skillInventory;
    if (current && Date.parse(value.observedAt) < Date.parse(current.observedAt)) throw new Error('skill inventory is stale');
    if (current && value.observedAt === current.observedAt) { if (JSON.stringify(current) !== JSON.stringify(value)) throw new Error('skill inventory conflict'); return current; }
    await addJournal(stateDir, { type: 'skill_inventory', value }); applySkillInventory(state, value); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.skillInventory;
  });
}
/** Atomically records analysis output, merged pattern evidence, and processed IDs. */
export async function recordAnalysis(stateDir, { suggestions, patterns, worker }) {
  if (!Array.isArray(suggestions) || !Array.isArray(patterns)) throw new TypeError('analysis checkpoint is invalid'); validateWorker(worker);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); assertWorkerAdvance(state, worker);
    for (const value of suggestions) validateSuggestion(value, suggestionContext(state, value, false));
    for (const value of patterns) addPattern({ ...state, patterns: structuredClone(state.patterns) }, value);
    for (const value of suggestions) { await addJournal(stateDir, { type: 'suggestion', value }); addSuggestion(state, value); }
    for (const value of patterns) { await addJournal(stateDir, { type: 'pattern', value }); addPattern(state, value); }
    if (JSON.stringify(state.worker) !== JSON.stringify(worker)) { await addJournal(stateDir, { type: 'worker', value: worker }); applyWorker(state, worker); }
    state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.worker;
  });
}
/** Records only controller-observed installation facts for the first real digest. */
export async function recordInstallation(stateDir, value) {
  validateInstallation(value);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const existing = state.installations.find(({ id }) => id === value.id);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('installation fact conflict'); return existing; }
    await addJournal(stateDir, { type: 'installation', value }); addInstallation(state, value); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return value;
  });
}
/** @param {string} stateDir @param {unknown} value */
export async function recordPreparedDigest(stateDir, value) {
  const digest = value?.ledger ?? value;
  validateDigest(digest);
  if (digest.state !== 'prepared') throw new TypeError('digest must be prepared');
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending');
    if (digestSnapshot(state) !== digest.snapshotHash) throw new Error('digest snapshot is stale');
    const existing = state.ledger.find(({ id }) => id === digest.id);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(digest)) throw new Error('digest identity conflict'); return existing; }
    if (state.ledger.some(({ interval, state: status }) => interval.date === digest.interval.date && ['prepared', 'sending', 'unknown'].includes(status))) throw new Error('digest interval is pending');
    await addJournal(stateDir, { type: 'digest', value: digest }); applyDigest(state, digest); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return digest;
  });
}
/** @param {string} stateDir @param {string} envelopeId */
export async function beginSend(stateDir, envelopeId) {
  if (typeof envelopeId !== 'string' || !identifier.test(envelopeId)) throw new TypeError('envelope id is invalid');
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.ledger.find(({ id }) => id === envelopeId);
    if (!current || current.state !== 'prepared') throw new Error('digest envelope is not prepared');
    const next = { ...current, state: 'sending' }; await addJournal(stateDir, { type: 'digest', value: next }); applyDigest(state, next); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return next;
  });
}
/** @param {string} stateDir @param {{envelopeId:string,result:'sent'|'unknown',messageId?:string,evidenceRef?:string}} result */
export async function finishSend(stateDir, result) {
  if (!result || typeof result !== 'object' || typeof result.envelopeId !== 'string' || !identifier.test(result.envelopeId) || !['sent', 'unknown'].includes(result.result)) throw new TypeError('digest result is invalid');
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.ledger.find(({ id }) => id === result.envelopeId);
    if (!current || !['sending', 'unknown'].includes(current.state)) throw new Error('digest envelope is unavailable');
    if (result.result === 'sent' && (typeof result.messageId !== 'string' || typeof result.evidenceRef !== 'string' || !identifier.test(result.messageId) || !identifier.test(result.evidenceRef))) throw new TypeError('digest sent evidence is invalid');
    const next = result.result === 'sent' ? { ...current, state: 'sent', messageId: result.messageId, evidenceRef: result.evidenceRef } : { ...current, state: 'unknown' };
    await addJournal(stateDir, { type: 'digest', value: next }); applyDigest(state, next); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return next;
  });
}
/** Sends only through an injected Gmail adapter after recording durable intent. */
export async function sendDigest(stateDir, envelope, { send }) {
  if (typeof send !== 'function') throw new TypeError('Gmail send adapter is required');
  const request = gmailSendRequest(envelope);
  const current = await beginSend(stateDir, envelope.id);
  if (current.to !== envelope.to || current.subject !== envelope.subject || current.contentHash !== envelope.contentHash || current.snapshotHash !== envelope.snapshotHash) return finishSend(stateDir, { envelopeId: envelope.id, result: 'unknown' });
  let result;
  try { result = await send(request); } catch { return finishSend(stateDir, { envelopeId: envelope.id, result: 'unknown' }); }
  const { id, thread_id: threadId } = result?.structuredContent ?? {};
  if (typeof id !== 'string' || typeof threadId !== 'string' || !identifier.test(id) || !identifier.test(threadId)) return finishSend(stateDir, { envelopeId: envelope.id, result: 'unknown' });
  return finishSend(stateDir, { envelopeId: envelope.id, result: 'sent', messageId: id, evidenceRef: `gmail:${id}:${threadId}` });
}
/** @param {string} stateDir @param {unknown[]} values */
export async function recordCandidates(stateDir, values) {
  if (!Array.isArray(values)) throw new TypeError('candidates must be an array');
  for (const value of values) validateCandidate(value);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending');
    for (const value of values) {
      const existing = state.candidates.find((item) => item.id === value.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('candidate identity conflict');
      if (!existing) { await addJournal(stateDir, { type: 'candidate', value }); addCandidate(state, value); }
    }
    state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.candidates;
  });
}
/** @param {string} stateDir @param {{candidateId:string,expectedVersion:number,candidate:unknown,manifest:unknown}} change */
export async function recordStagedCandidate(stateDir, change) {
  if (!change || typeof change !== 'object' || Object.keys(change).sort().join(',') !== 'candidate,candidateId,expectedVersion,manifest') throw new TypeError('staged candidate change is invalid');
  validateCandidate(change.candidate); addManifest(initialState(), change.manifest);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.candidates.find((item) => item.id === change.candidateId);
    if (!current || current.version !== change.expectedVersion || change.candidate.id !== current.id || change.candidate.version !== current.version + 1 || change.manifest.candidateId !== current.id) throw new Error('staged candidate version conflict');
    const existingManifest = state.manifests.find((item) => item.id === change.manifest.id);
    if (existingManifest && JSON.stringify(existingManifest) !== JSON.stringify(change.manifest)) throw new Error('manifest identity conflict');
    const entry = { type: 'stage', ...change }; await addJournal(stateDir, entry); applyStage(state, entry); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.candidates.find((item) => item.id === change.candidateId);
  });
}
/** @param {string} stateDir @param {unknown[]} values */
export async function recordSuggestions(stateDir, values) {
  if (!Array.isArray(values)) throw new TypeError('suggestions must be an array');
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending');
    for (const value of values) { validateSuggestion(value, { eventIds: state.events.map((item) => item.id), events: state.events }); await addJournal(stateDir, { type: 'suggestion', value }); addSuggestion(state, value); }
    state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.suggestions ?? [];
  });
}
/** @param {string} stateDir @param {unknown[]} values */
export async function recordPatterns(stateDir, values) {
  if (!Array.isArray(values)) throw new TypeError('patterns must be an array');
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending');
    for (const value of values) {
      addPattern({ ...state, patterns: [] }, value); const existing = state.patterns.find((item) => item.key === value.key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('pattern identity conflict');
      if (!existing) { await addJournal(stateDir, { type: 'pattern', value }); addPattern(state, value); }
    }
    state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.patterns;
  });
}
/** @param {string} stateDir @param {unknown} value */
export async function recordManifest(stateDir, value) {
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); addManifest({ ...state, manifests: [] }, value);
    const existing = state.manifests.find((item) => item.id === value.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('manifest identity conflict');
    if (!existing) { await addJournal(stateDir, { type: 'manifest', value }); addManifest(state, value); }
    state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.manifests.find((item) => item.id === value.id);
  });
}
/** @param {string} stateDir @param {{candidateId:string,expectedVersion:number,event:{previousStatus:string,status:string,at:string,reason:string,host?:string}}} change */
export async function recordTransition(stateDir, change) {
  validateTransition(change);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.candidates.find((item) => item.id === change.candidateId);
    if (!current) throw new Error('candidate not found'); validateCandidate(current); if (current.version !== change.expectedVersion) throw new Error('candidate version conflict'); if (current.status !== change.event.previousStatus) throw new Error('candidate status conflict');
    validateCandidate({ ...current, status: change.event.status, version: current.version + 1 });
    const entry = { type: 'transition', ...change }; await addJournal(stateDir, entry); applyTransition(state, entry); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.candidates.find((item) => item.id === change.candidateId);
  });
}
/** Rejects a candidate with a closed reason and an auditable tombstone. */
export async function rejectCandidate(stateDir, value) {
  validateRejection(value);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.candidates.find((item) => item.id === value.candidateId);
    if (!current || current.version !== value.expectedVersion || !['candidate', 'pending'].includes(current.status)) throw new Error('candidate rejection conflict');
    await addJournal(stateDir, { type: 'rejection', value }); applyRejection(state, value); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); return state.candidates.find((item) => item.id === value.candidateId);
  });
}
/** @param {string} stateDir @param {unknown} value */
export async function recordValidationReceipt(stateDir, value) {
  validateReceipt(value);
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const existing = state.receipts[value.id];
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('validation receipt identity conflict');
    if (!existing) { await addJournal(stateDir, { type: 'receipt', value }); applyReceipt(state, value); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state); }
    return state.receipts[value.id];
  });
}
/** Runs one trusted application callback while the state lock covers intent, effects, and checkpoints. */
export async function withApplicationIntent(stateDir, value, execute) {
  exact(value, ['applicationId', 'candidateId', 'receiptId'], 'application intent');
  if (!identifier.test(value.applicationId) || !identifier.test(value.candidateId) || !identifier.test(value.receiptId) || typeof execute !== 'function') throw new TypeError('application intent is invalid');
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); if (state.pending) throw new Error('journal corruption pending'); const current = state.candidates.find((item) => item.id === value.candidateId);
    const receipt = state.receipts[value.receiptId];
    if (!current || !receipt || receipt.candidateId !== current.id) throw new Error('application version conflict');
    const existing = state.applications.find(({ id }) => id === value.applicationId);
    if (existing && (existing.candidateId !== value.candidateId || existing.receiptId !== value.receiptId)) throw new Error('application identity conflict');
    const application = structuredClone(existing ?? { id: value.applicationId, candidateId: value.candidateId, receiptId: value.receiptId, entries: [], updatedAt: new Date().toISOString() });
    const checkpoint = async ({ application: next, transition = null, supersedes = [] }) => {
      validateApplication(next);
      if (next.id !== value.applicationId || next.candidateId !== value.candidateId || next.receiptId !== value.receiptId) throw new Error('application identity conflict');
      if (transition !== null) {
        validateTransition(transition); const candidate = state.candidates.find((item) => item.id === value.candidateId);
        if (!candidate || candidate.version !== transition.expectedVersion || candidate.status !== transition.event.previousStatus) throw new Error('application version conflict');
        validateCandidate({ ...candidate, status: transition.event.status, version: candidate.version + 1 });
      }
      const entry = { type: 'application', value: structuredClone(next), transition, supersedes: [...supersedes] };
      await addJournal(stateDir, entry); applyApplication(state, entry); state.cursors.import = (await journal(stateDir)).bytes; await snapshot(stateDir, state);
      return { candidate: structuredClone(state.candidates.find((item) => item.id === value.candidateId)), application: structuredClone(state.applications.find(({ id }) => id === value.applicationId)), hostStates: structuredClone(state.hostStates[value.candidateId]?.[value.receiptId] ?? {}) };
    };
    return execute({ candidate: structuredClone(current), receipt: structuredClone(receipt), application, applications: structuredClone(state.applications), checkpoint });
  });
}
/** @param {string} stateDir @param {string} now */
export async function pruneState(stateDir, now) {
  const nowMs = Date.parse(now); if (typeof now !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now) || Number.isNaN(nowMs) || new Date(nowMs).toISOString() !== now) throw new TypeError('now must be ISO UTC');
  return withStateLock(stateDir, async () => {
    const state = await loadUnlocked(stateDir); const preservedManifests = state.manifests.filter((item) => item.active).map((item) => item.id);
    if (state.pending) return { removedEvents: 0, removedEvidence: 0, preservedManifests, pending: state.pending };
    const log = await journal(stateDir); const age = (date) => nowMs - Date.parse(date); const beforeEvents = state.events.length; const beforeSources = state.sources.length;
    const expiredEventIds = new Set(state.events.filter((item) => age(item.occurredAt) > 90 * day).map((item) => item.id)); const expired = new Set();
    const expiredSourceLocators = new Set(state.sources.filter((item) => age(item.occurredAt) > 90 * day).map((item) => item.locator));
    for (const manifest of state.manifests) if (manifest.backupRef && (age(manifest.createdAt) > 180 * day || (!manifest.active && manifest.deactivatedAt && age(manifest.deactivatedAt) > 90 * day))) expired.add(manifest.backupRef);
    const journalApplicationBackups = new Set(log.entries.flatMap((entry) => entry.type === 'application' ? entry.value.entries.filter(({ backup }) => backup !== null).map(({ id }) => id) : []));
    const expiredApplicationBackups = new Set();
    for (const application of state.applications) for (const entry of application.entries) {
      if (entry.backup === null) { if (journalApplicationBackups.has(entry.id)) expiredApplicationBackups.add(entry.id); continue; }
      if (age(entry.backupCreatedAt) > 180 * day || (typeof entry.deactivatedAt === 'string' && age(entry.deactivatedAt) > 90 * day)) expiredApplicationBackups.add(entry.id);
    }
    const beforeEvidence = Array.isArray(state.evidence) ? state.evidence.length : 0;
    await snapshot(stateDir, state);
    const retainedJournal = log.entries.filter((entry) => (entry.type !== 'event' || !expiredEventIds.has(entry.value.id)) && (entry.type !== 'source' || !expiredSourceLocators.has(entry.value.locator))).map((entry) => {
      if (entry.type !== 'application') return entry;
      const copy = structuredClone(entry);
      for (const item of copy.value.entries) if (expiredApplicationBackups.has(item.id)) item.backup = null;
      return copy;
    });
    await atomicText(await contained(stateDir, names.journal), retainedJournal.length === 0 ? '' : `${retainedJournal.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    for (const eventId of expiredEventIds) await rm(await contained(stateDir, 'signals', signalName(eventId)), { force: true });
    state.events = state.events.filter((item) => !expiredEventIds.has(item.id));
    state.sources = state.sources.filter((item) => !expiredSourceLocators.has(item.locator));
    if (Array.isArray(state.evidence)) state.evidence = state.evidence.filter((item) => !expired.has(item.id));
    for (const application of state.applications) for (const entry of application.entries) if (expiredApplicationBackups.has(entry.id)) entry.backup = null;
    await snapshot(stateDir, state);
    return { removedEvents: beforeEvents - state.events.length, removedSources: beforeSources - state.sources.length, removedEvidence: beforeEvidence - (state.evidence?.length ?? 0) + expiredApplicationBackups.size, preservedManifests: state.manifests.filter((item) => item.active).map((item) => item.id), ...(state.pending ? { pending: state.pending } : {}) };
  });
}
