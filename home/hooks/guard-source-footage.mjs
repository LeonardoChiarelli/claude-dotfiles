// Bloqueia qualquer escrita/overwrite dentro de footage/ (footage = imutável).
import { pathToFileURL } from "node:url";

const FOOTAGE_RE = /(^|[\/\\])footage[\/\\]/i;

// Token é invocação de ffmpeg se for exatamente "ffmpeg", ou terminar em
// "/ffmpeg", "\ffmpeg", "/ffmpeg.exe" ou "\ffmpeg.exe" (case-insensitive).
const FFMPEG_INVOKER = /(?:^|[\/\\])ffmpeg(?:\.exe)?$/i;

/**
 * Retorna true se algum "token de comando" (primeiro token de cada segmento
 * separado por |, &&, ||, ;) é uma invocação de ffmpeg.
 */
function invokesFFmpeg(cmd) {
  const segments = cmd.split(/\s*(?:\|\|?|&&|;)\s*/);
  for (const seg of segments) {
    const firstToken = seg.trim().split(/\s+/)[0] || "";
    if (FFMPEG_INVOKER.test(firstToken)) return true;
  }
  return false;
}

export function violatesFootageGuard(toolName, input = {}) {
  if (toolName === "Write" || toolName === "Edit") {
    return FOOTAGE_RE.test(input.file_path || "");
  }
  if (toolName === "Bash") {
    const cmd = input.command || "";
    if (!invokesFFmpeg(cmd)) return false;
    // tokens que não são flags nem inputs (-i X) e caem em footage/
    const toks = cmd.split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === "-i") { i++; continue; }          // input, permitido
      if (t.startsWith("-")) continue;            // flag
      if (FOOTAGE_RE.test(t)) return true;        // output em footage/
    }
  }
  return false;
}

// Runner (só quando executado como hook, não em teste)
// Usa pathToFileURL para comparação robusta no Windows (backslashes vs forward slashes).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const { tool_name, tool_input } = JSON.parse(raw || "{}");
    if (violatesFootageGuard(tool_name, tool_input)) {
      process.stderr.write("BLOCKED: footage/ é imutável. Direcione a saída para build/ ou out/.\n");
      process.exit(2);
    }
    process.exit(0);
  });
}
