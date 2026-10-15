import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { install } from '../install.mjs';

function runNode(path, input, args = [], cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [path, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
}

function trusted(stdout) {
  const result = JSON.parse(stdout);
  return JSON.parse(result.hookSpecificOutput.additionalContext.match(/<ACADEMY_ACERVO>(.+)<\/ACADEMY_ACERVO>/)[1]);
}

function record(metadata) {
  return { source: { harness: metadata.harness, session: metadata.session, checkpoint: metadata.checkpoint, activatedAt: metadata.activatedAt, occurredAt: '2026-10-14T12:01:00.000Z', source: { issue: 'LEO-236' } }, context: 'Contexto sintético.', problem: 'Problema sintético.', decision: 'Decisão sintética.', reason: 'Motivo sintético.', alternatives: ['Alternativa sintética.'], result: { status: 'observed', summary: `Resultado ${metadata.harness}.` }, evidence: ['Teste local.'], lesson: 'Lição sintética.', limits: 'Limite sintético.', category: 'engineering' };
}

test('installs a portable package and executes the documented flow for Codex and Claude', async () => {
  const home = await mkdtemp(join(tmpdir(), 'academy install '));
  try {
    const options = { home, archiveRoot: join(home, 'academy root'), activatedAt: '2026-10-14T12:00:00.000Z' };
    await mkdir(options.archiveRoot);
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node existing.mjs' }] }] } }));
    await install(options);

    const installed = join(home, '.agents', 'skills', 'academy-acervo');
    await runNode(join(installed, 'install.mjs'), '', ['--home', home, '--archive-root', options.archiveRoot, '--activated-at', '2026-11-01T00:00:00.000Z']);
    const configPath = join(home, 'academy-acervo.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.archiveRoot, await realpath(options.archiveRoot));
    assert.equal(config.activatedAt, options.activatedAt);

    const instructions = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8');
    assert.match(instructions, /turnos raiz substantivos/);
    assert.match(instructions, /Nunca execute a captura em subagentes/);
    assert.equal((instructions.match(/academy-acervo:start/g) ?? []).length, 1);

    const codexSettings = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(codexSettings.hooks.Stop.length, 2);
    assert.equal(codexSettings.hooks.Stop[1].hooks[0].command, 'node ~/.codex/hooks/academy-acervo.mjs');
    assert.equal((JSON.stringify(codexSettings).match(/academy-acervo\.mjs/g) ?? []).length, 5);
    const claudeSettings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.match(claudeSettings.hooks.Stop[0].hooks[0].command, /^node ~\//);

    for (const wrapper of [join(home, '.codex', 'hooks', 'academy-acervo.mjs'), join(home, '.claude', 'hooks', 'academy-acervo.mjs')]) {
      const source = await readFile(wrapper, 'utf8');
      assert.doesNotMatch(source, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    await writeFile(configPath, JSON.stringify({ ...config, enabled: true }));
    for (const harness of ['codex', 'claude']) {
      const wrapper = join(home, `.${harness === 'codex' ? 'codex' : 'claude'}`, 'hooks', 'academy-acervo.mjs');
      const prompt = { hook_event_name: 'UserPromptSubmit', session_id: `${harness}-session`, cwd: 'C:/synthetic', prompt: 'private prompt' };
      if (harness === 'codex') prompt.turn_id = 'turn-1';
      const metadata = trusted((await runNode(wrapper, JSON.stringify(prompt))).stdout);
      assert.equal(metadata.harness, harness);
      assert.equal(metadata.configPath, configPath);
      assert.equal(metadata.hostPath, join(home, harness === 'codex' ? '.agents' : '.claude', 'skills', 'academy-acervo', 'host.mjs'));

      const pendingPath = join(home, `${harness}-pending.json`);
      await writeFile(pendingPath, JSON.stringify({ harness: metadata.harness, session: metadata.session, checkpoint: metadata.checkpoint }));
      assert.match((await runNode(metadata.hostPath, '', ['pending', '--config', metadata.configPath, '--input', pendingPath])).stdout, /pending/);
      const stop = { hook_event_name: 'Stop', session_id: metadata.session, stop_hook_active: false };
      if (harness === 'codex') stop.turn_id = metadata.checkpoint;
      assert.equal(JSON.parse((await runNode(wrapper, JSON.stringify(stop))).stdout).decision, 'block');
      assert.deepEqual(JSON.parse((await runNode(wrapper, JSON.stringify({ ...stop, stop_hook_active: true }))).stdout), {});

      const recordPath = join(home, `${harness}-record.json`);
      await writeFile(recordPath, JSON.stringify(record(metadata)));
      assert.match((await runNode(metadata.hostPath, '', ['capture', '--config', metadata.configPath, '--input', recordPath])).stdout, /written/);
    }

    const objective = join(home, 'objective.json');
    await writeFile(objective, JSON.stringify({ objective: 'sintético' }));
    const curated = await runNode(join(installed, 'host.mjs'), '', ['curate', '--config', configPath, '--input', objective]);
    assert.match(curated.stdout, /^<DADOS_EXTERNOS>/);
    assert.match(curated.stdout, /Resultado codex/);
    assert.equal((await runNode(join(home, '.codex', 'hooks', 'academy-acervo.mjs'), 'not json')).stdout, '{}\n');

    const malformed = join(home, 'malformed.json');
    const token = `gh${'p'}_${'q'.repeat(36)}`;
    await writeFile(malformed, token);
    await assert.rejects(runNode(join(installed, 'host.mjs'), '', ['capture', '--config', configPath, '--input', malformed]), (error) => {
      assert.match(error.message, /invalid JSON input/);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('canonicalizes a relative archive root at install time', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'academy relative '));
  try {
    const home = join(sandbox, 'home');
    const projectA = join(sandbox, 'project-a');
    const projectB = join(sandbox, 'project-b');
    await mkdir(join(projectA, 'archive'), { recursive: true });
    await mkdir(projectB);
    await runNode(resolve(import.meta.dirname, '..', 'install.mjs'), '', ['--home', home, '--archive-root', 'archive', '--activated-at', '2026-10-14T12:00:00.000Z'], projectA);
    const config = JSON.parse(await readFile(join(home, 'academy-acervo.json'), 'utf8'));
    assert.equal(config.archiveRoot, join(projectA, 'archive'));
    assert.notEqual(resolve(projectB, config.archiveRoot), join(projectB, 'archive'));
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});
