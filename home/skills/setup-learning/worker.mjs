import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { catalogArtifacts, discoverHistoryRoots } from './adapters.mjs';
import { analyzeBatch, createClaudeRunner } from './analyze.mjs';
import { readSnippet, scanHistory as scanNativeHistory } from './history.mjs';
import { catalogRelation, proposeCandidates } from './learning.mjs';
import { loadState, recordAnalysis, recordCandidates, recordWorkerProgress, releaseTerminalWorkerHandoff, withWorkerLease } from './state.mjs';

const capability = new Set(['available', 'pending']);
const maxCycleMs = 20 * 60 * 1000;
const terminalCandidateStatuses = new Set(['rejected', 'local_applied', 'synced', 'merged', 'remote_active', 'rolled_back']);
const historyHosts = ['codex', 'claude', 'cursor', 'grok'];

function validCapabilities(value) { return value && typeof value === 'object' && ['scheduler', 'gmail', 'claudeCli', 'grok'].every((key) => capability.has(value[key])); }
function isoMs(value, name) {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) throw new TypeError(`${name} must be ISO UTC`);
  return parsed;
}
function clock(now, deadline) {
  const startedAt = isoMs(now(), 'worker now'); const requestedDeadline = isoMs(deadline, 'worker deadline'); let observedAt = startedAt;
  const effectiveDeadline = Math.min(requestedDeadline, startedAt + maxCycleMs);
  return { started: new Date(startedAt).toISOString(), remaining() { observedAt = Math.max(observedAt, isoMs(now(), 'worker now')); return Math.max(0, effectiveDeadline - observedAt); } };
}
function result(status, reason, capabilities, extra = {}) { return { status, reason, capabilities, ...extra }; }
function handoffRequest(candidate, requestedAt, state, catalog) {
  const suggestion = [...(state.suggestions ?? [])].reverse().find(({ patternKey }) => patternKey === candidate.patternKey); const relation = suggestion && catalogRelation(catalog, suggestion, candidate.scope);
  return { candidateId: candidate.id, status: 'prepared', requestedAt, action: 'start-delivery', skill: 'entrega', artifactKind: candidate.artifactKind, patternKey: candidate.patternKey, scope: candidate.scope, summary: suggestion?.summary ?? null, diagnosis: suggestion?.diagnosis ?? null, catalog: relation ? { path: relation.path, hash: relation.hash, enabled: relation.enabled ?? true } : null };
}
function patternEvidence(suggestion, events, fallbackAt) {
  const byId = new Map(events.map((event) => [event.id, event]));
  const at = [...suggestion.correctionEventIds, ...suggestion.supportEventIds].map((id) => byId.get(id)?.occurredAt).filter(Boolean).sort().at(-1) ?? fallbackAt;
  return { key: suggestion.patternKey, scope: suggestion.scope, supportEventIds: suggestion.supportEventIds, correctionEventIds: suggestion.correctionEventIds, contradicts: suggestion.contradicts, lastHumanCorrectionAt: at };
}
function knownPatterns(state) {
  return state.patterns.map((pattern) => {
    const suggestion = [...(state.suggestions ?? [])].reverse().find(({ patternKey }) => patternKey === pattern.key); const candidate = state.candidates.find(({ patternKey }) => patternKey === pattern.key);
    return { patternKey: pattern.key, scope: pattern.scope, artifactKind: suggestion?.artifactKind ?? candidate?.artifactKind ?? 'skill', status: candidate?.status ?? 'pending', summary: suggestion?.summary ?? 'Padrão generalizado registrado.' };
  });
}
function diagnosticReason(diagnostic) { return diagnostic ? `analysis_${diagnostic.stage}_${diagnostic.subtype}` : 'analysis_pending'; }
function fairHistoryRoots(roots, after) {
  const groups = new Map(historyHosts.map((host) => [host, []]));
  const invalid = [];
  for (const root of roots) { if (groups.has(root?.host)) groups.get(root.host).push(root); else invalid.push(root); }
  for (const group of groups.values()) group.sort((left, right) => String(left.locator).localeCompare(String(right.locator)));
  const ordered = []; const maxRootsPerHost = Math.max(0, ...[...groups.values()].map((group) => group.length));
  for (let index = 0; index < maxRootsPerHost; index += 1) {
    for (const host of historyHosts) if (groups.get(host)[index]) ordered.push(groups.get(host)[index]);
  }
  ordered.push(...invalid);
  const previous = ordered.findIndex(({ locator }) => locator === after);
  return previous < 0 ? ordered : [...ordered.slice(previous + 1), ...ordered.slice(0, previous + 1)];
}

