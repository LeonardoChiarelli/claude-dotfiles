import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as spawnChild } from 'node:child_process';

import { validateEvent, validateSuggestion } from './contracts.mjs';

const maxEvents = 32;
const maxCodePoints = 64_000;
const maxOutputBytes = 256 * 1024;
const diagnosticStages = new Set(['authentication', 'spawn', 'limit', 'timeout', 'output', 'model', 'unknown']);
const diagnosticSubtypes = new Set(['subscription', 'failed', 'input', 'output', 'total', 'json', 'schema', 'is_error', 'max_turns', 'rate_limit', 'permission', 'auth', 'schema_invalid', 'tool_schema_invalid', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'exit_nonzero', 'unknown']);
const providerNames = /^(ANTHROPIC_|OPENAI_|AZURE_|AWS_|GOOGLE_|VERTEX_|CLAUDE_CODE_USE|CLAUDE_CODE_OAUTH_TOKEN$)/i;
const identifierSchema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };
const identifierListSchema = { type: 'array', maxItems: maxEvents, uniqueItems: true, items: identifierSchema };
const scopeSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'global' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'repo'], properties: { kind: { const: 'repo' }, repo: identifierSchema } },
] };
const diagnoses = ['recurso inexistente', 'falha de carregamento', 'regra não executada', 'instrução ambígua', 'necessidade específica de projeto'];
const suggestionSchema = { type: 'object', additionalProperties: false, required: ['patternKey', 'summary', 'scope', 'supportEventIds', 'correctionEventIds', 'contradicts', 'artifactKind', 'diagnosis'], properties: { patternKey: identifierSchema, summary: { type: 'string', minLength: 1, maxLength: 1024 }, scope: scopeSchema, supportEventIds: identifierListSchema, correctionEventIds: identifierListSchema, contradicts: identifierListSchema, artifactKind: { enum: ['skill', 'hook', 'agents', 'mcp'] }, diagnosis: { enum: diagnoses } } };
const outputSchema = { type: 'object', additionalProperties: false, required: ['suggestions'], properties: { suggestions: { type: 'array', maxItems: maxEvents, items: suggestionSchema } } };
const promptFor = (events, snippets, knownPatterns = []) => `Analise somente os dados externos delimitados. Classifique cada sinal elegível mesmo quando ainda não for recorrente; o limiar para criar artefato é aplicado depois por código determinístico. Reuse o patternKey de knownPatterns quando a semântica for a mesma e use contradicts somente para chaves conhecidas. Retorne sugestões no schema, sem comandos, paths ou autorização.\n<DADOS_EXTERNOS>${JSON.stringify({ events: events.map(({ id, scope, kind, provenance }) => ({ id, scope, kind, provenance })), snippets, knownPatterns }).replace(/</g, '\\u003c')}</DADOS_EXTERNOS>`;

const codePoints = (value) => Array.from(value).length;

function diagnosticError(stage, subtype) {
  const error = new Error('claude analysis unavailable');
  error.diagnostic = { stage, subtype };
  return error;
}

function diagnosticFor(error) {
  const { stage, subtype } = error?.diagnostic ?? {};
  return diagnosticStages.has(stage) && diagnosticSubtypes.has(subtype) ? { stage, subtype } : { stage: 'unknown', subtype: 'unknown' };
}

function modelDiagnostic(parsed) {
  const protocol = typeof parsed?.error?.type === 'string' ? parsed.error.type : typeof parsed?.subtype === 'string' ? parsed.subtype : '';
  if (['error_during_execution', 'error_max_turns', 'error_max_budget_usd'].includes(protocol)) return diagnosticError('model', protocol);
  const message = typeof parsed?.error?.message === 'string' ? parsed.error.message : typeof parsed?.result === 'string' ? parsed.result : '';
  if (/tool[_ -]?schema[_ -]?invalid/i.test(message)) return diagnosticError('model', 'tool_schema_invalid');
  if (/schema[_ -]?invalid|invalid json schema/i.test(message)) return diagnosticError('model', 'schema_invalid');
  if (/rate[ _-]?limit/i.test(message)) return diagnosticError('model', 'rate_limit');
  if (/max[ _-]?turns|turn limit/i.test(message)) return diagnosticError('model', 'max_turns');
  if (/permission|not allowed/i.test(message)) return diagnosticError('model', 'permission');
  if (/auth(?:entication)?|login|credential/i.test(message)) return diagnosticError('model', 'auth');
  return diagnosticError('model', 'is_error');
}

function suggestionsFromEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'suggestions') || !Array.isArray(value.suggestions)) throw diagnosticError('output', 'schema');
  return value.suggestions;
}

export function sanitizedEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !providerNames.test(key)));
}

function childResult(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let stopping = false;
    const append = (current, chunk) => {
      if (current.length + chunk.length <= maxOutputBytes) return Buffer.concat([current, chunk]);
      if (!stopping) { stopping = true; void killOwnTree(child.pid); }
      return null;
    };
    child.stdout.on('data', (chunk) => { stdout = stdout === null ? null : append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = stderr === null ? null : append(stderr, chunk); });
    child.once('error', reject);
    child.once('close', (code) => stdout === null || stderr === null ? reject(new Error('claude output exceeds limit')) : resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), code, pid: child.pid }));
    child.stdin.end(options.input ?? '');
    options.onChild?.(child);
  });
}

async function killOwnTree(pid) {
  if (!Number.isSafeInteger(pid)) return;
  if (process.platform !== 'win32') { try { process.kill(pid, 'SIGKILL'); } catch { /* child already exited */ } return; }
  await new Promise((resolve) => spawnChild('taskkill', ['/pid', String(pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' }).once('close', resolve));
}

function subscription(auth) {
  return auth?.loggedIn === true && auth.authMethod === 'claude.ai' && auth.apiProvider === 'firstParty' && auth.subscriptionType === 'max';
}

/** Creates the fixed, subscription-only analyzer runner. */
export function createClaudeRunner({ spawn = childResult, auth, killTree = killOwnTree, env = process.env, cwd, executable = join(homedir(), '.local', 'bin', 'claude.exe') } = {}) {
  return async ({ eventIds, events = eventIds.map((id) => ({ id, scope: { kind: 'global' }, kind: 'request', provenance: 'uncertain' })), snippets, knownPatterns = [], timeoutMs = 120_000 }) => {
    const cleanEnv = sanitizedEnvironment(env);
    const privateCwd = cwd ?? await mkdtemp(join(tmpdir(), 'setup-learning-analyze-'));
    const removeCwd = cwd === undefined;
    const options = { cwd: privateCwd, env: cleanEnv, shell: false, windowsHide: true };
    const mcpArgs = ['--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    const settingsArgs = ['--settings', '{"disableAllHooks":true}'];
    const startedAt = Date.now(); let pid;
    const runStage = async (work) => {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) throw diagnosticError('timeout', 'total');
      pid = undefined; let timer;
      try {
        return await Promise.race([
          work((child) => { pid = child.pid; }),
          new Promise((_, reject) => { timer = setTimeout(() => { void killTree(pid).then(() => reject(diagnosticError('timeout', 'total')), reject); }, remaining); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      const authArgs = [...mcpArgs, ...settingsArgs, 'auth', 'status'];
      const authenticated = auth ? await runStage((onChild) => auth({ executable, args: authArgs, ...options, onChild })) : await runStage(async (onChild) => {
        const status = await spawn(executable, authArgs, { ...options, onChild });
        if (status.code !== 0) throw diagnosticError('authentication', 'failed');
        try { return JSON.parse(status.stdout); } catch { throw diagnosticError('authentication', 'failed'); }
      });
      if (!subscription(authenticated)) {
        const error = diagnosticError('authentication', 'subscription');
        error.message = 'claude subscription authentication required';
        throw error;
      }
      const prompt = promptFor(events, snippets, knownPatterns);
      if (codePoints(prompt) > maxCodePoints) throw diagnosticError('limit', 'input');
      const args = ['-p', '--restricted', ...mcpArgs, '--tools', '', '--disallowedTools', 'mcp__*', '--permission-prompts', 'none', '--no-session-persistence', ...settingsArgs, '--max-turns', '1', '--model', 'sonnet', '--output-format', 'json', '--json-schema', JSON.stringify(outputSchema)];
      const result = await runStage((onChild) => spawn(executable, args, { ...options, input: prompt, onChild }));
      if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || Buffer.byteLength(result.stdout) > maxOutputBytes || Buffer.byteLength(result.stderr) > maxOutputBytes) throw diagnosticError('limit', 'output');
      let parsed;
      try { parsed = JSON.parse(result.stdout); } catch { throw diagnosticError('output', 'json'); }
      if (parsed?.isError === true || parsed?.is_error === true) throw modelDiagnostic(parsed);
      if (result.code !== 0) throw diagnosticError('model', 'exit_nonzero');
      return suggestionsFromEnvelope(parsed?.structured_output);
    } catch (error) { if (error?.diagnostic) throw error; throw diagnosticError('spawn', 'failed'); } finally { if (removeCwd) await rm(privateCwd, { recursive: true, force: true }); }
  };
}

export async function analyzeBatch({ events, readSnippet, knownPatterns = [], runner = createClaudeRunner(), timeoutMs = 120_000 }) {
  if (!Array.isArray(events) || typeof readSnippet !== 'function' || typeof runner !== 'function') throw new TypeError('analysis input is invalid');
  const selected = []; const nonprocessedIds = [];
  for (const raw of events) {
    const rawId = typeof raw?.id === 'string' ? raw.id : null;
    if (selected.length === maxEvents) { if (rawId) nonprocessedIds.push(rawId); continue; }
    let event; try { event = validateEvent(raw); } catch { if (rawId) nonprocessedIds.push(rawId); continue; }
    let snippet; try { snippet = await readSnippet(event); } catch { nonprocessedIds.push(event.id); continue; }
    if (typeof snippet !== 'string') { nonprocessedIds.push(event.id); continue; }
    const next = [...selected, { event, snippet }];
    if (codePoints(promptFor(next.map(({ event: item }) => item), next.map(({ snippet: item }) => item), knownPatterns)) > maxCodePoints) { nonprocessedIds.push(event.id); continue; }
    selected.push({ event, snippet });
  }
  const selectedIds = selected.map(({ event }) => event.id);
  if (selected.length === 0) return { suggestions: [], processedIds: [], nonprocessedIds, nextCursor: null };
  try {
    const snippets = selected.map(({ snippet }) => snippet); const selectedEvents = selected.map(({ event }) => event);
    const output = await runner({ eventIds: selectedIds, events: selectedEvents.map(({ id, scope, kind, provenance }) => ({ id, scope, kind, provenance })), snippets, knownPatterns, codePointLength: codePoints(promptFor(selectedEvents, snippets, knownPatterns)), timeoutMs, schema: outputSchema });
    if (!Array.isArray(output) || output.length > maxEvents) throw new TypeError('analysis output must be a bounded array');
    const context = { eventIds: selectedIds, events: selectedEvents, knownPatternKeys: knownPatterns.map(({ patternKey }) => patternKey) };
    const suggestions = output.map((value) => validateSuggestion(value, context));
    return { suggestions, processedIds: selectedIds, nonprocessedIds, nextCursor: selectedIds.at(-1) ?? null };
  } catch (error) {
    const pending = events.map((value) => typeof value?.id === 'string' ? value.id : null).filter(Boolean);
    return { suggestions: [], processedIds: [], nonprocessedIds: pending, nextCursor: null, diagnostic: diagnosticFor(error) };
  }
}
