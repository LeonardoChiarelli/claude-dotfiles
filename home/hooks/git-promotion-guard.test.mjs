import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("git-promotion-guard.mjs", import.meta.url));

function repoOn(branch) {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-"));
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: dir });
  return dir;
}

function denied(command, cwd = repoOn("feat/x")) {
  const r = spawnSync(process.execPath, [hook], { encoding: "utf8", input: JSON.stringify({ cwd, tool_input: { command } }) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.includes('"deny"');
}

const main = repoOn("main");

for (const cmd of [
  "git push --force origin feat/x",
  "git push -f",
  "git push --force-with-lease origin feat/x",
  "git push origin +feat/x",
  "git push origin main",
  "git push origin HEAD:master",
  "git push origin :feat/x",
  "git push --delete origin feat/x",
  "git push --all",
  "git reset --hard HEAD~1",
  "git clean -fd",
  "git branch -D feat/x",
  "git checkout .",
  "gh pr merge 12 --merge",
  "gh pr merge 12 --squash --admin",
  "npm test && git push origin main",
]) {
  test(`blocks: ${cmd}`, () => assert.equal(denied(cmd), true));
}

test("blocks bare push from protected branch", () => assert.equal(denied("git push", main), true));
test("blocks HEAD push from protected branch", () => assert.equal(denied("git push origin HEAD", main), true));

for (const cmd of [
  "git push -u origin feat/x",
  "git push origin HEAD",
  "git push",
  "gh pr create --fill",
  "gh pr checks 12 --watch --fail-fast",
  "gh pr merge 12 --squash --delete-branch",
  "git status",
  "git -C . log --oneline -5",
]) {
  test(`allows: ${cmd}`, () => assert.equal(denied(cmd), false));
}

const dotfiles = repoOn("main");
execFileSync("git", ["remote", "add", "origin", "https://github.com/LeonardoChiarelli/claude-dotfiles.git"], { cwd: dotfiles });
test("allows push to main in dotfiles repo", () => assert.equal(denied("git push", dotfiles), false));
test("allows explicit main push in dotfiles repo", () => assert.equal(denied("git push origin main", dotfiles), false));
test("still blocks force push in dotfiles repo", () => assert.equal(denied("git push --force origin main", dotfiles), true));
test("still blocks remote delete in dotfiles repo", () => assert.equal(denied("git push origin :main", dotfiles), true));

const other = repoOn("main");
execFileSync("git", ["remote", "add", "origin", "https://github.com/LeonardoChiarelli/claude-dotfiles-evil.git"], { cwd: other });
test("does not allow lookalike remote", () => assert.equal(denied("git push", other), true));

test("ignores malformed input", () => {
  const r = spawnSync(process.execPath, [hook], { encoding: "utf8", input: "{bad" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
