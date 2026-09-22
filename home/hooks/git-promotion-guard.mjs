#!/usr/bin/env node
// Global PreToolUse(Bash|PowerShell) guard for automated branch promotion.
// Shared by Claude Code (~/.claude/hooks) and Codex (~/.codex/hooks).
//
// Allows the promotion path: push of feature branches, gh pr create/checks,
// gh pr merge --squash. Blocks what cannot be undone by the agent:
//   - force push (--force, -f, --force-with-lease, +refspec), --all, --mirror
//   - push to or deletion of a protected branch (main, master, production, prod)
//   - bare `git push` while the current branch is protected (or unknown)
//   - gh pr merge without --squash, or with --admin (bypasses required checks)
//   - destructive local git (reset --hard, clean -f, branch -D, checkout/restore .)
//
// The human can still run any blocked command with the `! <command>` prefix.
// Protocol: JSON payload on stdin; deny via hookSpecificOutput.permissionDecision.

import { execFileSync } from "node:child_process";
import path from "node:path";

const PROTECTED = /^(main|master|production|prod)$/;
const FORCE_FLAGS = /^(--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--all|--delete|--prune|-d)$/;
const DESTRUCTIVE = [
  /\bgit\b.*\breset\s+--hard\b/,
  /\bgit\b.*\bclean\s+-[a-z]*f/,
  /\bgit\b.*\bbranch\s+(-D|--delete\s+--force)\b/,
  /\bgit\b.*\bcheckout\s+(--\s+)?\.\s*$/,
  /\bgit\b.*\brestore\s+(--\s+)?\.\s*$/,
];

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${reason} Se for realmente necessario, peca ao usuario para rodar com o prefixo '! <comando>'.`,
      },
    }),
  );
  process.exit(0);
}

const unquote = (t) => t.replace(/^['"]|['"]$/g, "");

function currentBranch(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function checkPush(args, cwd) {
  const tokens = args.split(/\s+/).filter(Boolean).map(unquote);
  for (const t of tokens) {
    if (FORCE_FLAGS.test(t) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t)) deny(`git push com '${t}' bloqueado (force/delete/mirror).`);
  }
  const positional = tokens.filter((t) => !t.startsWith("-"));
  const refspecs = positional.slice(1); // positional[0] is the remote
  if (refspecs.length === 0) {
    const branch = currentBranch(cwd);
    if (!branch) deny("git push sem refspec e branch atual indeterminada.");
    if (PROTECTED.test(branch)) deny(`git push a partir da branch protegida '${branch}'.`);
    return;
  }
  for (const spec of refspecs) {
    if (spec.startsWith("+")) deny(`refspec forcado '${spec}' bloqueado.`);
    if (spec.startsWith(":")) deny(`delecao de branch remota '${spec}' bloqueada.`);
    let dst = (spec.includes(":") ? spec.split(":").pop() : spec).replace(/^refs\/heads\//, "");
    if (dst === "HEAD") dst = currentBranch(cwd) ?? "";
    if (!dst || PROTECTED.test(dst)) deny(`push para branch protegida ou indeterminada ('${spec}').`);
  }
}

function checkSegment(segment, cwd) {
  for (const pattern of DESTRUCTIVE) if (pattern.test(segment)) deny(`comando git destrutivo bloqueado: '${segment}'.`);

  const push = segment.match(/\bgit((?:\s+-[cC]\s+\S+)*)\s+push\b(.*)$/);
  if (push) {
    const dir = push[1].match(/-C\s+(\S+)/);
    checkPush(push[2], dir ? path.resolve(cwd, unquote(dir[1])) : cwd);
  }

  if (/\bgh\s+pr\s+merge\b/.test(segment)) {
    if (/\s--admin\b/.test(segment)) deny("gh pr merge --admin ignora checks obrigatorios.");
    if (!/\s(--squash|-s)\b/.test(segment)) deny("gh pr merge exige --squash.");
  }
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0); // not a payload we understand: don't block
  }
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || !command) process.exit(0);
  const cwd = payload.cwd || process.cwd();
  for (const segment of command.split(/&&|\|\||;|\||\r?\n/)) checkSegment(segment.trim(), cwd);
  process.exit(0);
});
