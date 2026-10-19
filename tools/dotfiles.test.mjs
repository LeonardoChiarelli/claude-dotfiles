import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'tools', 'dotfiles.mjs');

const SHARED_SKILLS = [
  'academy-acervo',
  'entrega',
  'find-skills',
  'git-guardrails',
  'graphify',
  'grill-with-docs',
  'novo-projeto-chiarelli',
  'remotion-best-practices',
  'setup-engineering-pipeline',
  'stripe-best-practices',
  'stripe-projects',
  'sync-dotfiles',
  'to-issues',
  'to-prd',
  'triage',
  'two-axis-review',
  'upgrade-stripe',
  'video-editor',
];
const LINKED_SKILLS = [...SHARED_SKILLS, 'shell'];

function run(args, env) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('repo no longer carries shared skill copies', () => {
  for (const skill of SHARED_SKILLS) {
    assert.equal(
      fs.existsSync(path.join(repo, 'home', 'skills', skill)),
      false,
      `home/skills/${skill} should not be versioned`,
    );
  }
});

test('install dry-run plans links and writes nothing', () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-dry-'));
  const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-'));
  const result = run(['install', '--dry-run', '--no-mcp'], {
    CLAUDE_HOME: claude,
    AGENTS_SKILLS: agents,
  });
  assert.equal(result.status, 0, result.stderr);
  const links = result.stdout.split('\n').filter((line) => line.includes('[dry] link '));
  assert.equal(links.length, LINKED_SKILLS.length);
  for (const skill of LINKED_SKILLS) {
    assert.equal(fs.existsSync(path.join(claude, 'skills', skill)), false, skill);
    assert.match(result.stdout, new RegExp(`link .*skills[/\\\\]${skill} ->`));
  }
  assert.doesNotMatch(result.stdout, /\[ok\]\s+linked /);
  assert.doesNotMatch(result.stdout, /\[dry\] copy .*[/\\]skills[/\\](to-issues|entrega|shell)[/\\]/);
});

test('install links a missing shared skill and does not copy bytes', () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-link-'));
  const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-'));
  const target = path.join(agents, 'to-issues');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'codex-owned\n');

  const result = run(['install', '--no-mcp'], {
    CLAUDE_HOME: claude,
    AGENTS_SKILLS: agents,
  });
  assert.equal(result.status, 0, result.stderr);

  const dst = path.join(claude, 'skills', 'to-issues');
  const st = fs.lstatSync(dst);
  assert.equal(st.isSymbolicLink(), true);
  assert.equal(path.resolve(fs.readlinkSync(dst)), path.resolve(target));
  assert.equal(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8'), 'codex-owned\n');
  assert.match(result.stdout, /\[ok\]\s+linked skills\/to-issues/);
  assert.equal(fs.existsSync(path.join(claude, 'CLAUDE.md')), true);

  const again = run(['install', '--no-mcp'], {
    CLAUDE_HOME: claude,
    AGENTS_SKILLS: agents,
  });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /\[skip\] skills\/to-issues already links/);
  assert.equal(fs.lstatSync(dst).isSymbolicLink(), true);
});

test('install skips a non-link file and a non-link directory', () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-conflict-'));
  const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-'));
  fs.mkdirSync(path.join(agents, 'to-prd'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'to-prd', 'SKILL.md'), 'codex-owned\n');
  fs.mkdirSync(path.join(agents, 'triage'), { recursive: true });

  const fileConflict = path.join(claude, 'skills', 'to-prd');
  fs.mkdirSync(path.dirname(fileConflict), { recursive: true });
  fs.writeFileSync(fileConflict, 'local-file\n');

  const dirConflict = path.join(claude, 'skills', 'triage');
  fs.mkdirSync(dirConflict, { recursive: true });
  fs.writeFileSync(path.join(dirConflict, 'SKILL.md'), 'local-dir\n');

  const result = run(['install', '--no-mcp'], {
    CLAUDE_HOME: claude,
    AGENTS_SKILLS: agents,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(fileConflict, 'utf8'), 'local-file\n');
  assert.equal(fs.lstatSync(fileConflict).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(dirConflict, 'SKILL.md'), 'utf8'), 'local-dir\n');
  assert.equal(fs.lstatSync(dirConflict).isSymbolicLink(), false);
  assert.match(result.stdout, /\[conflict\] skills\/to-prd exists and is not a symlink or junction/);
  assert.match(result.stdout, /\[conflict\] skills\/triage exists and is not a symlink or junction/);
  assert.equal(fs.existsSync(path.join(agents, 'to-prd', 'SKILL.md')) && fs.readFileSync(path.join(agents, 'to-prd', 'SKILL.md'), 'utf8'), 'codex-owned\n');
});