/** Fixed production dependencies. Connectors remain controller actions, never model-provided functions or commands. */
export function createNativeWorkerDependencies({ home = homedir(), runner = createClaudeRunner() } = {}) {
  let descriptors = {};
  return {
    roots: async (sources) => { const roots = await discoverHistoryRoots(home, sources); descriptors = Object.fromEntries(roots.map(({ locator, path, root }) => [locator, { path, root }])); return roots; },
    scanHistory: async (input) => {
      const cursor = input.roots.filter(({ host }) => host === 'cursor');
      const result = await scanNativeHistory({ ...input, home, roots: input.roots.filter(({ host }) => host !== 'cursor') });
      return { ...result, pending: [...result.pending, ...cursor.map(({ locator }) => ({ locator, reason: 'cursor_timestamp_uncertain' }))] };
    },
    readSnippet: (event) => readSnippet(event, descriptors, home),
    analyzeBatch: (input) => analyzeBatch({ ...input, runner }),
    catalog: (inventory) => catalogArtifacts(home, inventory),
    proposeCandidates,
    isIdle: async () => null,
    handoff: async () => { throw new Error('native controller handoff is required'); },
  };
}

export async function loadCapabilityEvidence(stateDir) {
  const raw = JSON.parse(await readFile(new URL('./references/host-capabilities.json', import.meta.url), 'utf8'));
  if (!validCapabilities(raw?.capabilities)) throw new TypeError('capability evidence is invalid');
  const state = await loadState(stateDir); const result = structuredClone(raw.capabilities);
  for (const [name, evidence] of Object.entries(state.capabilities ?? {})) if (Object.hasOwn(result, name) && capability.has(evidence?.status)) result[name] = evidence.status;
  return result;
}

