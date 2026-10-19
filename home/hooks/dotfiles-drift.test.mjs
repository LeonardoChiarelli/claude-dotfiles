import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('dotfiles-drift.mjs', import.meta.url));

function run(home, filePath) {
  const result = spawnSync(process.execPath, [hook], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: JSON.stringify({
      session_id: `drift-${process.pid}-${Math.random()}`,
      tool_input: { file_path: filePath },
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('linked shared skill does not ask for a claude-dotfiles sync', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-home-'));
  const claude = path.join(home, '.claude');
  const target = path.join(home, '.agents', 'skills', 'to-issues');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(claude, 'skills'), { recursive: true });
  fs.symlinkSync(target, path.join(claude, 'skills', 'to-issues'), 'dir');
  const out = run(home, path.join(claude, 'skills', 'to-issues', 'SKILL.md'));
  assert.equal(out, '');
});

test('a real Claude config write still asks for sync', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-home-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const out = run(home, path.join(claude, 'CLAUDE.md'));
  assert.match(out, /sync-dotfiles/);
});
