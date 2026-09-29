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

// ── mcp.json secret stripping ───────────────────────────────────────────────
// Applied to env keys, header keys and argv flags alike: a credential reaches
// the repo through whichever of the three the server happens to use.
const SECRET_KEY = /key|token|secret|password|passwd|credential|authorization|bearer/i;
const SECRET_FLAG = /^--?[\w.-]*(?:key|token|secret|password|passwd|credential|bearer|auth)[\w.-]*$/i;

function redactArgs(args, name) {
  const out = [];
  let redactNext = false;
  for (const arg of args) {
    const s = String(arg);
    if (redactNext) {
      redactNext = false;
      // `--token-cache --verbose`: a flag following a flag is not its value.
      if (!s.startsWith('-')) { out.push(`{{SECRET:${name}.arg}}`); continue; }
    }
    const eq = s.indexOf('=');
    if (eq > 0 && SECRET_FLAG.test(s.slice(0, eq))) {
      out.push(`${s.slice(0, eq)}={{SECRET:${name}.arg}}`);
      continue;
    }
    if (SECRET_FLAG.test(s)) redactNext = true;
    out.push(s);
  }
  return out;
}

// ── export: machine -> repo (mirror with delete) ────────────────────────────
function cmdExport() {
  const srcFiles = listManifestFiles(CLAUDE_HOME);
  const seen = new Set(srcFiles);
  for (const rel of srcFiles) {
    const src = path.join(CLAUDE_HOME, rel);
    const dst = path.join(HOME_MIRROR, rel);
    copyFile(src, dst);
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
    for (const [name, cfg] of Object.entries(servers)) {
      for (const k of Object.keys(cfg.env || {})) {
        if (SECRET_KEY.test(k)) cfg.env[k] = `{{SECRET:${name}.env.${k}}}`;
      }
      // http/sse servers carry auth in headers ({"Authorization": "Bearer ..."}).
      for (const k of Object.keys(cfg.headers || {})) {
        if (SECRET_KEY.test(k)) cfg.headers[k] = `{{SECRET:${name}.header.${k}}}`;
      }
      // stdio servers carry it in argv (`--api-key=X` or `--api-key X`).
      if (Array.isArray(cfg.args)) cfg.args = redactArgs(cfg.args, name);
    }
    writeFile(path.join(REPO, 'mcp.json'), JSON.stringify(servers, null, 2) + '\n');
    log('ok', `mcp.json generated (${Object.keys(servers).length} servers)`);
  } else {
    log('skip', `no ${CLAUDE_JSON}`);
  }
}

// One argument, quoted for the shell that `spawnSync(..., {shell:true})` uses:
// cmd.exe on Windows (double quotes; inner quotes escaped the way the CRT
// argv parser the child uses expects), /bin/sh elsewhere (single quotes).
function shellArg(s) {
  const str = String(s);
  if (process.platform === 'win32') {
    return '"' + str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
  }
  return "'" + str.split("'").join(`'\\''`) + "'";
}

// ── install: repo -> machine (merge, never delete machine-only files) ───────
function cmdInstall() {
  const files = listManifestFiles(HOME_MIRROR);
  if (files.length === 0) {
    console.error('install: home/ mirror is empty — run export first or check the clone');
    process.exit(1);
  }
  for (const rel of files) {
    const src = path.join(HOME_MIRROR, rel);
    const dst = path.join(CLAUDE_HOME, rel);
    copyFile(src, dst);
  }
  log('ok', `${files.length} files installed into ${CLAUDE_HOME}`);

  if (fs.existsSync(MEMORY_MIRROR)) {
    const memDst = memoryDir(CLAUDE_HOME);
    const memFiles = walk(MEMORY_MIRROR);
    for (const rel of memFiles) copyFile(path.join(MEMORY_MIRROR, rel), path.join(memDst, rel));
    log('ok', `memory merged into ${memDst} (${memFiles.length} files; machine-only files kept)`);
  }

  if (!NO_MCP && fs.existsSync(path.join(REPO, 'mcp.json'))) {
    const servers = JSON.parse(fs.readFileSync(path.join(REPO, 'mcp.json'), 'utf8'));
    const existing = fs.existsSync(CLAUDE_JSON)
      ? (JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')).mcpServers || {})
      : {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (existing[name]) { log('skip', `mcp ${name} already registered`); continue; }
      const json = JSON.stringify(cfg);
      if (json.includes('{{SECRET:')) {
        log('warn', `mcp ${name} needs secrets filled in — register manually: claude mcp add-json ${name} '<json with secrets>' --scope user`);
        continue;
      }
      if (DRY) { log('dry', `claude mcp add-json ${name}`); continue; }
      // shell:true is required (`claude` is a .cmd shim on Windows, which Node
      // refuses to spawn directly), and the shell re-parses the command line —
      // so the JSON argument must be quoted for that shell by hand. Passing it
      // as an argv array instead would strip the quotes and hand the CLI
      // `{type:http,...}`, which never parses.
      const line = ['claude', 'mcp', 'add-json', shellArg(name), shellArg(json), '--scope', 'user'].join(' ');
      const r = spawnSync(line, { shell: true, stdio: 'pipe', encoding: 'utf8' });
      if (r.status === 0) log('ok', `mcp ${name} registered`);
      else log('warn', `mcp ${name} failed (${(r.stderr || '').trim() || 'claude CLI not found?'}) — run manually: ${line}`);
    }
  }

  log('note', 'settings.json is not versioned: configure plugins, marketplaces, hooks and permissions manually (see README)');
}

// settings.json / settings.local.json are machine-local and must never be
// versioned. Fails the command if either shows up anywhere in the repo.
function assertNoSettingsFiles() {
  const found = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!['node_modules', '.git', '.worktrees'].includes(e.name)) visit(path.join(dir, e.name));
      } else if (e.name === 'settings.json' || e.name === 'settings.local.json') {
        found.push(path.relative(REPO, path.join(dir, e.name)));
      }
    }
  };
  visit(REPO);
  if (found.length) {
    console.error('settings.json / settings.local.json must NEVER be versioned (machine-local). Remove:');
    for (const f of found) console.error('  ' + f);
    process.exit(1);
  }
}

