import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { appendEvent } from './state.mjs';
import { containsSensitive } from './contracts.mjs';

const external = /<DADOS_EXTERNOS>[\s\S]*?<\/DADOS_EXTERNOS>/gi;
const injected = /<(INSTRUCTIONS|user_instructions|skills_instructions|environment_context|tools_instructions|system_context|command-name|local-command-stdout)\b[^>]*>[\s\S]*?<\/\1>/gi;
const optOut = /\b(opt[ -]?out|no[ -]?write|n(?:ã|a)o (?:registrar|guardar|coletar))\b/i;
const hosts = new Set(['codex', 'claude', 'cursor', 'grok']);
const maxReadBytes = 8 * 1024 * 1024;
const maxReadLines = 10_000;
const maxFileBytesPerCycle = 256 * 1024;
const maxFileLinesPerCycle = 1_000;
const iso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const execFileAsync = promisify(execFile);
const eventId = (host, session, origin) => `e-${digest(`${host}\0${session}\0${origin}`).slice(0, 40)}`;
const safeLocator = (locator, byteStart) => `${locator.replace(/#.*$/, '')}#b${byteStart}`;

function excluded(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mode = value.session_kind ?? value.sessionKind ?? value.mode;
  const agent = value.agent_id ?? value.agentId ?? value.subagent_id ?? value.subagentId;
  return identifier(agent) || value.isSidechain === true
    || value.personal === true || mode === 'personal' || value.opt_out === true || value.optOut === true
    || value.no_write === true || value.noWrite === true || mode === 'no-write';
}

function codexSessionMetadata(value) {
  const payload = value?.payload;
  const source = payload?.source;
  const subagent = source && typeof source === 'object' && !Array.isArray(source) && Object.hasOwn(source, 'subagent');
  const uncertain = identifier(payload?.forked_from_id) || identifier(payload?.parent_thread_id);
  return { excluded: excluded(value) || excluded(payload) || Boolean(subagent), uncertain };
}

function content(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  if (value.some((item) => !item || typeof item !== 'object' || !['text', 'input_text'].includes(item.type))) return null;
  const parts = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const text = item.text ?? item.input_text;
    return typeof text === 'string' && ['text', 'input_text'].includes(item.type) ? [text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : null;
}

function sanitize(value) {
  return value
    .replace(injected, '[contexto injetado removido]')
    .replace(/<(?:INSTRUCTIONS|user_instructions|skills_instructions|environment_context|tools_instructions|system_context|command-name|local-command-stdout)\b[^>]*>[\s\S]*$/gi, '[contexto injetado removido]')
    .replace(external, '[dados externos removidos]')
    .replace(/<DADOS_EXTERNOS\b[^>]*>[\s\S]*$/gi, '[dados externos removidos]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removido]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[documento removido]')
    .replace(/\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-\s]?\d{4}\b/g, '[telefone removido]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[segredo removido]')
    .replace(/\b(?:Bearer\s+|sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/gi, '[segredo removido]')
    .trim();
}

function source(host, value, inheritedSession, sessionExcluded) {
  if (sessionExcluded || excluded(value)) return null;
  if (host === 'codex' && value?.type === 'response_item' && value.payload?.role === 'user' && !excluded(value.payload)) {
    const text = content(value.payload.input_text ?? value.payload.content); return typeof text === 'string' ? { text, session: value.session_id ?? value.sessionId ?? inheritedSession, origin: value.event_id ?? value.eventId ?? value.payload.id, at: value.timestamp ?? value.occurredAt ?? value.payload.timestamp, cwd: value.cwd } : null;
  }
  if (host === 'claude' && value?.message?.role === 'user' && value.isMeta !== true && value.isCompactSummary !== true && !excluded(value.message)) {
    const text = content(value.message.content); return typeof text === 'string' ? { text, session: value.session_id ?? value.sessionId ?? inheritedSession, origin: value.event_id ?? value.eventId ?? value.uuid ?? value.message.id, at: value.timestamp ?? value.occurredAt ?? value.message.timestamp, cwd: value.cwd } : null;
  }
  return null;
}

function makeEvent(host, session, origin, at, locator, provenance, scope = { kind: 'global' }) {
  return { version: 1, id: eventId(host, session, origin), host, session, originEventId: origin, occurredAt: at, scope, locator, kind: 'request', provenance };
}

function validScope(value) { return value?.kind === 'global' || (value?.kind === 'repo' && identifier(value.repo)); }

/** Resolves only native cwd metadata. Repository paths are represented by a hash of git-common-dir. */
export function createScopeResolver(home = homedir()) {
  const cache = new Map(); const globals = [home, join(home, '.agents'), join(home, '.codex'), join(home, '.claude'), join(home, '.cursor')].map((value) => resolve(value));
  return async (cwd) => {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 1024) return null;
    const key = resolve(cwd); if (cache.has(key)) return cache.get(key);
    let scope = null;
    try {
      const realCwd = await realpath(key);
      if (globals.some((candidate) => realCwd === candidate)) scope = { kind: 'global' };
      else {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], { cwd: realCwd, windowsHide: true, timeout: 2_000, maxBuffer: 4_096 });
        const common = await realpath(resolve(realCwd, stdout.trim())); scope = { kind: 'repo', repo: `repo-${digest(common.toLowerCase()).slice(0, 40)}` };
      }
    } catch { scope = null; }
    if (cache.size >= 256) cache.delete(cache.keys().next().value); cache.set(key, scope); return scope;
  };
}

