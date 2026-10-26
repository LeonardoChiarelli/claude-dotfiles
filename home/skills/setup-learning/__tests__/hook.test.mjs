import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runHostHook } from '../hook.mjs';
import { loadState } from '../state.mjs';
import { createNativeWorkerDependencies, runWorker } from '../worker.mjs';

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'setup-learning-hook-'));
  const stateDir = join(root, 'state'); const templateDir = join(root, 'templates');
  await mkdir(templateDir); await writeFile(join(templateDir, 'preference.json'), JSON.stringify({ version: 1, kind: 'advisory-reminder', event: 'sessionStart', reminder: 'Prefira o helper existente antes de criar outro.' }));
  try { await run({ root, stateDir, templateDir }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('bridge executor records one lifecycle locator and emits the reviewed static reminder', async () => withFixture(async ({ stateDir, templateDir }) => {
  const input = { host: 'codex', stateDir, templateDir, now: () => '2027-01-23T00:00:00.000Z', payload: { hook_event_name: 'SessionStart', session_id: 'session-1' } };
  const first = await runHostHook(input); const second = await runHostHook({ ...input, now: () => '2027-01-23T00:05:00.000Z' });
  assert.equal(first.capture.reason, 'source_locator');
  assert.deepEqual(first.advisory.output, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Prefira o helper existente antes de criar outro.' } });
  assert.equal(second.capture.locator, first.capture.locator);
  const state = await loadState(stateDir); assert.equal(state.sources.length, 1); assert.equal(state.events.length, 0);
}));

test('native user prompt without origin or timestamp only wakes history and persists no body', async () => withFixture(async ({ stateDir, templateDir }) => {
  const result = await runHostHook({ host: 'codex', stateDir, templateDir, payload: { hook_event_name: 'UserPromptSubmit', session_id: 'session-1', prompt: 'private prompt body' } });
  assert.equal(result.capture.recorded, false); assert.equal(result.advisory.status, 'pending');
  const state = await loadState(stateDir); assert.equal(state.events.length, 0); assert.equal(state.sources.length, 0);
}));

test('Cursor uses only an allowlisted transcript locator and its observed context envelope', async () => withFixture(async ({ root, stateDir, templateDir }) => {
  const transcript = join(root, '.cursor', 'projects', 'project-a', 'agent-transcripts', 'session.jsonl');
  await mkdir(join(transcript, '..'), { recursive: true }); await writeFile(transcript, `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'pedido humano fictício' }] } })}\n`);
  const payload = { hookEventName: 'sessionStart', session_id: 'session-1', conversation_id: 'conversation-1', generation_id: 'generation-1', transcript_path: transcript };
  const ready = await runHostHook({ host: 'cursor', home: root, stateDir, templateDir, now: () => '2027-01-23T00:00:00.000Z', payload });
  assert.equal(ready.capture.locator, 'cursor://projects/project-a/agent-transcripts/session.jsonl');
  assert.deepEqual(ready.advisory.output, { additional_context: 'Prefira o helper existente antes de criar outro.' });
  const worker = await runWorker({ stateDir, now: () => '2027-01-23T00:00:01.000Z', deadline: '2027-01-23T00:20:01.000Z', capabilities: { scheduler: 'pending', gmail: 'pending', claudeCli: 'pending', grok: 'pending' }, dependencies: createNativeWorkerDependencies({ home: root, runner: async () => ({ suggestions: [] }) }), mode: 'manual' });
  assert.equal(worker.status, 'pending'); assert.equal(worker.reason, 'partial'); assert.equal(worker.pending.some(({ locator, reason }) => locator === ready.capture.locator && reason === 'cursor_timestamp_uncertain'), true);
  const state = await loadState(stateDir); assert.equal(state.events.length, 0); assert.equal(Object.hasOwn(state.worker.imports, ready.capture.locator), false);
  const outside = join(root, 'outside.jsonl'); await writeFile(outside, '{}\n');
  const rejected = await runHostHook({ host: 'cursor', home: root, stateDir, templateDir, now: () => '2027-01-23T00:00:01.000Z', payload: { ...payload, session_id: 'session-2', transcript_path: outside } });
  assert.equal(rejected.capture.reason, 'transcript_path_untrusted');
  await writeFile(join(templateDir, 'preference.json'), JSON.stringify({ version: 1, kind: 'advisory-reminder', event: 'sessionStart', reminder: 'Use {{dynamic}}.' }));
  assert.equal((await runHostHook({ host: 'cursor', home: root, stateDir, templateDir, now: () => '2027-01-23T00:00:02.000Z', payload })).advisory.status, 'pending');
}));

test('Cursor Stop usa conversation_id e relógio observado apenas como lifecycle source', async () => withFixture(async ({ root, stateDir, templateDir }) => {
  const transcript = join(root, '.cursor', 'projects', 'project-a', 'agent-transcripts', 'session.jsonl'); await mkdir(join(transcript, '..'), { recursive: true }); await writeFile(transcript, '{}\n');
  await runHostHook({ host: 'cursor', home: root, stateDir, templateDir, now: () => '2027-01-23T00:00:03.000Z', payload: { hookEventName: 'stop', conversation_id: 'conversation-1', transcript_path: transcript } });
  const state = await loadState(stateDir); assert.equal(state.events.length, 0); assert.equal(state.sources[0].session, 'conversation-1'); assert.equal(state.sources[0].occurredAt, '2027-01-23T00:00:03.000Z');
}));
