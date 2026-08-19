#!/usr/bin/env node
/**
 * Local patch: fix false "The Vercel CLI is not installed" on Windows.
 *
 * Upstream bug in claude-plugins-official/vercel -> hooks/session-start-profiler.mjs
 * (function checkVercelCli):
 *
 *   1. getBinaryPathCandidates() tries the extension-less suffix FIRST. On Windows,
 *      `npm i -g vercel` writes three shims (vercel, vercel.cmd, vercel.ps1) and
 *      accessSync(path, X_OK) behaves like F_OK, so the resolver picks the bare
 *      `vercel` sh script, which CreateProcess cannot run -> ENOENT.
 *
 *   2. Even when it resolves to vercel.cmd, execFileSync without `shell: true`
 *      refuses .cmd/.bat since Node 18.20.2 / 20.12.2 (CVE-2024-27980) -> EINVAL.
 *
 * Either failure lands in the catch, returns { installed: false }, and the hook
 * injects "IMPORTANT: The Vercel CLI is not installed." into the model context.
 *
 * This script rewrites the compiled .mjs in every plugin cache it finds
 * (Claude Code and Codex). It is idempotent and keeps a .orig backup.
 * Re-run it after a plugin update, which restores the upstream file.
 *
 * Usage: node ~/.claude/scripts/patch-vercel-cli-detect.mjs [--check]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MARKER = "// [local-patch:win-cli-detect]";
const CHECK_ONLY = process.argv.includes("--check");

const SUFFIX_FROM = `const suffixes = hasExecutableExtension ? [""] : ["", ...WINDOWS_EXECUTABLE_EXTENSIONS];`;
const SUFFIX_TO = `const suffixes = hasExecutableExtension ? [""] : [...WINDOWS_EXECUTABLE_EXTENSIONS, ""]; ${MARKER} PATHEXT before bare name`;

const HELPER = `
${MARKER} run through cmd on Windows: execFileSync rejects .cmd/.bat without shell (CVE-2024-27980)
function execBinarySyncPatched(binary, args, options) {
  if (process.platform !== "win32") {
    return execFileSync(binary, args, options);
  }
  return execFileSync(\`"\${binary}"\`, args, { ...options, shell: true });
}
`;

const HELPER_ANCHOR = `function getBinaryPathCandidates(binaryName) {`;

function patchSource(source) {
  let out = source;

  if (!out.includes(SUFFIX_FROM)) {
    throw new Error("suffix-order anchor not found (upstream code changed?)");
  }
  out = out.replace(SUFFIX_FROM, SUFFIX_TO);

  if (!out.includes(HELPER_ANCHOR)) {
    throw new Error("helper anchor not found (upstream code changed?)");
  }
  out = out.replace(HELPER_ANCHOR, `${HELPER}${HELPER_ANCHOR}`);

  const callsBefore = (out.match(/execFileSync\((vercelBinary|npmBinary),/g) || []).length;
  if (callsBefore !== 2) {
    throw new Error(`expected 2 execFileSync call sites, found ${callsBefore}`);
  }
  out = out.replace(/execFileSync\((vercelBinary|npmBinary),/g, "execBinarySyncPatched($1,");

  return out;
}

function findTargets() {
  const home = homedir();
  const roots = [join(home, ".claude", "plugins", "cache"), join(home, ".codex", "plugins", "cache")];
  const targets = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const marketplace of readdirSync(root)) {
      const vercelDir = join(root, marketplace, "vercel");
      if (!existsSync(vercelDir)) continue;
      for (const version of readdirSync(vercelDir)) {
        const file = join(vercelDir, version, "hooks", "session-start-profiler.mjs");
        if (existsSync(file)) targets.push(file);
      }
    }
  }
  return targets;
}

const targets = findTargets();
if (targets.length === 0) {
  console.log("nenhum session-start-profiler.mjs encontrado.");
  process.exit(0);
}

let patched = 0;
let skipped = 0;
let failed = 0;

for (const file of targets) {
  const source = readFileSync(file, "utf-8");

  if (source.includes(MARKER)) {
    console.log(`[ok ] ja patchado: ${file}`);
    skipped++;
    continue;
  }

  if (CHECK_ONLY) {
    console.log(`[!! ] precisa de patch: ${file}`);
    failed++;
    continue;
  }

  try {
    const out = patchSource(source);
    const backup = `${file}.orig`;
    if (!existsSync(backup)) copyFileSync(file, backup);
    writeFileSync(file, out, "utf-8");
    console.log(`[fix] patchado: ${file}`);
    patched++;
  } catch (error) {
    console.log(`[err] ${file}: ${error.message}`);
    failed++;
  }
}

console.log(`\npatchados=${patched} ja-ok=${skipped} falhas=${failed}`);
process.exit(failed > 0 && CHECK_ONLY ? 1 : failed > 0 ? 1 : 0);