test('install skips when skills root already points at agents skills', () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-alias-'));
  const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-'));
  fs.mkdirSync(path.join(agents, 'to-issues'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'to-issues', 'SKILL.md'), 'codex-owned\n');
  fs.symlinkSync(agents, path.join(claude, 'skills'), 'dir');

  const before = fs.readdirSync(agents).sort();
  const result = run(['install', '--no-mcp'], {
    CLAUDE_HOME: claude,
    AGENTS_SKILLS: agents,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[skip\]/);
  assert.doesNotMatch(result.stdout, /\[ok\]\s+linked /);
  assert.deepEqual(fs.readdirSync(agents).sort(), before);
  assert.equal(fs.lstatSync(path.join(claude, 'skills')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(agents, 'to-issues', 'SKILL.md'), 'utf8'), 'codex-owned\n');
  for (const name of fs.readdirSync(agents)) {
    assert.equal(fs.lstatSync(path.join(agents, name)).isSymbolicLink(), false, name);
  }
  assert.equal(fs.existsSync(path.join(agents, 'entrega')), false);
  assert.throws(
    () => fs.statSync(path.join(agents, 'entrega')),
    (err) => err.code === 'ENOENT',
  );
});

test('install still links when the agents skills directory does not exist yet', () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-missing-'));
  const agents = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-')), 'skills');
  assert.equal(fs.existsSync(agents), false);
  const result = run(['install', '--no-mcp'], {
    CLAUDE_HOME: claude,
    AGENTS_SKILLS: agents,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /does not exist yet/);
  assert.match(result.stdout, /\[ok\]\s+linked skills\/to-issues/);
  assert.equal(fs.lstatSync(path.join(claude, 'skills', 'to-issues')).isSymbolicLink(), true);
  assert.doesNotMatch(result.stderr, /ELOOP/);
});

test('install continues when skills is a broken link to a missing agents tree', () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-broken-'));
  const agents = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-')), 'skills');
  assert.equal(fs.existsSync(agents), false);
  fs.symlinkSync(agents, path.join(claude, 'skills'), 'dir');

  const result = run(['install', '--no-mcp'], {
    CLAUDE_HOME: claude,
    AGENTS_SKILLS: agents,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[warn\].*run the Codex install first/);
  assert.doesNotMatch(result.stdout, /\[ok\]\s+linked /);
  assert.equal(fs.existsSync(agents), false);
  assert.equal(fs.lstatSync(path.join(claude, 'skills')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(claude, 'CLAUDE.md')), true);
  const mem = path.join(
    claude,
    'projects',
    os.homedir().replace(/[^a-zA-Z0-9]/g, '-'),
    'memory',
    'MEMORY.md',
  );
  assert.equal(fs.existsSync(mem), true);
  assert.match(result.stdout, /memory merged/);
});

test('install treats a ..shared directory as inside agents skills', () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-dotdot-'));
  const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-'));
  const inside = path.join(agents, '..shared');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'keep.txt'), 'stay\n');
  fs.symlinkSync(inside, path.join(claude, 'skills'), 'dir');

  const result = run(['install', '--no-mcp'], {
    CLAUDE_HOME: claude,
    AGENTS_SKILLS: agents,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[skip\]/);
  assert.doesNotMatch(result.stdout, /\[ok\]\s+linked /);
  assert.deepEqual(fs.readdirSync(inside), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(inside, 'keep.txt'), 'utf8'), 'stay\n');
});

test('export dry-run does not copy a shared skill into the repo', () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-export-'));
  const skillDir = path.join(claude, 'skills', 'entrega');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'from-machine\n');
  fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'local\n');

  const result = run(['export', '--dry-run'], {
    CLAUDE_HOME: claude,
    CLAUDE_JSON: path.join(claude, 'missing.json'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /home\/skills\/entrega is shared and owned by Codex-dotfiles/);
  assert.doesNotMatch(result.stdout, /copy .*skills[/\\]entrega/);
  assert.equal(fs.existsSync(path.join(repo, 'home', 'skills', 'entrega', 'SKILL.md')), false);
});