async function scopeMap(host, text, resolveScope) {
  const result = new Map(); const values = [];
  for (const line of text.split('\n')) {
    let value; try { value = JSON.parse(line); } catch { continue; }
    const cwd = host === 'codex' && value?.type === 'session_meta' ? value.payload?.cwd : host === 'claude' ? value?.cwd : null;
    if (typeof cwd === 'string' && !values.includes(cwd) && values.length < 32) values.push(cwd);
  }
  for (const cwd of values) result.set(cwd, await resolveScope(cwd));
  return result;
}

function limits(budget) {
  const bytes = Number.isSafeInteger(budget) ? budget : budget?.bytes;
  const lines = Number.isSafeInteger(budget) ? budget : budget?.lines;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(lines) || lines <= 0) return { bytes: 0, lines: 0 };
  return { bytes: Math.min(bytes, maxReadBytes), lines: Math.min(lines, maxReadLines) };
}

function parseCursor(value) {
  if (Number.isSafeInteger(value) && value >= 0) return { offset: value };
  if (typeof value !== 'string') return null;
  if (/^(0|[1-9]\d*)$/.test(value)) { const offset = Number(value); return Number.isSafeInteger(offset) ? { offset } : null; }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some((key) => !['offset', 'session', 'excluded', 'uncertain', 'header', 'scope'].includes(key)) || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || !identifier(parsed.session) || (parsed.excluded !== undefined && typeof parsed.excluded !== 'boolean') || (parsed.uncertain !== undefined && typeof parsed.uncertain !== 'boolean') || (parsed.header !== undefined && typeof parsed.header !== 'boolean') || (parsed.scope !== undefined && !validScope(parsed.scope))) return null;
    return { offset: parsed.offset, session: parsed.session, excluded: parsed.excluded === true, uncertain: parsed.uncertain === true, header: parsed.header === true, scope: parsed.scope };
  } catch { return null; }
}

const nextCursor = (offset, session, excludedSession, uncertainSession, sessionHeader, scope) => identifier(session) ? JSON.stringify({ offset, session, ...(excludedSession ? { excluded: true } : {}), ...(uncertainSession ? { uncertain: true } : {}), ...(sessionHeader ? { header: true } : {}), ...(validScope(scope) ? { scope } : {}) }) : String(offset);

async function readCodexHeader(handle) {
  const bytes = Buffer.alloc(1024 * 1024); const read = await handle.read(bytes, 0, bytes.length, 0); const end = bytes.subarray(0, read.bytesRead).indexOf(0x0a);
  if (end < 0) return null;
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)).replace(/\r$/, ''); } catch { return null; }
  let value; try { value = JSON.parse(text); } catch { return null; }
  const session = value?.type === 'session_meta' ? value.payload?.id ?? value.session_id ?? value.sessionId : null;
  if (!identifier(session)) return null;
  const metadata = codexSessionMetadata(value);
  return { session, excluded: metadata.excluded, uncertain: metadata.uncertain, header: true, cwd: value.payload?.cwd };
}

