import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { catalogArtifacts, cursorTranscriptRoot, discoverHistoryRoots, fixedHistoryRoots, privateStateDir, renderAdvisoryReminder } from '../adapters.mjs';

test('uses one explicit private state location and fixed trusted history roots', () => {
  const home = join(tmpdir(), 'setup-learning-home'); const localAppData = join(home, 'AppData', 'Local');
  assert.equal(privateStateDir(localAppData), join(localAppData, 'setup-learning'));
  assert.throws(() => privateStateDir('relative'), /LOCALAPPDATA/);
  assert.deepEqual(fixedHistoryRoots(home), [
    { host: 'codex', path: join(home, '.codex', 'sessions'), locator: 'codex://sessions' },
    { host: 'claude', path: join(home, '.claude', 'projects'), locator: 'claude://projects' },
  ]);
});

test('accepts Cursor only through a regular transcript under its positive local allowlist', async () => {
  const home = await mkdtemp(join(tmpdir(), 'setup-learning-cursor-'));
  const path = join(home, '.cursor', 'projects', 'project-a', 'agent-transcripts', 'thread-a', 'session.jsonl');
  try {
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '{}\n');
    assert.equal((await cursorTranscriptRoot({}, home)).status, 'pending');
    const ready = await cursorTranscriptRoot({ transcript_path: path }, home);
    assert.deepEqual(ready, { host: 'cursor', path, locator: 'cursor://projects/project-a/agent-transcripts/thread-a/session.jsonl', status: 'ready' });
    assert.deepEqual(await discoverHistoryRoots(home, [{ host: 'cursor', event: 'SessionStart', session: 'session-1', occurredAt: '2027-01-23T00:00:00.000Z', locator: ready.locator }]), [{ host: 'cursor', path, locator: ready.locator, root: join(home, '.cursor', 'projects') }]);
    assert.equal((await cursorTranscriptRoot({ transcript_path: join(home, 'outside.jsonl') }, home)).reason, 'transcript_path_untrusted');
    assert.equal((await cursorTranscriptRoot({ transcript_path: join(home, '.cursor', 'projects', 'project-a', 'agent-transcripts', 'thread-a', 'subagents', 'child.jsonl') }, home)).reason, 'transcript_path_untrusted');
    const outside = join(home, 'outside'); const linked = join(home, '.cursor', 'projects', 'project-b', 'agent-transcripts', 'thread-b');
    await mkdir(outside); await writeFile(join(outside, 'session.jsonl'), '{}\n'); await mkdir(join(linked, '..'), { recursive: true }); await symlink(outside, linked, 'junction');
    assert.equal((await cursorTranscriptRoot({ transcript_path: join(linked, 'session.jsonl') }, home)).reason, 'transcript_path_untrusted');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('renders only a short static reviewed advisory with each native local contract', () => {
  const reminder = 'Prefira o helper existente antes de criar outro.';
  const template = { version: 1, kind: 'advisory-reminder', event: 'sessionStart', reminder };
  assert.deepEqual(renderAdvisoryReminder('cursor', template), { status: 'ready', output: { additional_context: reminder } });
  assert.deepEqual(renderAdvisoryReminder('codex', template), { status: 'ready', output: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reminder } } });
  assert.deepEqual(renderAdvisoryReminder('claude', template), { status: 'ready', output: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reminder } } });
  assert.throws(() => renderAdvisoryReminder('cursor', { ...template, command: 'node bad' }), /template/);
  assert.throws(() => renderAdvisoryReminder('cursor', { ...template, reminder: 'Use {{dynamic}}.' }), /template/);
  const secretLikeReminder = `${['to', 'ken'].join('')}=segredo-nao-pode`;
  assert.throws(() => renderAdvisoryReminder('cursor', { ...template, reminder: secretLikeReminder }), /template/);
});

test('discovers only real allowlisted transcripts and keeps disabled artifacts visible', async () => {
  const home = await mkdtemp(join(tmpdir(), 'setup-learning-native-'));
  try {
    const transcript = join(home, '.codex', 'sessions', '2026', 'session.jsonl'); await mkdir(join(transcript, '..'), { recursive: true }); await writeFile(transcript, '{}\n');
    await writeFile(join(transcript, '..', 'ignored.txt'), 'ignored');
    const skill = join(home, '.agents', 'skills', 'disabled-skill', 'SKILL.md'); await mkdir(join(skill, '..'), { recursive: true }); await writeFile(skill, '---\nname: disabled-skill\ndisabled-environments:\n  - codex\n---\n');
    const nativeDisabled = join(home, '.agents', 'skills', 'native-disabled', 'SKILL.md'); const nativeContent = Buffer.from('---\nname: native-disabled\ndescription: Capacidade observada no inventário nativo.\n---\n'); await mkdir(join(nativeDisabled, '..'), { recursive: true }); await writeFile(nativeDisabled, nativeContent);
    const pluginSkill = join(home, '.codex', 'plugins', 'cache', 'vendor', 'plugin', '1.0.0', 'skills', 'plugin-skill', 'SKILL.md'); const pluginContent = Buffer.from('---\nname: plugin-skill\ndescription: Capacidade fornecida por plugin instalado.\n---\n'); await mkdir(join(pluginSkill, '..'), { recursive: true }); await writeFile(pluginSkill, pluginContent);
    const multilineSkill = join(home, '.agents', 'skills', 'multiline', 'SKILL.md'); await mkdir(join(multilineSkill, '..'), { recursive: true }); await writeFile(multilineSkill, '---\nname: multiline\ndescription: >\n  Capacidade com resumo\n  em mais de uma linha.\n---\n');
    const roots = await discoverHistoryRoots(home);
    assert.deepEqual(roots, [{ host: 'codex', path: transcript, locator: 'codex://history/2026/session.jsonl', root: join(home, '.codex', 'sessions') }]);
    const catalog = await catalogArtifacts(home);
    assert.equal(catalog.length, 4); assert.equal(catalog.find(({ path }) => path.includes('disabled-skill')).enabled, false); assert.equal(catalog.find(({ path }) => path.includes('native-disabled')).enabled, 'unknown'); assert.equal(catalog.find(({ path }) => path.includes('plugin-skill')).enabled, 'unknown'); assert.equal(catalog.find(({ path }) => path.includes('/multiline/')).summary, 'Capacidade com resumo em mais de uma linha.');
    const observed = await catalogArtifacts(home, { source: 'skills/list', evidenceRef: 'skills-list:observed', observedAt: '2027-01-23T00:00:00.000Z', skills: [
      { path: '.agents/skills/native-disabled/SKILL.md', hash: createHash('sha256').update(nativeContent).digest('hex'), disabled: true },
      { path: '.codex/plugins/cache/vendor/plugin/1.0.0/skills/plugin-skill/SKILL.md', hash: createHash('sha256').update(pluginContent).digest('hex'), disabled: true },
    ] });
    assert.equal(observed.find(({ path }) => path.includes('native-disabled')).enabled, false); assert.equal(observed.find(({ path }) => path.includes('plugin-skill')).enabled, false); assert.match(observed[0].hash, /^[a-f0-9]{64}$/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
