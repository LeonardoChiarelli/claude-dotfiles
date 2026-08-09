import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

export function isCompositionHtml(fp) {
  return /(^|[\/\\])compositions[\/\\].+\.html$/i.test(fp || "");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const { tool_name, tool_input } = JSON.parse(raw || "{}");
    const fp = tool_input?.file_path || "";
    if ((tool_name === "Write" || tool_name === "Edit") && isCompositionHtml(fp)) {
      try {
        const npx = process.platform === "win32" ? "npx.cmd" : "npx";
        const out = execFileSync(npx, ["hyperframes", "lint", dirname(fp)], { encoding: "utf8" });
        process.stdout.write(`hyperframes lint OK: ${dirname(fp)}\n${out}`);
      } catch (e) {
        process.stdout.write(`hyperframes lint apontou problemas em ${dirname(fp)}:\n${e.stdout || e.message}\n`);
      }
    }
    process.exit(0);
  });
}
