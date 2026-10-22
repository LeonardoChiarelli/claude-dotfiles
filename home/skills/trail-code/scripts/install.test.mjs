import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exposeClaudeSkill, install, mergeHooks } from "./install.mjs";

const roots = [];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function root() {
  const path = mkdtempSync(join(tmpdir(), "trail-install-"));
  roots.push(path);
  return path;
}

test.after(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
});

test.afterEach(() => {
  delete process.env.TRAIL_CODE_BIN;
  delete process.env.TRAIL_INSTALL_LOG;
});

test("merge é idempotente e preserva entradas alheias", () => {
  const foreign = { matcher: "Edit", hooks: [{ type: "command", command: "node keep.mjs", timeout: 3 }] };
  const mixed = { matcher: "Write", note: "keep", hooks: [{ type: "command", command: "node keep-mixed.mjs", timeout: 4 }, { type: "command", command: "node ~/.agents/skills/trail-code/scripts/trail-code-hook.mjs", timeout: 15 }] };
  const settings = { permissions: { allow: ["Read"] }, hooks: { PostToolUse: [foreign, mixed], Stop: [foreign] }, statusLine: { type: "command", command: "keep" } };
  const once = mergeHooks(settings, "claude");
  const twice = mergeHooks(once, "claude");
  assert.deepEqual(twice, once);
  assert.equal(hash(once.hooks.PostToolUse[0]), hash(foreign));
  assert.deepEqual(once.hooks.PostToolUse[1], { matcher: "Write", note: "keep", hooks: [{ type: "command", command: "node keep-mixed.mjs", timeout: 4 }] });
  assert.equal(hash(once.permissions), hash(settings.permissions));
  assert.equal(hash(once.statusLine), hash(settings.statusLine));
  assert.match(once.hooks.PostToolUse[2].matcher, /PowerShell/);
  assert.equal(once.hooks.PostToolUse[2].hooks[0].timeout, 125);
  assert.equal(mergeHooks(settings, "codex").hooks.PostToolUse[2].hooks[0].timeout, 125);
});

test("instala os dois registros e expõe a fonte única ao Claude", () => {
  const home = root();
  const fake = join(home, "trail.mjs");
  const log = join(home, "trail.log");
  writeFileSync(fake, `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.TRAIL_INSTALL_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") process.stdout.write("0.23.0\\n");
`, "utf8");
  process.env.TRAIL_CODE_BIN = fake;
  process.env.TRAIL_INSTALL_LOG = log;
  const source = join(home, ".agents", "skills", "trail-code");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: trail-code\n---\n");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "keep" }] }] } }));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { KEEP: "yes" } }));
  const result = install(home);
  assert.equal(result.skill, "criado");
  assert.equal(result.telemetry, "desativada");
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map(JSON.parse), [["--version"], ["telemetry", "disable"]]);
  assert.equal(exposeClaudeSkill(home), "preservado");
  assert.equal(realpathSync(join(home, ".claude", "skills", "trail-code")), realpathSync(source));
  assert.equal(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).env.KEEP, "yes");
  assert.equal(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks.Stop[0].hooks[0].command, "keep");
  assert.equal(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks.SessionStart[0].hooks[0].command, `node "${join(home, ".agents", "skills", "trail-code", "scripts", "trail-code.mjs")}" hook`);
});
