import { createHash } from 'node:crypto';

import { validateCandidate, validateEvent, validateSuggestion } from './contracts.mjs';

const day = 24 * 60 * 60 * 1000;
const candidateId = (patternKey, ids) => `c-${createHash('sha256').update(`${patternKey}\0${ids.join('\0')}`).digest('hex').slice(0, 40)}`;
const recent = (value, now) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && Date.parse(now) - Date.parse(value) < 30 * day;
const artifactKinds = new Set(['skill', 'hook', 'agents', 'mcp']);
const hash = /^[a-f0-9]{64}$/;

function support(events, ids) { const byId = new Map(events.map((event) => [event.id, event])); return ids.map((id) => byId.get(id)).filter(Boolean); }
function independent(events) {
  const origins = new Set(); const sessions = new Set();
  for (const event of events) if (event.provenance === 'verified' && !origins.has(event.originEventId)) { origins.add(event.originEventId); sessions.add(event.session); }
  return { origins, sessions };
}
function sameScope(left, right) { return left?.kind === right?.kind && (left.kind === 'global' || repoKey(left.repo) === repoKey(right.repo)); }
const repoKey = (value) => value.toLowerCase();
function catalogEntry(value) {
  const keys = Object.keys(value ?? {}); const allowed = new Set(['hash', 'kind', 'path', 'scope', 'enabled', 'summary']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.some((key) => !allowed.has(key)) || !['hash', 'kind', 'path', 'scope'].every((key) => keys.includes(key)) || (value.enabled !== undefined && typeof value.enabled !== 'boolean' && value.enabled !== 'unknown') || (value.summary !== undefined && value.summary !== null && (typeof value.summary !== 'string' || value.summary.length === 0 || value.summary.length > 1024))) return null;
  if (typeof value.path !== 'string' || value.path.length === 0 || value.path.length > 512 || value.path.startsWith('/') || value.path.split(/[\\/]/).includes('..')) return null;
  if (!artifactKinds.has(value.kind) || !hash.test(value.hash)) return null;
  if (value.scope?.kind === 'global' && Object.keys(value.scope).length === 1) return value;
  if (value.scope?.kind === 'repo' && typeof value.scope.repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.scope.repo) && Object.keys(value.scope).length === 2) return value;
  return null;
}
function semanticTokens(value) {
  const stop = new Set(['para', 'como', 'uma', 'com', 'sem', 'dos', 'das', 'que', 'the', 'and', 'with', 'from']);
  return new Set(value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !stop.has(token)));
}
export function catalogRelation(catalog, suggestion, candidateScope) {
  const summary = semanticTokens(suggestion.summary); const identity = suggestion.patternKey.toLowerCase();
  return catalog.find((item) => {
    if (item.kind !== suggestion.artifactKind || !sameScope(item.scope, candidateScope) || typeof item.summary !== 'string') return false;
    const overlap = [...semanticTokens(item.summary)].filter((token) => summary.has(token)).length;
    const named = item.path.toLowerCase().split(/[\\/]/).some((segment) => segment === identity || segment.replace(/\.[^.]+$/, '') === identity);
    return overlap >= 2 || (named && overlap >= 1);
  });
}
const suggestionSignature = (suggestion) => JSON.stringify([suggestion.summary, suggestion.scope, suggestion.artifactKind, suggestion.diagnosis]);

