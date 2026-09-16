import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const hookName of ["guard-source-footage.mjs", "ffmpeg-safety.mjs"]) {
  test(`${hookName} ignores malformed hook input`, () => {
    const hookPath = fileURLToPath(new URL(hookName, import.meta.url));
    const result = spawnSync(process.execPath, [hookPath], {
      encoding: "utf8",
      input: "{malformed-json",
    });

    assert.equal(result.status, 0, result.stderr);
  });
}