function completePrefix(bytes, lineLimit) {
  let end = 0; let lines = 0;
  for (let index = 0; index < bytes.length && lines < lineLimit; index += 1) if (bytes[index] === 0x0a) { end = index + 1; lines += 1; }
  return { end, lines };
}

/** @param {{host:'codex'|'claude'|'cursor'|'grok',text:string,locator:string,byteOffset?:number,session?:string,sessionExcluded?:boolean,sessionUncertain?:boolean,sessionHeader?:boolean}} input */
export function parseHistory({ host, text, locator, byteOffset = 0, session, sessionExcluded = false, sessionUncertain = false, sessionHeader = false, sessionScope, scopes = new Map() }) {
  if (!hosts.has(host) || typeof text !== 'string' || typeof locator !== 'string' || locator.length > 900 || !locator.startsWith(`${host}://`) || /\s/.test(locator) || !Number.isSafeInteger(byteOffset) || byteOffset < 0 || (session !== undefined && !identifier(session))) return { events: [], locators: [], buffers: [] };
  const events = []; const locators = []; const buffers = []; const pending = []; const seen = new Set(); let byteStart = byteOffset; let inheritedSession = session; let inheritedExcluded = sessionExcluded; let inheritedUncertain = sessionUncertain; let inheritedHeader = sessionHeader; let inheritedScope = sessionScope;
  for (const line of text.split(/(?<=\n)/)) {
    const byteEnd = byteStart + Buffer.byteLength(line); const body = line.endsWith('\n') ? line.slice(0, -1) : line;
    let value; try { value = JSON.parse(body); } catch { if (body.trim()) pending.push({ locator: safeLocator(locator, byteStart), reason: 'invalid_json' }); byteStart = byteEnd; continue; }
    if (host === 'codex' && value?.type === 'session_meta') { const candidate = value.payload?.id ?? value.session_id ?? value.sessionId; if (identifier(candidate)) { inheritedSession = candidate; inheritedHeader = true; } const metadata = codexSessionMetadata(value); inheritedExcluded = metadata.excluded; inheritedUncertain = metadata.uncertain; inheritedScope = scopes.get(value.payload?.cwd) ?? null; byteStart = byteEnd; continue; }
    const item = source(host, value, inheritedSession, inheritedExcluded);
    if (!item) { byteStart = byteEnd; continue; }
    if (!identifier(item.session) || !iso(item.at)) { pending.push({ locator: safeLocator(locator, byteStart), reason: 'metadata_missing' }); byteStart = byteEnd; continue; }
    if (optOut.test(item.text) || containsSensitive(item.text)) { byteStart = byteEnd; continue; }
    const sanitizedText = sanitize(item.text); if (!sanitizedText) { byteStart = byteEnd; continue; }
    const origin = identifier(item.origin) ? item.origin : `offset-${digest(`${item.session}\0${byteStart}\0${item.at}`).slice(0, 40)}`;
    const scope = scopes.get(item.cwd) ?? inheritedScope ?? { kind: 'global' }; const provenance = inheritedUncertain || !validScope(scopes.get(item.cwd) ?? inheritedScope) ? 'uncertain' : 'verified';
    const itemLocator = safeLocator(locator, byteStart); const event = makeEvent(host, item.session, origin, item.at, itemLocator, provenance, scope);
    if (!seen.has(event.id)) { seen.add(event.id); events.push(event); locators.push(itemLocator); buffers.push({ locator: itemLocator, sanitizedText, byteStart, byteEnd }); }
    byteStart = byteEnd;
  }
  return { events, locators, buffers, pending, session: inheritedSession, sessionExcluded: inheritedExcluded, sessionUncertain: inheritedUncertain, sessionHeader: inheritedHeader, sessionScope: inheritedScope };
}

