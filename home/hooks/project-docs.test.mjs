import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("project-docs.mjs", import.meta.url));

function run(input, cwd) {
  const result = spawnSync(process.execPath, [hook], {
    cwd,
    encoding: "utf8",
    input: typeof input === "string" ? input : JSON.stringify(input),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : {};
}

test("UserPromptSubmit injeta o lembrete sem expor prompt nem escrever arquivos", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "project-docs-hook-"));
  try {
    const output = run({ hook_event_name: "UserPromptSubmit", prompt: "conteudo privado" }, cwd);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /documenta/i);
    assert.doesNotMatch(JSON.stringify(output), /conteudo privado/);
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Stop raiz com false bloqueia para avaliar documentação", () => {
  const output = run({ hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(output.decision, "block");
  assert.match(output.reason, /documenta/i);
});

test("Stop libera continuidade, campo ausente e valores inválidos", () => {
  for (const event of [
    { hook_event_name: "Stop", stop_hook_active: true },
    { hook_event_name: "Stop" },
    { hook_event_name: "Stop", stop_hook_active: null },
    { hook_event_name: "Stop", stop_hook_active: "false" },
  ]) assert.deepEqual(run(event), {});
});

test("IDs nulos permanecem na sessão raiz, subagente é liberado", () => {
  assert.equal(run({ hook_event_name: "Stop", stop_hook_active: false, agent_id: null, subagent_id: null }).decision, "block");
  assert.deepEqual(run({ hook_event_name: "Stop", stop_hook_active: false, agent_id: "subagent-1" }), {});
});

test("libera payload malformado ou fora do evento esperado", () => {
  for (const input of ["{", "null", "[]", JSON.stringify("texto"), { hook_event_name: "SessionEnd" }]) {
    assert.deepEqual(run(input), {});
  }
});