/** Detects candidates only. It never writes files, creates diffs, or grants authority. */
export function proposeCandidates({ events, suggestions, patterns, catalog, tombstones, now }) {
  if (!Array.isArray(events) || !Array.isArray(suggestions) || !Array.isArray(patterns) || !Array.isArray(catalog) || !Array.isArray(tombstones) || typeof now !== 'string' || Number.isNaN(Date.parse(now))) return [];
  let known; let existing; try { known = events.map(validateEvent); existing = catalog.map(catalogEntry); } catch { return []; }
  if (existing.some((item) => item === null)) return [];
  const classified = suggestions.map((raw) => {
    try { return validateSuggestion(raw, { eventIds: known.map(({ id }) => id), events: known, knownPatternKeys: patterns.map(({ key }) => key) }); } catch { return null; }
  });
  const correctionSignatures = new Map();
  for (const suggestion of classified.filter(Boolean)) {
    if (suggestion.correctionEventIds.length === 0) continue;
    if (!correctionSignatures.has(suggestion.patternKey)) correctionSignatures.set(suggestion.patternKey, new Set());
    correctionSignatures.get(suggestion.patternKey).add(suggestionSignature(suggestion));
  }
  const grouped = new Map();
  for (const suggestion of classified.filter(Boolean)) {
    const key = JSON.stringify([suggestion.patternKey, suggestion.scope, suggestion.artifactKind]); const current = grouped.get(key);
    if (!current) grouped.set(key, structuredClone(suggestion));
    else {
      current.supportEventIds = [...new Set([...current.supportEventIds, ...suggestion.supportEventIds])];
      current.correctionEventIds = [...new Set([...current.correctionEventIds, ...suggestion.correctionEventIds])];
      current.contradicts = [...new Set([...current.contradicts, ...suggestion.contradicts])];
    }
  }
  const checkedSuggestions = [...grouped.values()];
  const candidates = []; const emittedConflicts = new Set();
  for (const suggestion of checkedSuggestions) {
    if (!suggestion) continue;
    const conflictingCorrections = (correctionSignatures.get(suggestion.patternKey)?.size ?? 0) > 1;
    if (conflictingCorrections && emittedConflicts.has(suggestion.patternKey)) continue;
    if (conflictingCorrections) emittedConflicts.add(suggestion.patternKey);
    if (tombstones.some((item) => item?.patternKey === suggestion.patternKey)) continue;
    if (patterns.some((item) => item?.key === suggestion.patternKey && item?.status === 'rejected' && recent(item.rejectedAt, now))) continue;
    const supportIds = conflictingCorrections
      ? [...new Set(classified.filter((item) => item?.patternKey === suggestion.patternKey).flatMap((item) => item.supportEventIds))]
      : suggestion.supportEventIds;
    const correctionIds = conflictingCorrections
      ? [...new Set(classified.filter((item) => item?.patternKey === suggestion.patternKey).flatMap((item) => item.correctionEventIds))]
      : suggestion.correctionEventIds;
    const source = support(known, supportIds); const { origins, sessions } = independent(source);
    const corrections = source.filter((event) => correctionIds.includes(event.id) && event.provenance === 'verified');
    const correctionSessions = new Set(corrections.map(({ session }) => session));
    if (sessions.size < 3 && correctionSessions.size < 2) continue;
    const verified = source.filter(({ provenance }) => provenance === 'verified');
    const repositories = new Map(verified.filter(({ scope }) => scope.kind === 'repo').map(({ scope }) => [repoKey(scope.repo), scope.repo]));
    const globalSessions = new Set(verified.filter(({ scope }) => scope.kind === 'global').map(({ session }) => session));
    const candidateScope = repositories.size === 1 ? { kind: 'repo', repo: repositories.values().next().value } : { kind: 'global' };
    const existingArtifact = catalogRelation(existing, suggestion, candidateScope);
    const catalogConflict = Boolean(existingArtifact) && suggestion.diagnosis === 'recurso inexistente';
    const missingCatalogTarget = !existingArtifact && ['falha de carregamento', 'regra não executada'].includes(suggestion.diagnosis);
    const staleInference = correctionSignatures.has(suggestion.patternKey) && !correctionSignatures.get(suggestion.patternKey).has(suggestionSignature(suggestion));
    const unverifiedScope = repositories.size === 0 && globalSessions.size < 3;
    const pending = suggestion.contradicts.length > 0 || conflictingCorrections || staleInference || catalogConflict || missingCatalogTarget || unverifiedScope || (existingArtifact && existingArtifact.enabled !== true);
    const value = { id: candidateId(suggestion.patternKey, [...origins].sort()), patternKey: suggestion.patternKey, scope: candidateScope, artifactKind: suggestion.artifactKind, status: pending ? 'pending' : 'candidate', sourceEventIds: [...new Set(source.map(({ id }) => id))], baselineHash: null, diffHash: null, policyVersion: '1', version: 0 };
    try { candidates.push(validateCandidate(value)); } catch { /* invalid evidence cannot become a candidate */ }
  }
  return candidates;
}
