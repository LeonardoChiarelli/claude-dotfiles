/** @typedef {{version:1,id:string,host:'codex'|'claude'|'cursor'|'grok',session:string,originEventId:string,occurredAt:string,scope:{kind:'global'|'repo',repo?:string},locator:string,kind:'request'|'correction',provenance:'verified'|'uncertain'}} Event */
/** @typedef {{patternKey:string,summary:string,scope:Event['scope'],supportEventIds:string[],correctionEventIds:string[],contradicts:string[],artifactKind:'skill'|'hook'|'agents'|'mcp',diagnosis:string}} Suggestion */
/** @typedef {{id:string,patternKey:string,scope:Event['scope'],artifactKind:Suggestion['artifactKind'],status:'candidate'|'pending'|'rejected'|'local_applied'|'synced'|'merged'|'remote_active'|'rolled_back',sourceEventIds:string[],baselineHash:string|null,diffHash:string|null,policyVersion:string,version:number}} Candidate */

const eventKeys = ['version', 'id', 'host', 'session', 'originEventId', 'occurredAt', 'scope', 'locator', 'kind', 'provenance'];
const suggestionKeys = ['patternKey', 'summary', 'scope', 'supportEventIds', 'correctionEventIds', 'contradicts', 'artifactKind', 'diagnosis'];
const candidateKeys = ['id', 'patternKey', 'scope', 'artifactKind', 'status', 'sourceEventIds', 'baselineHash', 'diffHash', 'policyVersion', 'version'];
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash = /^[a-f0-9]{64}$/;
const diagnoses = ['recurso inexistente', 'falha de carregamento', 'regra não executada', 'instrução ambígua', 'necessidade específica de projeto'];
const sensitive = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,
  /\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-\s]?\d{4}\b/,
  /(?:^|[\s,{])["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|token|secret|password)["']?\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,;}]+)/i,
  /\b(?:Bearer\s+|sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/i,
  /\b(?:DATABASE_URL|AWS_ACCESS_KEY_ID|STRIPE(?:_SECRET)?_KEY|PRIVATE_KEY)\s*[:=]\s*\S+/i,
  /(?:^|[\s,{])["']?[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL)["']?\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,;}]+)/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk_live_[A-Za-z0-9_]+\b/i,
];

/** Conservative denylist for known credential and PII forms. It is not a universal secret detector. */
export function containsSensitive(value) { return typeof value === 'string' && sensitive.some((pattern) => pattern.test(value)); }

function record(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name} extra key: ${key}`);
  for (const key of keys) if (!(key in value)) throw new TypeError(`${name} missing key: ${key}`);
}
function text(value, name) { if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new TypeError(`${name} must be a bounded string`); return value; }
function safeText(value, name) { text(value, name); if (containsSensitive(value)) throw new TypeError(`${name} contains sensitive data`); return value; }
function id(value, name) { if (!identifier.test(text(value, name))) throw new TypeError(`${name} must be an identifier`); return value; }
function iso(value, name) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError(`${name} must be ISO UTC`); return value; }
function scope(value) {
  record(value, value?.kind === 'repo' ? ['kind', 'repo'] : ['kind'], 'scope');
  if (value.kind !== 'global' && value.kind !== 'repo') throw new TypeError('scope kind is invalid');
  if (value.kind === 'repo') id(value.repo, 'scope.repo');
  return value;
}
function stringList(value, name, maxItems = 32) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(`${name} must be strings`);
  if (maxItems !== null && value.length > maxItems) throw new TypeError(`${name} must be bounded`);
  if (new Set(value).size !== value.length) throw new TypeError(`${name} must be unique`);
  return value;
}
function identifierList(value, name, maxItems) { return stringList(value, name, maxItems).map((item) => id(item, name)); }

/** @param {unknown} value @returns {Event} */
export function validateEvent(value) {
  record(value, eventKeys, 'event');
  if (value.version !== 1) throw new TypeError('event version is invalid');
  id(value.id, 'event.id');
  if (!['codex', 'claude', 'cursor', 'grok'].includes(value.host)) throw new TypeError('event host is invalid');
  id(value.session, 'event.session'); id(value.originEventId, 'event.originEventId'); iso(value.occurredAt, 'event.occurredAt'); scope(value.scope); text(value.locator, 'event.locator');
  if (!value.locator.startsWith(`${value.host}://`) || /\s/.test(value.locator)) throw new TypeError('event locator is invalid');
  if (!['request', 'correction'].includes(value.kind)) throw new TypeError('event kind is invalid');
  if (!['verified', 'uncertain'].includes(value.provenance)) throw new TypeError('event provenance is invalid');
  return /** @type {Event} */ (value);
}
/** @param {unknown} value @param {{eventIds:string[]}} context @returns {Suggestion} */
export function validateSuggestion(value, context) {
  const keys = context?.events === undefined ? ['eventIds', 'knownPatternKeys'] : ['eventIds', 'events', 'knownPatternKeys'];
  record(context, context?.knownPatternKeys === undefined ? keys.filter((key) => key !== 'knownPatternKeys') : keys, 'suggestion context'); const eventIds = identifierList(context.eventIds, 'suggestion context.eventIds', null);
  record(value, suggestionKeys, 'suggestion'); id(value.patternKey, 'suggestion.patternKey'); safeText(value.summary, 'suggestion.summary'); scope(value.scope);
  const support = identifierList(value.supportEventIds, 'suggestion.supportEventIds');
  if (support.length === 0 || support.some((item) => !eventIds.includes(item))) throw new TypeError('suggestion supportEventIds must belong to eventIds');
  const corrections = identifierList(value.correctionEventIds, 'suggestion.correctionEventIds');
  if (corrections.some((item) => !support.includes(item))) throw new TypeError('suggestion correctionEventIds must be supported');
  if (context.events !== undefined) {
    if (!Array.isArray(context.events)) throw new TypeError('suggestion context.events must be an array');
    const byId = new Map(context.events.map((event) => [validateEvent(event).id, event]));
    if (corrections.some((item) => byId.get(item)?.provenance !== 'verified')) throw new TypeError('suggestion correctionEventIds must have verified provenance');
  }
  const contradicts = stringList(value.contradicts, 'suggestion.contradicts').map((item) => id(item, 'suggestion.contradicts'));
  if (context.knownPatternKeys !== undefined) {
    const known = identifierList(context.knownPatternKeys, 'suggestion context.knownPatternKeys', null);
    if (contradicts.some((item) => !known.includes(item))) throw new TypeError('suggestion contradicts must belong to known patterns');
  }
  if (!['skill', 'hook', 'agents', 'mcp'].includes(value.artifactKind)) throw new TypeError('suggestion artifactKind is invalid');
  if (!diagnoses.includes(value.diagnosis)) throw new TypeError('suggestion diagnosis is invalid'); safeText(value.diagnosis, 'suggestion.diagnosis');
  return /** @type {Suggestion} */ (value);
}
/** @param {unknown} value @returns {Candidate} */
export function validateCandidate(value) {
  record(value, candidateKeys, 'candidate'); id(value.id, 'candidate.id'); id(value.patternKey, 'candidate.patternKey'); scope(value.scope);
  if (!['skill', 'hook', 'agents', 'mcp'].includes(value.artifactKind)) throw new TypeError('candidate artifactKind is invalid');
  const statuses = ['candidate', 'pending', 'rejected', 'local_applied', 'synced', 'merged', 'remote_active', 'rolled_back'];
  if (!statuses.includes(value.status)) throw new TypeError('candidate status is invalid');
  if (identifierList(value.sourceEventIds, 'candidate.sourceEventIds').length === 0) throw new TypeError('candidate sourceEventIds is required');
  const bothNull = value.baselineHash === null && value.diffHash === null;
  if ((!bothNull && (!hash.test(value.baselineHash) || !hash.test(value.diffHash))) || (bothNull && !['candidate', 'pending', 'rejected'].includes(value.status))) throw new TypeError('candidate hashes are invalid for status');
  text(value.policyVersion, 'candidate.policyVersion'); if (!Number.isSafeInteger(value.version) || value.version < 0) throw new TypeError('candidate version is invalid');
  return /** @type {Candidate} */ (value);
}
