#!/usr/bin/env node
// Reminds the root agent to make the documentation decision in its own context.
// It intentionally reads no prompt, transcript, final response, or filesystem state.

const reminder = "Antes de finalizar, avalie se implementações ou decisões importantes exigem atualizar a documentação interna relevante. Atualize somente quando relevante, respeite escopos somente leitura ou no-write e relate os arquivos alterados, não aplicável ou pendências.";

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }

  if (!event || typeof event !== "object" || Array.isArray(event)
    || event.agent_id || event.subagent_id) process.exit(0);

  if (event.hook_event_name === "UserPromptSubmit") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: reminder },
    }));
  } else if (event.hook_event_name === "Stop" && event.stop_hook_active === false) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: reminder }));
  }
});
