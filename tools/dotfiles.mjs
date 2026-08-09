#!/usr/bin/env node
// claude-dotfiles core: manifest-driven sync between ~/.claude and this repo.
// Zero npm dependencies — Node builtins only (fresh machines have no node_modules).
// Subcommands: export (machine -> repo), install (repo -> machine, Task 3),
// scan (secret scan), roundtrip (self-test, Task 4).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
const CLAUDE_JSON = process.env.CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
const HOME_MIRROR = path.join(REPO, 'home');
const MEMORY_MIRROR = path.join(REPO, 'memory');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
const DRY = process.argv.includes('--dry-run');
const NO_MCP = process.argv.includes('--no-mcp');

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);
// A path as it appears inside a JSON string (backslashes doubled).
const jsonEsc = (s) => JSON.stringify(s).slice(1, -1);
const projectKey = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const memoryDir = (claudeHome) =>
  path.join(claudeHome, 'projects', projectKey(os.homedir()), 'memory');

function excluded(relPath) {
  const parts = relPath.split(/[\\/]/);
  const base = parts[parts.length - 1];
  if (manifest.excludeBasenames.includes(base)) return true;
  if (manifest.excludeBasenameContains.some((s) => base.includes(s))) return true;
  if (parts.some((seg) => manifest.excludeSegments.includes(seg))) return true;
  return false;
}

// All files under root/rel (recursive), as root-relative paths, excludes applied.
function walk(root, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, entry.name) : entry.name;
    if (excluded(r)) continue;
    if (entry.isDirectory()) out.push(...walk(root, r));
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

// Files under root selected by the manifest include list. Missing includes are
// skipped silently (e.g., keybindings.json absent on a machine).
function listManifestFiles(root) {
  const files = [];
  for (const inc of manifest.include) {
    const abs = path.join(root, inc);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) files.push(...walk(root, inc));
    else if (!excluded(inc)) files.push(inc);
  }
  return files;
}

