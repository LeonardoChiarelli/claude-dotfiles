import { execFileSync } from "node:child_process";

export function producedOutputs(cmd) {
  if (!/\bffmpeg\b/.test(cmd)) return [];
  return cmd.split(/\s+/).filter((t) => /(^|[\/\\])out[\/\\].+\.mp4$/i.test(t));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const { tool_name, tool_input } = JSON.parse(raw || "{}");
    if (tool_name !== "Bash") return process.exit(0);
    for (const out of producedOutputs(tool_input?.command || "")) {
      try {
        const j = JSON.parse(execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", out], { encoding: "utf8" }));
        process.stdout.write(`auto-ffprobe ${out}: ${parseFloat(j.format.duration).toFixed(2)}s\n`);
      } catch { /* arquivo ainda não existe / ffprobe ausente */ }
    }
    process.exit(0);
  });
}
