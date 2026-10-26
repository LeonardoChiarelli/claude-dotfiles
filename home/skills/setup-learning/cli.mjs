#!/usr/bin/env node
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeBatch } from './analyze.mjs';
import { activate, createHostApplicationAdapters, evaluatePolicy, recordValidation, rollback, stageCandidate } from './apply.mjs';
import { gmailLookupRequest, gmailSendRequest, prepareDigest, reconcile } from './digest.mjs';
import { appendEvent, beginSend, finishSend, finishWorkerHandoff, loadState, pruneState, recordCandidates, recordCapabilityEvidence, recordInstallation, recordPreparedDigest, recordSkillInventoryEvidence, recordSuggestions, recoverStateLock, rejectCandidate } from './state.mjs';
import { proposeCandidates } from './learning.mjs';
import { createNativeWorkerDependencies, loadCapabilityEvidence, runWorker } from './worker.mjs';

const routes = new Set(['collect', 'backfill', 'prepare-analysis', 'record-suggestions', 'propose', 'check-apply', 'prune', 'recover-lock', 'stage', 'record-validation', 'activate', 'rollback', 'prepare-digest', 'begin-digest', 'finish-digest', 'reconcile-digest', 'record-installation', 'record-capability', 'finish-handoff', 'reject', 'worker']);
const allowedOptions = new Set(['--state-dir', '--candidate', '--receipt', '--now', '--event', '--suggestions', '--catalog', '--worktree', '--base-ref', '--files', '--validation-profile', '--review-evidence', '--envelope', '--time-zone', '--deadline', '--mode', '--result', '--fact']);

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || args[index + 1] === undefined || Object.hasOwn(result, args[index])) throw new TypeError('invalid CLI arguments');
    result[args[index]] = args[index + 1];
  }
  return result;
}
function json(value, name) { try { return JSON.parse(value); } catch { throw new TypeError(`${name} must be JSON`); } }
function analysisBuffers(value, events) {
  const parsed = json(value, 'buffers');
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) throw new TypeError('buffers must be a bounded array');
  const known = new Set(events.map(({ id }) => id)); const result = new Map();
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'eventId,sanitizedText' || !known.has(item.eventId) || typeof item.sanitizedText !== 'string' || item.sanitizedText.length === 0 || result.has(item.eventId)) throw new TypeError('buffers must reference unique stored events');
    result.set(item.eventId, item.sanitizedText);
  }
  return result;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length; if (bytes > 256 * 1024) throw new TypeError('transient input exceeds limit'); chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function fixedTargets(candidate, state, sourceWorktree, adapters) {
  const record = [...state.manifests].reverse().find(({ candidateId }) => candidateId === candidate.id); if (!record) return [];
  const specs = candidate.artifactKind === 'skill' ? [{ prefix: 'skills/', adapter: adapters.skill }]
    : candidate.artifactKind === 'hook' ? Object.values(adapters.hooks).map((adapter) => ({ prefix: 'home/hooks/', adapter }))
      : candidate.artifactKind === 'agents' ? [{ prefix: 'home/', adapter: adapters.agents }] : [];
  return specs.flatMap(({ prefix, adapter }) => record.manifest.files.filter(({ relativePath }) => relativePath.startsWith(prefix)).map((file) => ({ adapter, sourceWorktree, sourcePath: file.relativePath, relativePath: file.relativePath.slice(prefix.length), sourceHash: file.sourceHash, expectedHash: file.beforeHash })));
}

/** Builds targets only from the persisted manifest and fixed host adapters. Runtime probes remain native controller functions. */
export function createNativeActivationController({ home = homedir(), sourceWorktree, smokes, probeIdle }) {
  if (typeof sourceWorktree !== 'string' || !isAbsolute(sourceWorktree) || typeof probeIdle !== 'function') throw new TypeError('native activation controller is invalid');
  const adapters = createHostApplicationAdapters({ home, smokes });
  return async ({ operation, stateDir, candidateId, receiptId }) => {
    if (!['activate', 'rollback'].includes(operation) || typeof stateDir !== 'string' || typeof candidateId !== 'string' || typeof receiptId !== 'string') throw new TypeError('native activation request is invalid');
    const state = await loadState(stateDir); const candidate = state.candidates.find(({ id }) => id === candidateId); const targets = candidate ? fixedTargets(candidate, state, sourceWorktree, adapters) : [];
    if (!candidate || !state.receipts?.[receiptId] || targets.length === 0) return { status: 'pending', reason: candidate?.artifactKind === 'mcp' ? 'mcp_activation_requires_approval' : 'native_activation_evidence_missing', hostStates: {} };
    return operation === 'activate' ? activate({ stateDir, candidate, receiptId, targets, probeIdle }) : rollback({ stateDir, candidate, receiptId, targets, probeIdle });
  };
}

