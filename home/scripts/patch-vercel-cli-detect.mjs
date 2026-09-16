#!/usr/bin/env node
/**
 * Corrige o falso negativo da deteccao da Vercel CLI no Windows.
 *
 * O plugin tenta executar primeiro o shim sem extensao e depois um .cmd sem
 * shell. No Windows, esses caminhos podem falhar com ENOENT ou EINVAL mesmo
 * quando a CLI esta instalada. O patch prioriza PATHEXT e usa shell para os
 * shims do Windows.
 *
 * O script e idempotente, mantem um backup .orig e roda no SessionStart para
 * se recuperar automaticamente quando uma atualizacao sobrescreve o cache.
 */

import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKER = "// [local-patch:win-cli-detect]";
const CHECK_ONLY = process.argv.includes("--check");

const SUFFIX_FROM =
  'const suffixes = hasExecutableExtension ? [""] : ["", ...WINDOWS_EXECUTABLE_EXTENSIONS];';
const SUFFIX_TO =
  'const suffixes = hasExecutableExtension ? [""] : [...WINDOWS_EXECUTABLE_EXTENSIONS, ""]; // [local-patch:win-cli-detect] PATHEXT before bare name';

const HELPER = `
${MARKER} run through cmd on Windows: execFileSync rejects .cmd/.bat without shell (CVE-2024-27980)
function execBinarySyncPatched(binary, args, options) {
  if (process.platform !== "win32") {
    return execFileSync(binary, args, options);
  }
  return execFileSync(\`"\${binary}"\`, args, { ...options, shell: true });
}
`;

const HELPER_ANCHOR = "function getBinaryPathCandidates(binaryName) {";

function patchSource(source) {
  let output = source;

  if (!output.includes(SUFFIX_FROM)) {
    throw new Error("suffix-order anchor not found (upstream code changed?)");
  }
  output = output.replace(SUFFIX_FROM, SUFFIX_TO);

  if (!output.includes(HELPER_ANCHOR)) {
    throw new Error("helper anchor not found (upstream code changed?)");
  }
  output = output.replace(HELPER_ANCHOR, `${HELPER}${HELPER_ANCHOR}`);

  const callCount =
    (output.match(/execFileSync\((vercelBinary|npmBinary),/g) || []).length;
  if (callCount !== 2) {
    throw new Error(`expected 2 execFileSync call sites, found ${callCount}`);
  }
  return output.replace(
    /execFileSync\((vercelBinary|npmBinary),/g,
    "execBinarySyncPatched($1,",
  );
}

function findTargets() {
  const home = homedir();
  const roots = [
    join(home, ".claude", "plugins", "cache"),
    join(home, ".codex", "plugins", "cache"),
  ];
  const targets = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const marketplace of readdirSync(root)) {
      const vercelDir = join(root, marketplace, "vercel");
      if (!existsSync(vercelDir)) continue;
      for (const version of readdirSync(vercelDir)) {
        const file = join(
          vercelDir,
          version,
          "hooks",
          "session-start-profiler.mjs",
        );
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
    skipped++;
    continue;
  }

  if (CHECK_ONLY) {
    console.error(`[vercel-cli-detect] precisa de patch: ${file}`);
    failed++;
    continue;
  }

  try {
    accessSync(file, constants.W_OK);
    const output = patchSource(source);
    const backup = `${file}.orig`;
    if (!existsSync(backup)) copyFileSync(file, backup);
    writeFileSync(file, output, "utf-8");
    patched++;
  } catch (error) {
    console.error(`[vercel-cli-detect] ${file}: ${error.message}`);
    failed++;
  }
}

if (patched > 0 || failed > 0) {
  console.log(
    `[vercel-cli-detect] patchados=${patched} ja-ok=${skipped} falhas=${failed}`,
  );
}

process.exit(failed > 0 ? 1 : 0);
