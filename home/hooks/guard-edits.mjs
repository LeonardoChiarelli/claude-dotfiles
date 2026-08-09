#!/usr/bin/env node
// Global PreToolUse(Edit|Write|MultiEdit) guard.
// Blocks edits to .env files (live secrets belong in the provider, not the repo).
// .env.example is the committed template and is always allowed.
// Reads the hook payload JSON on stdin; denies via permissionDecision output.
//
// Project-specific guards (import boundaries, forbidden paths, etc.) live in the
// project's own .claude/hooks and run in addition to this global one.

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw || "{}");
    const ti = payload?.tool_input ?? {};
    const filePath = ti.file_path ?? "";
    const base = String(filePath).split(/[\\/]/).pop() ?? "";

    if (base === ".env.example" || base === ".env.sample") process.exit(0); // safe templates
    if (/^\.env($|\.)/.test(base)) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "Edicao de arquivo .env bloqueada: segredos vivos nao entram no repo. " +
              "Ajuste .env.example e configure o valor no painel do provedor (Vercel/Railway/etc.).",
          },
        }),
      );
    }
    process.exit(0);
  } catch {
    process.exit(0); // never break the tool on a parse error
  }
});