/** Persists only the closed projection returned in memory by the trusted native skills/list probe. */
export function createNativeInventoryController({ observeSkills }) {
  if (typeof observeSkills !== 'function') throw new TypeError('native inventory controller is invalid');
  return async ({ stateDir, observedAt }) => {
    const observed = await observeSkills();
    return recordSkillInventoryEvidence(stateDir, { source: 'skills/list', evidenceRef: observed?.evidenceRef, observedAt, skills: observed?.skills });
  };
}

export async function runCli(argv, { runner, workerDependencies, capabilities, activationController, inventoryController, now = () => new Date().toISOString(), readTransient = readStdin, writeOut = (value) => process.stdout.write(value), writeErr = (value) => process.stderr.write(value) } = {}) {
  const output = (value) => writeOut(`${JSON.stringify(value)}\n`);
  const pending = (reason) => writeErr(`pending: ${reason}\n`);
  const [route, ...args] = argv;
  if (!routes.has(route)) { writeErr('usage: setup-learning <collect|backfill|prepare-analysis|record-suggestions|propose|check-apply|prune|recover-lock|stage|record-validation|activate|rollback|prepare-digest|begin-digest|finish-digest|reconcile-digest|record-installation|record-capability|finish-handoff|reject|worker> [--state-dir <path>]\n'); return 2; }
  const input = options(args); const stateDir = input['--state-dir'];
  if (typeof stateDir !== 'string' || Object.keys(input).some((key) => !allowedOptions.has(key))) throw new TypeError('unsupported CLI option');
  if (route === 'prune') { output(await pruneState(stateDir, input['--now'] ?? now())); return 0; }
  if (route === 'recover-lock') { output(await recoverStateLock(stateDir)); return 0; }
  if (route === 'worker') {
    if (typeof input['--deadline'] !== 'string') throw new TypeError('worker requires deadline');
    if (typeof inventoryController === 'function') await inventoryController({ stateDir, observedAt: now() }).catch(() => null);
    const fixedDependencies = workerDependencies ?? createNativeWorkerDependencies(runner ? { runner } : {}); const evidence = capabilities ?? await loadCapabilityEvidence(stateDir);
    output(await runWorker({ stateDir, now, deadline: input['--deadline'], capabilities: evidence, mode: input['--mode'] ?? 'scheduled', dependencies: fixedDependencies })); return 0;
  }
  if (route === 'collect' || route === 'backfill') {
    if (typeof input['--event'] !== 'string') throw new TypeError(`${route} requires a sanitized event`);
    await appendEvent(stateDir, json(input['--event'], 'event')); output({ status: 'complete', route }); return 0;
  }
  if (route === 'stage') {
    if (![input['--candidate'], input['--worktree'], input['--base-ref'], input['--files']].every((value) => typeof value === 'string')) throw new TypeError('stage requires candidate, worktree, base-ref, and files');
    const staged = await stageCandidate({ stateDir, candidateId: input['--candidate'], worktree: input['--worktree'], baseRef: input['--base-ref'], files: input['--files'].split(',').filter(Boolean) });
    output({ status: staged.candidate.status, candidateId: staged.candidate.id, diffHash: staged.manifest.diffHash }); return 0;
  }
  if (route === 'record-validation') {
    if (![input['--candidate'], input['--worktree'], input['--validation-profile'], input['--review-evidence']].every((value) => typeof value === 'string')) throw new TypeError('record-validation requires candidate, worktree, validation-profile, and review-evidence');
    const receipt = await recordValidation({ stateDir, candidateId: input['--candidate'], worktree: input['--worktree'], validationProfile: input['--validation-profile'], reviewEvidenceRef: input['--review-evidence'] });
    if (!receipt) { pending('validation did not produce a bound receipt'); output({ status: 'pending' }); return 0; }
    output({ status: 'complete', receiptId: receipt.id }); return 0;
  }
  if (route === 'activate' || route === 'rollback') {
    if (typeof activationController !== 'function') {
      pending('native activation controller is required');
      if (typeof input['--candidate'] !== 'string' || typeof input['--receipt'] !== 'string') output({ status: 'pending', route });
      else output({ status: 'pending', reason: 'controller', plan: { action: route, candidateId: input['--candidate'], receiptId: input['--receipt'] } });
      return 0;
    }
    if (typeof input['--candidate'] !== 'string' || typeof input['--receipt'] !== 'string') throw new TypeError(`${route} requires candidate and receipt`);
    output(await activationController({ operation: route, stateDir, candidateId: input['--candidate'], receiptId: input['--receipt'] })); return 0;
  }
  const state = await loadState(stateDir);
  if (route === 'prepare-digest') {
    const envelope = prepareDigest(state, { now: input['--now'] ?? now(), timeZone: input['--time-zone'] ?? 'America/Sao_Paulo' });
    if (!envelope) { output({ status: 'pending', reason: 'no semantic digest is due' }); return 0; }
    await recordPreparedDigest(stateDir, envelope); output({ status: 'prepared', envelopeId: envelope.id, subject: envelope.subject }); return 0;
  }
  if (route === 'begin-digest') {
    if (typeof input['--envelope'] !== 'string') throw new TypeError('begin-digest requires envelope');
    const entry = await beginSend(stateDir, input['--envelope']);
    output({ status: 'sending', envelopeId: entry.id, request: gmailSendRequest(entry) }); return 0;
  }
  if (route === 'finish-digest') { if (typeof input['--result'] !== 'string') throw new TypeError('finish-digest requires result'); output(await finishSend(stateDir, json(input['--result'], 'result'))); return 0; }
  if (route === 'reconcile-digest') {
    const unknown = state.ledger.find(({ state: status }) => status === 'unknown');
    if (!unknown) { output({ status: 'complete', reconciled: false, retry: false }); return 0; }
    if (typeof input['--result'] !== 'string') { output({ status: 'lookup', envelopeId: unknown.id, request: gmailLookupRequest(unknown), retry: false }); return 0; }
    const reconciled = await reconcile(state, { lookup: async () => json(input['--result'], 'result') });
    if (!reconciled.reconciled) { output({ status: reconciled.requests ? 'lookup' : 'pending', ...reconciled }); return 0; }
    output(await finishSend(stateDir, reconciled)); return 0;
  }
  if (route === 'record-installation') { if (typeof input['--fact'] !== 'string') throw new TypeError('record-installation requires fact'); output({ status: 'complete', fact: await recordInstallation(stateDir, json(input['--fact'], 'fact')) }); return 0; }
  if (route === 'record-capability') { if (typeof input['--result'] !== 'string') throw new TypeError('record-capability requires result'); output({ status: 'complete', evidence: await recordCapabilityEvidence(stateDir, json(input['--result'], 'result')) }); return 0; }
  if (route === 'finish-handoff') { if (typeof input['--result'] !== 'string') throw new TypeError('finish-handoff requires result'); output({ status: 'complete', handoff: await finishWorkerHandoff(stateDir, json(input['--result'], 'result')) }); return 0; }
  if (route === 'reject') { if (typeof input['--result'] !== 'string') throw new TypeError('reject requires result'); output({ status: 'complete', candidate: await rejectCandidate(stateDir, json(input['--result'], 'result')) }); return 0; }
  if (route === 'record-suggestions') {
    if (typeof input['--suggestions'] !== 'string') throw new TypeError('record-suggestions requires sanitized suggestions');
    const suggestions = json(input['--suggestions'], 'suggestions'); if (!Array.isArray(suggestions)) throw new TypeError('suggestions must be an array');
    await recordSuggestions(stateDir, suggestions); output({ status: 'complete', count: suggestions.length }); return 0;
  }
  if (route === 'prepare-analysis') {
    const transient = await readTransient();
    if (typeof transient !== 'string' || transient.length === 0) { pending('transient sanitized buffers are required on stdin'); output({ status: 'pending', processedIds: [], nonprocessedIds: state.events.map(({ id }) => id) }); return 0; }
    const buffers = analysisBuffers(transient, state.events);
    const result = await analyzeBatch({ events: state.events, readSnippet: async ({ id }) => buffers.get(id), runner });
    if (result.suggestions.length > 0) await recordSuggestions(stateDir, result.suggestions);
    output({ status: result.processedIds.length > 0 ? 'complete' : 'pending', processedIds: result.processedIds, nonprocessedIds: result.nonprocessedIds }); return 0;
  }
  if (route === 'propose') {
    if (typeof input['--catalog'] !== 'string') { pending('a semantically qualified catalog is required'); output({ status: 'pending', candidateIds: [] }); return 0; }
    const catalog = json(input['--catalog'], 'catalog'); if (!Array.isArray(catalog)) throw new TypeError('catalog must be an array');
    const candidates = proposeCandidates({ events: state.events, suggestions: state.suggestions ?? [], patterns: state.patterns, catalog, tombstones: state.tombstones, now: input['--now'] ?? now() }).slice(0, 1);
    await recordCandidates(stateDir, candidates); output({ status: candidates.length === 0 ? 'pending' : 'complete', candidateIds: candidates.map((item) => item.id) }); return 0;
  }
  if (route === 'check-apply') {
    if (typeof input['--candidate'] !== 'string' || typeof input['--worktree'] !== 'string') throw new TypeError('check-apply requires candidate and worktree');
    const candidate = state.candidates.find(({ id }) => id === input['--candidate']); const record = [...state.manifests].reverse().find(({ candidateId }) => candidateId === input['--candidate']);
    if (!candidate || !record) { pending('staged candidate manifest is required'); output({ status: 'pending', reasons: ['staged candidate manifest is required'] }); return 0; }
    const result = evaluatePolicy({ candidate, diffManifest: record.manifest, policy: { worktree: input['--worktree'] } });
    if (!result.allowed) pending(result.reasons.join('; ')); output({ status: result.allowed ? 'allowed' : 'pending', reasons: result.reasons }); return 0;
  }
  pending('route is pending'); return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`pending: ${error.message}\n`); process.exitCode = 1; });
}
