#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const cliVersion = "0.23.0";

function block(matcher, command, timeout) {
  return { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] };
}

function oursHook(hook) {
  return /\/trail-code\/scripts\/trail-code(?:-hook)?\.mjs/.test(String(hook?.command || "").replaceAll("\\", "/"));
}

function withoutOurs(entry) {
  if (!Array.isArray(entry?.hooks)) return entry;
  const hooks = entry.hooks.filter((hook) => !oursHook(hook));
  return hooks.length ? { ...entry, hooks } : null;
}

export function mergeHooks(settings, host, command = "node ~/.agents/skills/trail-code/scripts/trail-code.mjs hook") {
  const next = structuredClone(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {});
  next.hooks = next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {};
  const matcher = host === "claude"
    ? "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell"
    : "apply_patch|Edit|Write|MultiEdit|Bash|exec_command";
  const timeout = 125;
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const foreign = Array.isArray(next.hooks[event]) ? next.hooks[event].map(withoutOurs).filter(Boolean) : [];
    next.hooks[event] = [...foreign, block(event === "PostToolUse" ? matcher : null, command, timeout)];
  }
  return next;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function readJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export function exposeClaudeSkill(home) {
  const source = join(home, ".agents", "skills", "trail-code");
  const target = join(home, ".claude", "skills", "trail-code");
  if (!existsSync(source)) throw new Error("fonte ~/.agents/skills/trail-code ausente");
  if (existsSync(target)) {
    if (realpathSync(target) !== realpathSync(source)) throw new Error("destino Claude existe e aponta para outra fonte");
    return "preservado";
  }
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  return "criado";
}

export function disableTelemetry() {
  let bin = process.env.TRAIL_CODE_BIN;
  if (!bin && process.platform === "win32") bin = join(process.env.APPDATA || "", "npm", "node_modules", "@trailhq", "trail-code", "dist", "bin", "trail.js");
  if (!bin) {
    const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000, shell: false });
    if (root.status === 0 && root.stdout.trim()) bin = join(root.stdout.trim(), "@trailhq", "trail-code", "dist", "bin", "trail.js");
  }
  if (!existsSync(bin)) throw new Error("CLI Trail-Code 0.23.0 ausente");
  const executable = [".js", ".mjs", ".cjs"].includes(extname(bin).toLowerCase()) ? process.execPath : bin;
  const run = (args) => spawnSync(executable, executable === process.execPath ? [bin, ...args] : args, {
    encoding: "utf8", timeout: 10_000, shell: false, windowsHide: true,
    env: { ...process.env, DO_NOT_TRACK: "1", CI: "1" },
  });
  const version = run(["--version"]);
  if (version.status !== 0 || version.stdout.trim() !== cliVersion) throw new Error("CLI Trail-Code instalada não é 0.23.0");
  const disabled = run(["telemetry", "disable"]);
  if (disabled.status !== 0) throw new Error("não foi possível desativar a telemetria do Trail-Code");
  return "desativada";
}

export function install(home = homedir()) {
  const root = resolve(home);
  if (!isAbsolute(root) || root === dirname(root)) throw new Error("home inválida");
  const codex = join(root, ".codex", "hooks.json");
  const claude = join(root, ".claude", "settings.json");
  const script = join(root, ".agents", "skills", "trail-code", "scripts", "trail-code.mjs");
  const hookCommand = `node "${script}" hook`;
  const nextCodex = mergeHooks(readJson(codex), "codex", hookCommand);
  const nextClaude = mergeHooks(readJson(claude), "claude", hookCommand);
  const source = join(root, ".agents", "skills", "trail-code");
  const target = join(root, ".claude", "skills", "trail-code");
  if (!existsSync(source)) throw new Error("fonte ~/.agents/skills/trail-code ausente");
  if (existsSync(target) && realpathSync(target) !== realpathSync(source)) throw new Error("destino Claude existe e aponta para outra fonte");
  const telemetry = disableTelemetry();
  writeJsonAtomic(codex, nextCodex);
  writeJsonAtomic(claude, nextClaude);
  return { codex, claude, telemetry, skill: exposeClaudeSkill(root) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--home");
  const result = install(index >= 0 ? process.argv[index + 1] : homedir());
  process.stdout.write(`[trail-code] hooks Codex/Claude mesclados; skill Claude: ${result.skill}\n`);
}
