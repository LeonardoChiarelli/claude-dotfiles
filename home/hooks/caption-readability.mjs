import { readFileSync } from "node:fs";

// Conta caracteres visíveis (sem tags ASS) por linha de Dialogue.
export function longAssLines(ass, maxChars) {
  const bad = [];
  for (const line of ass.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    const parts = line.split(",");
    // ASS padrão: 10 campos (0-9), texto a partir do campo 9.
    // Formato simplificado (teste/gerado): pegar tudo a partir do campo 4.
    const textIndex = parts.length >= 10 ? 9 : 4;
    const text = parts.slice(textIndex).join(",").replace(/\{[^}]*\}/g, "");
    if (text.length > maxChars * 2) bad.push(text); // 2 linhas é o teto típico
  }
  return bad;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const { tool_name, tool_input } = JSON.parse(raw || "{}");
    const fp = tool_input?.file_path || "";
    if ((tool_name === "Write" || tool_name === "Edit") && /\.ass$/.test(fp)) {
      try {
        const bad = longAssLines(readFileSync(fp, "utf8"), 24);
        if (bad.length) process.stdout.write(`caption-readability: ${bad.length} linha(s) longa(s) em ${fp}\n`);
      } catch { /* ignore */ }
    }
    process.exit(0);
  });
}
