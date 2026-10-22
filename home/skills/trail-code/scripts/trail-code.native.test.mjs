import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { checkMap, ensureMap, queryMap, verifyMap } from "./trail-code.mjs";

const execFileAsync = promisify(execFile);
const cli = join(process.env.APPDATA || "", "npm", "node_modules", "@trailhq", "trail-code", "dist", "bin", "trail.js");
const roots = [];

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `trail-native-${name}-`));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "src"));
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("CLI 0.23.0 mantém mapa local fresco, isolado e sem diretórios ocultos", { skip: !existsSync(cli), timeout: 120_000 }, async () => {
  assert.equal(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim(), "0.23.0");
  const first = fixture("a");
  const second = fixture("b");
  writeFileSync(join(first, "src", "service.ts"), "export function visibleAlpha() { return 1; }\n");
  mkdirSync(join(first, ".credentials"));
  writeFileSync(join(first, ".credentials", "secret.ts"), "export const HIDDEN_TRAIL_SENTINEL = 'synthetic';\n");
  writeFileSync(join(first, ".env"), "TRAIL_SYNTHETIC_SECRET=synthetic\n");
  writeFileSync(join(second, "src", "other.ts"), "export function isolatedBeta() { return 2; }\n");

  const outside = fixture("ignore-targets");
  const gitignoreTarget = join(outside, "gitignore.txt");
  const ignoreTarget = join(outside, "ignore.txt");
  writeFileSync(gitignoreTarget, "preservar gitignore\n");
  writeFileSync(ignoreTarget, "preservar ignore\n");
  symlinkSync(gitignoreTarget, join(first, ".gitignore"), "file");
  symlinkSync(ignoreTarget, join(first, ".ignore"), "file");

  assert.equal(ensureMap(first).fresh, true);
  assert.equal(ensureMap(second).fresh, true);
  assert.equal(readFileSync(gitignoreTarget, "utf8"), "preservar gitignore\n");
  assert.equal(readFileSync(ignoreTarget, "utf8"), "preservar ignore\n");
  assert.match(queryMap(first, "grep", ["visibleAlpha"]).stdout, /visibleAlpha/);
  assert.doesNotMatch(queryMap(first, "grep", ["HIDDEN_TRAIL_SENTINEL"]).stdout, /secret\.ts|HIDDEN_TRAIL_SENTINEL/);
  assert.doesNotMatch(queryMap(first, "grep", ["isolatedBeta"]).stdout, /other\.ts/);
  assert.doesNotMatch(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: first, encoding: "utf8" }), /(?:^|[\\/])graft[\\/]/m);

  renameSync(join(first, "src", "service.ts"), join(first, "src", "renamed.ts"));
  writeFileSync(join(first, "src", "renamed.ts"), "export function visibleGammaLonger() { return 3; }\n");
  assert.equal(ensureMap(first).fresh, true);
  assert.doesNotMatch(queryMap(first, "grep", ["visibleAlpha"]).stdout, /service\.ts|visibleAlpha/);
  assert.match(queryMap(first, "grep", ["visibleGammaLonger"]).stdout, /renamed\.ts/);
  assert.equal(verifyMap(first).fresh, true);

  writeFileSync(join(first, "src", "renamed.ts"), "export function visibleDelta() { return 4; }\n");
  const wrapper = fileURLToPath(new URL("./trail-code.mjs", import.meta.url));
  const runs = await Promise.allSettled([
    execFileAsync(process.execPath, [wrapper, "ensure", "--repo", first], { windowsHide: true }),
    execFileAsync(process.execPath, [wrapper, "ensure", "--repo", first], { windowsHide: true }),
  ]);
  assert.equal(runs.some((result) => result.status === "fulfilled"), true);
  assert.equal(checkMap(first).fresh, true);
});
