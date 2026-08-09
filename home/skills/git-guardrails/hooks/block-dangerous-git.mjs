#!/usr/bin/env node
// PreToolUse(Bash) guard: blocks destructive git commands before they run.
// Adapted from mattpocock/skills (git-guardrails-claude-code) to Node ESM so it
// runs identically on Windows/macOS/Linux without bash or jq.
//
// Wire-up (global): ~/.claude/settings.json
//   "hooks": { "PreToolUse": [ { "matcher": "Bash",
//     "hooks": [ { "type": "command",
//       "command": "node \"$HOME/.claude/hooks/block-dangerous-git.mjs\"" } ] } ] }
//
// Protocol: read the hook payload as JSON on stdin. To BLOCK, print a reason to
// stderr and exit 2. Exit 0 to allow.

const DANGEROUS_PATTERNS = [
  /\bgit\s+push\b/,          // any push, including --force / -f
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/, // -f, -fd, -xdf, etc.
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+checkout\s+\.\s*$/,
  /\bgit\s+restore\s+\.\s*$/,
  /push\s+--force/,
  /reset\s+--hard/,
  /--force-with-lease/,
  /\bgit\s+push\s+.*--force/,
];

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
let command = "";
try {
  command = JSON.parse(raw)?.tool_input?.command ?? "";
} catch {
  process.exit(0); // not a JSON payload we understand — don't block
}

if (typeof command !== "string" || command.length === 0) process.exit(0);

for (const pattern of DANGEROUS_PATTERNS) {
  if (pattern.test(command)) {
    process.stderr.write(
      `BLOCKED: '${command}' matches a protected git pattern (${pattern}). ` +
        `You do not have authority to run destructive git commands. ` +
        `Ask the user to run it themselves with the '! <command>' prefix if it is genuinely needed.\n`
    );
    process.exit(2);
  }
}

process.exit(0);