async function cycle({ stateDir, budget, capabilities, dependencies }) {
  await releaseTerminalWorkerHandoff(stateDir);
  let state = await loadState(stateDir); const pending = [];
  if (budget.remaining() === 0) return result('pending', 'budget', capabilities);
  const roots = await dependencies.roots(state.sources);
  if (!Array.isArray(roots)) throw new TypeError('worker roots are invalid');
  const scanRoots = fairHistoryRoots(roots, state.worker.historyAfter);
  const cursors = Object.fromEntries(roots.map(({ path, locator }) => [path, state.worker.imports[locator] ?? '0']));
  const imported = await dependencies.scanHistory({ roots: scanRoots, cursors, budget: { bytes: 8 * 1024 * 1024, lines: 10_000 }, stateDir });
  const imports = { ...state.worker.imports };
  for (const root of roots) if (Object.hasOwn(imported.nextCursors ?? {}, root.path)) imports[root.locator] = imported.nextCursors[root.path];
  const historyAfter = scanRoots.some(({ locator }) => locator === imported.lastVisited) ? imported.lastVisited : state.worker.historyAfter;
  pending.push(...(imported.pending ?? []));
  await recordWorkerProgress(stateDir, { imports, analyzedEventIds: state.worker.analyzedEventIds, handoff: state.worker.handoff, historyAfter });
  if (budget.remaining() === 0) return result('pending', 'budget', capabilities, { pending });

  state = await loadState(stateDir);
  const backlog = state.events.filter(({ id }) => !state.worker.analyzedEventIds.includes(id));
  let analyzed = { suggestions: [], processedIds: [], nonprocessedIds: [], diagnostic: null };
  if (backlog.length > 0) {
    const timeoutMs = Math.min(120_000, budget.remaining());
    if (timeoutMs === 0) return result('pending', 'budget', capabilities, { pending });
    analyzed = await dependencies.analyzeBatch({ events: backlog, readSnippet: dependencies.readSnippet, knownPatterns: knownPatterns(state), timeoutMs });
    const processed = [...new Set([...state.worker.analyzedEventIds, ...(analyzed.processedIds ?? [])])];
    await recordAnalysis(stateDir, { suggestions: analyzed.suggestions ?? [], patterns: (analyzed.suggestions ?? []).map((suggestion) => patternEvidence(suggestion, state.events, budget.started)), worker: { imports, analyzedEventIds: processed, handoff: state.worker.handoff, historyAfter } });
  }
  state = await loadState(stateDir);
  const remainingBacklog = state.events.filter(({ id }) => !state.worker.analyzedEventIds.includes(id));
  const partialReasons = [];
  if (imported.historyBacklog === true) partialReasons.push('history_backlog');
  if (pending.length > 0) partialReasons.push('import_pending');
  if (analyzed.diagnostic) partialReasons.push(diagnosticReason(analyzed.diagnostic));
  else if ((analyzed.nonprocessedIds?.length ?? 0) > 0 || remainingBacklog.length > 0) partialReasons.push('analysis_pending');
  if (budget.remaining() === 0) return result('pending', 'budget', capabilities, { pending });

  const catalog = await dependencies.catalog(state.skillInventory);
  if (budget.remaining() === 0) return result('pending', 'budget', capabilities, { pending });
  const proposed = await dependencies.proposeCandidates({ events: state.events, suggestions: state.suggestions ?? [], patterns: state.patterns, catalog, tombstones: state.tombstones, now: budget.started });
  if (budget.remaining() === 0) return result('pending', 'budget', capabilities, { pending });
  const existingHandoff = state.worker.handoff && state.candidates.find(({ id }) => id === state.worker.handoff.candidateId);
  if (state.worker.handoff && !existingHandoff) return result('pending', 'handoff_missing', capabilities, { candidateId: state.worker.handoff.candidateId, pendingReasons: partialReasons, pending });
  if (state.worker.handoff?.status === 'handed_off') return result('pending', 'handoff_in_progress', capabilities, { candidateId: existingHandoff.id, handoff: { candidateId: existingHandoff.id, status: 'handed_off', evidenceRef: state.worker.handoff.evidenceRef }, pendingReasons: partialReasons, pending });
  const recordedIds = new Set(state.candidates.map(({ id }) => id));
  const candidate = existingHandoff?.status === 'candidate'
    ? existingHandoff
    : proposed.find((item) => !recordedIds.has(item.id) && eligibleCandidate(item, state)) ?? null;
  if (!candidate) return result(partialReasons.length > 0 ? 'pending' : 'complete', partialReasons.length > 0 ? 'partial' : null, capabilities, { candidateId: null, processedIds: analyzed.processedIds ?? [], nonprocessedIds: remainingBacklog.map(({ id }) => id), diagnostic: analyzed.diagnostic ?? null, pendingReasons: partialReasons, pending });
  if (!state.candidates.some(({ id }) => id === candidate.id)) await recordCandidates(stateDir, [candidate]);
  if (candidate.status === 'pending') return result('pending', 'candidate_pending', capabilities, { candidateId: candidate.id, processedIds: analyzed.processedIds ?? [], nonprocessedIds: remainingBacklog.map(({ id }) => id), diagnostic: analyzed.diagnostic ?? null, pendingReasons: [...partialReasons, 'candidate_pending'], pending });
  if (budget.remaining() === 0) return result('pending', 'budget', capabilities, { candidateId: candidate.id, pending });
  state = await loadState(stateDir);
  const prepared = state.worker.handoff ?? { candidateId: candidate.id, status: 'prepared', requestedAt: budget.started, evidenceRef: null };
  await recordWorkerProgress(stateDir, { ...state.worker, handoff: prepared });
  const request = handoffRequest(candidate, prepared.requestedAt, state, catalog); const idle = await dependencies.isIdle();
  if (idle !== true) return result('pending', partialReasons.length > 0 ? 'partial' : (idle === false ? 'active-session' : 'controller'), capabilities, { candidateId: candidate.id, handoff: request, processedIds: analyzed.processedIds ?? [], nonprocessedIds: remainingBacklog.map(({ id }) => id), diagnostic: analyzed.diagnostic ?? null, pendingReasons: [...partialReasons, idle === false ? 'active-session' : 'controller'], pending });
  if (budget.remaining() === 0) return result('pending', 'budget', capabilities, { candidateId: candidate.id, handoff: request, pending });
  const handoff = await dependencies.handoff(candidate);
  if (!handoff || handoff.candidateId !== candidate.id || handoff.status !== 'prepared' || typeof handoff.evidenceRef !== 'string') return result('pending', 'handoff', capabilities, { candidateId: candidate.id, handoff: request, pending });
  state = await loadState(stateDir); await recordWorkerProgress(stateDir, { ...state.worker, handoff: { ...state.worker.handoff, status: 'handed_off', evidenceRef: handoff.evidenceRef } });
  return result(partialReasons.length > 0 ? 'pending' : 'complete', partialReasons.length > 0 ? 'partial' : null, capabilities, { candidateId: candidate.id, handoff, processedIds: analyzed.processedIds ?? [], nonprocessedIds: remainingBacklog.map(({ id }) => id), diagnostic: analyzed.diagnostic ?? null, pendingReasons: partialReasons, pending });
}

