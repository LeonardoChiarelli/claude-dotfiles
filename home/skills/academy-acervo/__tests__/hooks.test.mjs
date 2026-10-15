import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runHook } from '../hook.mjs';
import { captureConfigured, markPending } from '../host.mjs';

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'academy-hooks-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const config = (root, enabled = true) => ({ archiveRoot: root, activatedAt: '2026-10-14T12:00:00.000Z', enabled });
const event = (name, extras = {}) => ({ hook_event_name: name, session_id: 'session-1', turn_id: 'turn-1', cwd: 'C:/work', ...extras });
const record = (source = {}) => ({ source: { harness: 'codex', session: 'session-1', checkpoint: 'turn-1', activatedAt: '2026-10-14T12:00:00.000Z', occurredAt: '2026-10-14T12:01:00.000Z', source: { location: 'local' }, ...source }, context: 'Contexto sintético.', problem: 'Problema sintético.', decision: 'Decisão sintética.', reason: 'Motivo sintético.', alternatives: ['Alternativa sintética.'], result: { status: 'observed', summary: 'Resultado sintético.' }, evidence: ['Teste local.'], lesson: 'Lição sintética.', limits: 'Limite sintético.', category: 'engineering' });
const metadata = (result) => JSON.parse(result.hookSpecificOutput.additionalContext.match(/<ACADEMY_ACERVO>(.+)<\/ACADEMY_ACERVO>/)[1]);

test('adds only metadata-safe context and never echoes raw prompt or final assistant text', async () => withRoot(async (root) => {
  const result = await runHook({ harness: 'codex', config: config(root), configPath: 'C:/safe/config.json', hostPath: 'C:/safe/host.mjs', event: event('UserPromptSubmit', { prompt: 'private prompt secret@example.com' }) });
  assert.match(result.hookSpecificOutput.additionalContext, /acervo/i);
  assert.doesNotMatch(JSON.stringify(result), /private prompt|secret@example\.com/);
  assert.deepEqual(metadata(result), { harness: 'codex', session: 'session-1', checkpoint: 'turn-1', activatedAt: config(root).activatedAt, configPath: 'C:/safe/config.json', hostPath: 'C:/safe/host.mjs' });
}));

test('gives distinct trusted checkpoints to new Claude prompts without reading their content', async () => withRoot(async (root) => {
  const first = metadata(await runHook({ harness: 'claude', config: config(root), event: event('UserPromptSubmit', { turn_id: undefined, prompt: 'first private prompt' }) }));
  const second = metadata(await runHook({ harness: 'claude', config: config(root), event: event('UserPromptSubmit', { turn_id: undefined, prompt: 'same private prompt' }) }));
  assert.notEqual(first.checkpoint, second.checkpoint);
  assert.equal(first.session, second.session);
}));

test('does nothing when disabled or for an identified subagent', async () => withRoot(async (root) => {
  for (const input of [{ config: config(root, false), event: event('Stop') }, { config: config(root), event: event('Stop', { agent_id: 'subagent-1' }) }]) {
    assert.deepEqual(await runHook({ harness: 'codex', ...input }), {});
  }
}));

test('continues a checkpoint once and does not reset the guard on UserPromptSubmit', async () => withRoot(async (root) => {
  await markPending(config(root), { harness: 'codex', session: 'session-1', checkpoint: 'turn-1' });
  const first = await runHook({ harness: 'codex', config: config(root), event: event('Stop') });
  const prompt = await runHook({ harness: 'codex', config: config(root), event: event('UserPromptSubmit', { turn_id: 'turn-2' }) });
  const second = await runHook({ harness: 'codex', config: config(root), event: event('Stop', { stop_hook_active: true }) });
  assert.equal(first.decision, 'block');
  assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.deepEqual(second, {});
}));

test('a completed capture clears pending and continuation state for Codex', async () => withRoot(async (root) => {
  await markPending(config(root), { harness: 'codex', session: 'session-1', checkpoint: 'turn-1' });
  assert.equal((await runHook({ harness: 'codex', config: config(root), event: event('Stop') })).decision, 'block');
  await captureConfigured(config(root), record());
  assert.deepEqual(await runHook({ harness: 'codex', config: config(root), event: event('Stop') }), {});
}));

test('Claude Stop finds its opaque checkpoint once and capture clears it', async () => withRoot(async (root) => {
  const trusted = metadata(await runHook({ harness: 'claude', config: config(root), event: event('UserPromptSubmit', { turn_id: undefined }) }));
  await markPending(config(root), { harness: trusted.harness, session: trusted.session, checkpoint: trusted.checkpoint });
  assert.equal((await runHook({ harness: 'claude', config: config(root), event: event('Stop', { turn_id: undefined }) })).decision, 'block');
  assert.deepEqual(await runHook({ harness: 'claude', config: config(root), event: event('Stop', { turn_id: undefined, stop_hook_active: true }) }), {});
  await captureConfigured(config(root), record({ harness: 'claude', checkpoint: trusted.checkpoint }));
  assert.deepEqual(await runHook({ harness: 'claude', config: config(root), event: event('Stop', { turn_id: undefined }) }), {});
}));

test('privacy restrictions skip pending without creating operational state', async () => withRoot(async (root) => {
  for (const [field, reason] of [['optedOut', 'opted-out'], ['noWrite', 'no-write'], ['personal', 'personal']]) {
    assert.deepEqual(await markPending(config(root), { harness: 'codex', session: 'session-1', checkpoint: 'turn-1', [field]: true }), { status: 'skipped', reason });
  }
  await assert.rejects(readdir(join(root, 'acervo')), /ENOENT/);
}));

test('treats interrupt and session end as fast advisory metadata without continuation or inference', async () => withRoot(async (root) => {
  for (const name of ['Interrupt', 'SessionEnd']) {
    const result = await runHook({ harness: 'codex', config: config(root), event: event(name) });
    assert.deepEqual(result, {});
  }
}));