// ── roundtrip: export, install into a temp home, compare — proves both paths ─
function cmdRoundtrip() {
  cmdExport();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dotfiles-rt-'));
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), 'install', '--no-mcp'],
    { env: { ...process.env, CLAUDE_HOME: tmp }, stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.error('roundtrip: install failed');
    process.exit(1);
  }
  let fail = 0;
  assertNoSettingsFiles();
  const srcFiles = listManifestFiles(CLAUDE_HOME);
  for (const rel of srcFiles) {
    const aPath = path.join(CLAUDE_HOME, rel);
    const bPath = path.join(tmp, rel);
    if (!fs.existsSync(bPath)) { console.error(`[FAIL] missing after install: ${rel}`); fail++; continue; }
    if (!fs.readFileSync(aPath).equals(fs.readFileSync(bPath))) {
      console.error(`[FAIL] content mismatch: ${rel}`); fail++;
    }
  }
  const memSrc = memoryDir(CLAUDE_HOME);
  if (fs.existsSync(memSrc)) {
    for (const rel of walk(memSrc)) {
      const bPath = path.join(memoryDir(tmp), rel);
      if (!fs.existsSync(bPath) || !fs.readFileSync(path.join(memSrc, rel)).equals(fs.readFileSync(bPath))) {
        console.error(`[FAIL] memory mismatch: ${rel}`); fail++;
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fail) { console.error(`roundtrip: ${fail} mismatches`); process.exit(1); }
  console.log(`roundtrip: OK (${srcFiles.length} config files + memory verified)`);
}

// ── scan: heuristic secret scan over pending repo changes (or one file) ─────
// Flags lines like `api_key = "abc123..."`: secret-ish keyword, then a long
// value containing at least one digit (cuts code false-positives like
// `const tokenCount = estimateTokens(text)`). Template placeholders allowed.
const SECRET_LINE =
  /(key|token|secret|password|passwd|credential|authorization|bearer)[\w-]*["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+)?(?=[A-Za-z0-9_\-./+]*\d)[A-Za-z0-9_\-./+]{16,}/i;
const SCAN_ALLOW = [
  /\{\{SECRET:/,
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

// A credential sitting alone in a JSON string (argv element, header value)
// carries no keyword on its line, so SECRET_LINE cannot see it. Inside mcp.json
// every string is a command, a URL, a flag or a token — narrow enough to judge
// by shape: long, opaque, mixed letters+digits, no spaces or scheme.
function looksLikeToken(value) {
  const s = String(value).replace(/^(?:Bearer|Basic|token)\s+/i, '');
  if (s.length < 24) return false;
  if (!/^[A-Za-z0-9_\-+/=.]+$/.test(s)) return false; // rules out URLs, @scopes, paths with spaces
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return false;
  if (/\.(mjs|cjs|js|ts|json|exe|sh|ps1|py)$/i.test(s)) return false;
  if (/\{\{SECRET:/.test(s)) return false;
  return true;
}

function scanMcpValues(node, label, hits = []) {
  if (typeof node === 'string') {
    if (looksLikeToken(node)) hits.push(`${label}: ${node.slice(0, 24)}… (opaque token-shaped value)`);
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => scanMcpValues(v, `${label}[${i}]`, hits));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) scanMcpValues(v, `${label}.${k}`, hits);
  }
  return hits;
}

function cmdScan(fileArg) {
  let hits = [];
  if (fileArg) {
    hits = scanText(fs.readFileSync(fileArg, 'utf8'), fileArg);
  } else {
    assertNoSettingsFiles();
    const mcpPath = path.join(REPO, 'mcp.json');
    if (fs.existsSync(mcpPath)) {
      try {
        hits.push(...scanMcpValues(JSON.parse(fs.readFileSync(mcpPath, 'utf8')), 'mcp.json'));
      } catch { /* malformed mcp.json — the JSON parse in export would have failed first */ }
    }
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
  install: cmdInstall,
  roundtrip: cmdRoundtrip,
  scan: () => cmdScan(positional[1]),
};
if (!commands[cmd]) {
  console.error('usage: node tools/dotfiles.mjs <export|install|roundtrip|scan> [--dry-run] [--no-mcp] [file]');
  process.exit(2);
}
commands[cmd]();