function eligibleCandidate(candidate, state) {
  const prior = state.candidates.filter((item) => item.patternKey === candidate.patternKey && terminalCandidateStatuses.has(item.status));
  if (prior.length === 0) return true;
  if (prior.some(({ status }) => ['rejected', 'rolled_back'].includes(status)) || prior.some(({ id }) => id === candidate.id)) return false;
  const appliedIds = new Set(prior.filter(({ status }) => ['local_applied', 'synced', 'merged', 'remote_active'].includes(status)).map(({ id }) => id));
  const lastAppliedAt = state.applications.filter(({ candidateId }) => appliedIds.has(candidateId)).map(({ updatedAt }) => updatedAt).sort().at(-1);
  if (!lastAppliedAt) return false;
  const byId = new Map(state.events.map((event) => [event.id, event]));
  const relevant = (state.suggestions ?? []).filter(({ patternKey }) => patternKey === candidate.patternKey);
  if (relevant.some(({ contradicts }) => contradicts.length > 0)) return false;
  return relevant.some(({ correctionEventIds }) => correctionEventIds.some((id) => {
    const event = byId.get(id);
    return candidate.sourceEventIds.includes(id) && event?.provenance === 'verified' && Date.parse(event.occurredAt) > Date.parse(lastAppliedAt);
  }));
}

/** Runs one bounded analysis cycle with a separate worker lease and short state transactions. */
export async function runWorker({ stateDir, now, deadline, capabilities, dependencies, mode = 'scheduled' }) {
  if (typeof stateDir !== 'string' || typeof now !== 'function' || typeof deadline !== 'string' || !validCapabilities(capabilities) || !dependencies || !['scheduled', 'manual'].includes(mode)) throw new TypeError('worker input is invalid');
  for (const name of ['roots', 'scanHistory', 'readSnippet', 'analyzeBatch', 'catalog', 'proposeCandidates', 'isIdle', 'handoff']) if (typeof dependencies[name] !== 'function') throw new TypeError(`worker dependency ${name} is invalid`);
  const budget = clock(now, deadline);
  if (budget.remaining() === 0) return result('pending', 'budget', capabilities);
  if (mode === 'scheduled' && capabilities.scheduler !== 'available') return result('pending', 'scheduler', capabilities);
  const leased = await withWorkerLease(stateDir, () => cycle({ stateDir, budget, capabilities: { ...capabilities }, dependencies }));
  return leased.acquired ? leased.result : result('pending', 'concurrent-worker', capabilities);
}