function copyFile(src, dst) {
  if (DRY) return log('dry', `copy ${src} -> ${dst}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function writeFile(dst, content) {
  if (DRY) return log('dry', `write ${dst}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
}

// ── settings.json templating ────────────────────────────────────────────────
// Machine-specific absolute paths <-> tokens, operating on the raw JSON text
// (paths appear JSON-escaped inside it). Reversible by construction.
function tokenPairs(claudeHome) {
  return [
    [jsonEsc(claudeHome), '{{CLAUDE_HOME}}'],
    [jsonEsc(process.execPath), '{{NODE}}'],
  ];
}
function sanitizeSettings(raw, claudeHome) {
  let out = raw;
  for (const [real, token] of tokenPairs(claudeHome)) out = out.split(real).join(token);
  return out;
}
function renderSettings(raw, claudeHome) {
  let out = raw;
  for (const [real, token] of tokenPairs(claudeHome)) out = out.split(token).join(real);
  return out;
}

// ── export: machine -> repo (mirror with delete) ────────────────────────────
function cmdExport() {
  const srcFiles = listManifestFiles(CLAUDE_HOME);
  const seen = new Set(srcFiles);
  for (const rel of srcFiles) {
    const src = path.join(CLAUDE_HOME, rel);
    const dst = path.join(HOME_MIRROR, rel);
    if (manifest.templated.includes(rel)) {
      writeFile(dst, sanitizeSettings(fs.readFileSync(src, 'utf8'), CLAUDE_HOME));
    } else {
      copyFile(src, dst);
    }
  }
  if (fs.existsSync(HOME_MIRROR)) {
    for (const rel of listManifestFiles(HOME_MIRROR)) {
      if (seen.has(rel)) continue;
      if (DRY) log('dry', `delete home/${rel}`);
      else fs.rmSync(path.join(HOME_MIRROR, rel));
      log('del', `home/${rel} (no longer on machine)`);
    }
  }
  log('ok', `home/ mirrored (${srcFiles.length} files)`);

  const memSrc = memoryDir(CLAUDE_HOME);
  if (fs.existsSync(memSrc)) {
    const memFiles = walk(memSrc);
    const memSeen = new Set(memFiles);
    for (const rel of memFiles) copyFile(path.join(memSrc, rel), path.join(MEMORY_MIRROR, rel));
    if (fs.existsSync(MEMORY_MIRROR)) {
      for (const rel of walk(MEMORY_MIRROR)) {
        if (memSeen.has(rel)) continue;
        if (DRY) log('dry', `delete memory/${rel}`);
        else fs.rmSync(path.join(MEMORY_MIRROR, rel));
      }
    }
    log('ok', `memory/ mirrored (${memFiles.length} files)`);
  } else {
    log('skip', `no memory dir at ${memSrc}`);
  }

  if (fs.existsSync(CLAUDE_JSON)) {
    const servers = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')).mcpServers || {};
    const SECRET_KEY = /key|token|secret|password|passwd|credential/i;
    for (const [name, cfg] of Object.entries(servers)) {
      for (const k of Object.keys(cfg.env || {})) {
        if (SECRET_KEY.test(k)) cfg.env[k] = `{{SECRET:${name}.${k}}}`;
      }
    }
    writeFile(path.join(REPO, 'mcp.json'), JSON.stringify(servers, null, 2) + '\n');
    log('ok', `mcp.json generated (${Object.keys(servers).length} servers)`);
  } else {
    log('skip', `no ${CLAUDE_JSON}`);
  }
}

// ── scan: heuristic secret scan over pending repo changes (or one file) ─────
// Flags lines like `api_key = "abc123..."`: secret-ish keyword, then a long
// value containing at least one digit (cuts code false-positives like
// `const tokenCount = estimateTokens(text)`). Template placeholders allowed.
const SECRET_LINE =
  /(key|token|secret|password|passwd|credential)[\w-]*["']?\s*[:=]\s*["']?(?=[A-Za-z0-9_\-./+]*\d)[A-Za-z0-9_\-./+]{16,}/i;
const SCAN_ALLOW = [
  /\{\{SECRET:/, /\{\{CLAUDE_HOME\}\}/, /\{\{NODE\}\}/,
  // `validKeys = util2.objectKeys(obj)`: the value is a call expression, not a
  // literal. Credentials are always literals, so this only clears code (it hit
  // the bundled zod in hooks/schema.bundle.*). A quoted value still gets flagged.
  /[:=]\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*\(/,
];

function scanText(text, label) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (SECRET_LINE.test(line) && !SCAN_ALLOW.some((a) => a.test(line))) {
      hits.push(`${label}:${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  });
  return hits;
}

function cmdScan(fileArg) {
  let hits = [];
  if (fileArg) {
    hits = scanText(fs.readFileSync(fileArg, 'utf8'), fileArg);
  } else {
    const diff = execFileSync('git', ['-C', REPO, 'diff', 'HEAD'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    hits.push(...scanText(added.join('\n'), 'diff'));
    const untracked = execFileSync(
      'git', ['-C', REPO, 'ls-files', '--others', '--exclude-standard'],
      { encoding: 'utf8' },
    ).trim();
    for (const f of untracked ? untracked.split('\n') : []) {
      try {
        hits.push(...scanText(fs.readFileSync(path.join(REPO, f), 'utf8'), f));
      } catch { /* binary or unreadable — skip */ }
    }
  }
  if (hits.length) {
    console.error('POSSIBLE SECRETS FOUND — commit aborted. Review:');
    for (const h of hits) console.error('  ' + h);
    process.exit(1);
  }
  console.log('scan: clean');
}

// ── dispatch ────────────────────────────────────────────────────────────────
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const cmd = positional[0];
const commands = {
  export: cmdExport,
  scan: () => cmdScan(positional[1]),
};
if (!commands[cmd]) {
  console.error('usage: node tools/dotfiles.mjs <export|install|roundtrip|scan> [--dry-run] [--no-mcp] [file]');
  process.exit(2);
}
commands[cmd]();
