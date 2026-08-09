const OUT_OK = /(^|[\/\\])(build|out)[\/\\]/i;

// Token é invocação de ffmpeg se for exatamente "ffmpeg", ou terminar em
// "/ffmpeg", "\ffmpeg", "/ffmpeg.exe" ou "\ffmpeg.exe" (case-insensitive).
const FFMPEG_INVOKER = /(?:^|[\/\\])ffmpeg(?:\.exe)?$/i;

/**
 * Retorna true se algum "token de comando" (primeiro token de cada segmento
 * separado por |, &&, ||, ;) é uma invocação de ffmpeg.
 * Isso evita falso-positivo em comandos como:
 *   ls hooks/ffmpeg-safety.mjs
 *   node test-ffmpeg.js
 *   cat docs/ffmpeg-notes.md
 *   diff a/ffmpeg-safety.mjs b/ffmpeg-safety.mjs
 */
function invokesFFmpeg(cmd) {
  // Divide nos operadores de pipeline/sequência mais comuns.
  const segments = cmd.split(/\s*(?:\|\|?|&&|;)\s*/);
  for (const seg of segments) {
    const firstToken = seg.trim().split(/\s+/)[0] || "";
    if (FFMPEG_INVOKER.test(firstToken)) return true;
  }
  return false;
}

function outputs(cmd) {
  const toks = cmd.split(/\s+/);
  const outs = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "-i") { i++; continue; }
    if (t.startsWith("-")) continue;
    if (FFMPEG_INVOKER.test(t)) continue;
    outs.push(t);
  }
  // último token não-flag e não-input = output ffmpeg
  return outs.length ? [outs[outs.length - 1]] : [];
}

function inputs(cmd) {
  const toks = cmd.split(/\s+/);
  const ins = [];
  for (let i = 0; i < toks.length; i++) if (toks[i] === "-i" && toks[i + 1]) ins.push(toks[i + 1]);
  return ins;
}

export function ffmpegUnsafe(cmd) {
  if (!invokesFFmpeg(cmd)) return false;
  const outs = outputs(cmd);
  const ins = new Set(inputs(cmd));
  for (const o of outs) {
    if (ins.has(o)) return true;        // in-place
    if (!OUT_OK.test(o)) return true;   // output fora de build|out
  }
  return false;
}

import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const { tool_name, tool_input } = JSON.parse(raw || "{}");
    if (tool_name === "Bash" && ffmpegUnsafe(tool_input?.command || "")) {
      process.stderr.write("BLOCKED: ffmpeg deve escrever em build/ ou out/ e nunca in-place.\n");
      process.exit(2);
    }
    process.exit(0);
  });
}