/** @param {'codex'|'claude'|'cursor'|'grok'} host @param {unknown} payload */
export function normalizeHookEvent(host, payload) {
  if (!hosts.has(host) || !payload || typeof payload !== 'object' || Array.isArray(payload) || excluded(payload)) return null;
  const value = /** @type {Record<string, unknown>} */ (payload); const hookName = value.hook_event_name ?? value.hookEventName;
  if (hookName !== undefined && hookName !== 'UserPromptSubmit') return null;
  const session = value.sessionId ?? value.session_id; const origin = value.originEventId ?? value.event_id ?? value.eventId; const at = value.occurredAt ?? value.timestamp;
  if (!identifier(session) || !identifier(origin) || !iso(at)) return null;
  return makeEvent(host, session, origin, at, `${host}://hook/${digest(`${session}\0${origin}`).slice(0, 32)}`, hookName === 'UserPromptSubmit' ? 'verified' : 'uncertain');
}

/** Imports only a channel- and blob-bound generalized bot event. It never grants authority. */
export function importGeneralizedGrokEvent(value, { trustedChannel, expectedBlob } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.host !== 'grok' || value.channel !== trustedChannel || value.blob !== expectedBlob || !/^[a-f0-9]{64}$/.test(expectedBlob ?? '')) return { event: null, status: 'pending', authorized: false };
  const { session, originEventId: origin, occurredAt: at, locator, kind } = value;
  if (!identifier(session) || !identifier(origin) || !iso(at) || typeof locator !== 'string' || !locator.startsWith('grok://') || /\s/.test(locator) || !['request', 'correction'].includes(kind)) return { event: null, status: 'pending', authorized: false };
  return { event: { ...makeEvent('grok', session, origin, at, locator, 'uncertain'), kind }, status: 'accepted', authorized: false };
}

