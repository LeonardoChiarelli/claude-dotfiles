import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const hooksDir = dirname(fileURLToPath(import.meta.url));
const hookPath = (name) => join(hooksDir, name);

function runHook(name, input) {
  return spawnSync(process.execPath, [hookPath(name)], {
    encoding: "utf8",
    input: JSON.stringify(input),
  });
}

test("auto-ffprobe executa o runner em caminho Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-hook-"));
  const outputDir = join(dir, "out");
  const videoPath = join(outputDir, "demo.mp4");
  mkdirSync(outputDir);
  try {
    const ffmpeg = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.1", videoPath], { encoding: "utf8" });
    assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
    const result = runHook("auto-ffprobe.mjs", { tool_name: "Bash", tool_input: { command: `ffmpeg -i input.mp4 ${videoPath}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /auto-ffprobe .*demo\.mp4: \d+\.\d{2}s/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caption-readability executa o runner em caminho Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "caption-hook-"));
  const assPath = join(dir, "caption.ass");
  writeFileSync(assPath, "Dialogue: 0,0,0,0,texto suficientemente longo para acionar a verificacao de legibilidade da legenda neste teste\n");
  try {
    const result = runHook("caption-readability.mjs", { tool_name: "Write", tool_input: { file_path: assPath } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /caption-readability:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks podem ser importados via ESM sem iniciar runners", () => {
  for (const name of ["auto-ffprobe.mjs", "caption-readability.mjs"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(hookPath(name)).href)});`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
});