/** Re-reads a permitted locator and returns a transient sanitized buffer only when its identity still matches. */
export async function readSnippet(event, locators, home = homedir()) {
  if (!event || typeof locators !== 'object' || locators === null || typeof event.locator !== 'string') return null;
  const base = event.locator.replace(/#b\d+$/, ''); const descriptor = locators[base]; const path = descriptor?.path; const root = descriptor?.root; const offset = Number(event.locator.match(/#b(\d+)$/)?.[1] ?? 0);
  if (typeof path !== 'string' || typeof root !== 'string' || !isAbsolute(path) || !isAbsolute(root) || !Number.isSafeInteger(offset) || offset < 0) return null;
  let handle; try {
    const allowed = resolve(root); const candidate = resolve(path); const rel = relative(allowed, candidate);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    if ((await lstat(allowed)).isSymbolicLink()) return null;
    let cursor = allowed;
    for (const part of rel.split(sep)) { cursor = resolve(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) return null; }
    const realAllowed = await realpath(allowed); const realCandidate = await realpath(candidate);
    if (!realCandidate.startsWith(`${realAllowed}${sep}`)) return null;
    handle = await open(path, 'r'); const header = event.host === 'codex' ? await readCodexHeader(handle) : null; const resolveScope = createScopeResolver(home);
    if (header && (header.session !== event.session || header.excluded || (header.uncertain && event.provenance !== 'uncertain'))) return null;
    const data = Buffer.alloc(64 * 1024); const read = await handle.read(data, 0, data.length, offset); const line = data.subarray(0, read.bytesRead).toString('utf8').split('\n', 1)[0];
    const scopes = await scopeMap(event.host, `${header?.cwd ? JSON.stringify({ type: 'session_meta', payload: { cwd: header.cwd } }) + '\n' : ''}${line}\n`, resolveScope); const parsed = parseHistory({ host: event.host, text: `${line}\n`, locator: base, byteOffset: offset, session: header?.session ?? event.session, sessionExcluded: header?.excluded, sessionUncertain: header?.uncertain, sessionHeader: header?.header, sessionScope: scopes.get(header?.cwd), scopes });
    const index = parsed.events.findIndex((item) => item.id === event.id && item.host === event.host && item.session === event.session && item.originEventId === event.originEventId && item.occurredAt === event.occurredAt && item.locator === event.locator && item.kind === event.kind && item.provenance === event.provenance && JSON.stringify(item.scope) === JSON.stringify(event.scope));
    return index < 0 ? null : parsed.buffers[index]?.sanitizedText ?? null;
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

/** @param {{roots:{host:'codex'|'claude'|'cursor'|'grok',path:string,locator:string}[],cursors:Record<string,number|string>,budget:number|{bytes:number,lines:number},stateDir?:string}} input */
export async function scanHistory({ roots, cursors, budget, stateDir, home = homedir() }) {
  const events = []; const buffers = []; const nextCursors = {}; const pending = []; const seen = new Set(); let remaining = limits(budget); let lastVisited = null; let historyBacklog = false;
  if (!Array.isArray(roots) || !cursors || typeof cursors !== 'object') return { events, buffers, nextCursors, pending, lastVisited, historyBacklog };
  const resolveScope = createScopeResolver(home);
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    if (remaining.bytes === 0 || remaining.lines === 0) { historyBacklog = true; break; }
    const current = parseCursor(cursors[root?.path] ?? '0');
    if (!current || typeof root?.path !== 'string' || !hosts.has(root.host) || typeof root.locator !== 'string' || root.locator.length > 900 || !root.locator.startsWith(`${root.host}://`) || /\s/.test(root.locator)) { historyBacklog = true; continue; }
    lastVisited = root.locator;
    let handle; let chunk; let fileSize = null; let inherited = current;
    try {
      handle = await open(root.path, 'r');
      fileSize = (await handle.stat()).size;
      if (root.host === 'codex' && current.offset > 0) {
        const header = await readCodexHeader(handle);
        if ((current.header && !header) || (header && current.session && (header.session !== current.session || header.excluded !== current.excluded || header.uncertain !== current.uncertain))) { pending.push({ locator: safeLocator(root.locator, current.offset), reason: 'source_changed' }); historyBacklog = true; continue; }
        if (header) inherited = { ...current, ...header, scope: await resolveScope(header.cwd) };
      }
      const bytes = Buffer.allocUnsafe(Math.min(remaining.bytes, maxFileBytesPerCycle)); const read = await handle.read(bytes, 0, bytes.length, current.offset); chunk = bytes.subarray(0, read.bytesRead);
    } catch { historyBacklog = true; continue; } finally { await handle?.close().catch(() => {}); }
    const complete = completePrefix(chunk, Math.min(remaining.lines, maxFileLinesPerCycle)); remaining.bytes -= chunk.length; remaining.lines -= complete.lines;
    if (fileSize !== null && current.offset + complete.end < fileSize) historyBacklog = true;
    if (complete.end === 0) { if (chunk.length > 0) pending.push({ locator: safeLocator(root.locator, current.offset), reason: 'line_exceeds_budget' }); continue; }
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(0, complete.end)); } catch { pending.push({ locator: safeLocator(root.locator, current.offset), reason: 'invalid_utf8' }); historyBacklog = true; continue; }
    const scopes = await scopeMap(root.host, text, resolveScope); const parsed = parseHistory({ host: root.host, text, locator: root.locator, byteOffset: current.offset, session: inherited.session, sessionExcluded: inherited.excluded, sessionUncertain: inherited.uncertain, sessionHeader: inherited.header, sessionScope: inherited.scope, scopes });
    pending.push(...parsed.pending);
    const accepted = parsed.events.map((event, index) => ({ event, buffer: parsed.buffers[index] })).filter(({ event }) => !seen.has(event.id));
    if (accepted.length > 0 && (typeof stateDir !== 'string' || stateDir.length === 0)) { pending.push({ locator: safeLocator(root.locator, current.offset), reason: 'state_unconfigured' }); historyBacklog = true; continue; }
    try { for (const { event } of accepted) await appendEvent(stateDir, event); } catch { pending.push({ locator: safeLocator(root.locator, current.offset), reason: 'append_failed' }); historyBacklog = true; continue; }
    for (const item of accepted) { seen.add(item.event.id); events.push(item.event); buffers.push(item.buffer); }
    nextCursors[root.path] = nextCursor(current.offset + complete.end, parsed.session ?? inherited.session, parsed.sessionExcluded ?? inherited.excluded, parsed.sessionUncertain ?? inherited.uncertain, parsed.sessionHeader ?? inherited.header, parsed.sessionScope ?? inherited.scope);
  }
  return { events, buffers, nextCursors, pending, lastVisited, historyBacklog };
}
