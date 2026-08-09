#!/usr/bin/env node
// Global PostToolUse(Edit|Write|MultiEdit) hook: pt-BR copy rule.
// Rule (house style): never use the em-dash (U+2014) as a SENTENCE CONNECTOR in
// pt-BR copy. It is the strongest signal of AI-generated Portuguese text.
// Scans pt locale message files and JSX/TSX components. Exit 2 feeds the message
// back to the model so it self-corrects; the edit itself is NOT reverted (warn-only).
//
// Only flags genuine prose connectors. Legit em-dash uses are ignored:
//   - code comments (// , /* */, {/* */} including multi-line, jsdoc *)
//   - value placeholders: '—' / "—" / `—` (means "empty / N/A")
//   - quote attribution at line start: — Author
//   - JSX interpolation separators: {nome} — {empresa}
//   - title / alt metadata separators
//   - regex quantifiers like /—{3,}/
// Non-pt locale files (en/es) are skipped: the rule is pt-BR only.

import { readFileSync } from "node:fs";

const EM_DASH = "—";

// Lines (1-based) where an em-dash survives stripping every legit usage.
function findProseEmDashLines(text) {
  const blanked = text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  const hits = [];
  blanked.split("\n").forEach((line, i) => {
    if (!line.includes(EM_DASH)) return;
    const trimmed = line.trim();
    if (/^(\/\/|\*)/.test(trimmed)) return; // line comment / jsdoc continuation

    let s = line.replace(/\/\/.*$/, ""); // trailing line comment
    s = s.replace(/—\{/g, ""); // regex quantifier  —{n,}
    s = s.replace(/\}\s*—\s*\{/g, ""); // JSX interpolation separator } — {
    s = s.replace(/(['"`])—\1/g, ""); // quoted lone placeholder  '—'
    s = s.replace(/^\s*—\s/, ""); // leading quote attribution  — Author
    if (/\b(title|alt)\s*[:=]/.test(s)) return; // title / alt metadata separator

    if (s.includes(EM_DASH)) hits.push(i + 1);
  });
  return hits.slice(0, 10);
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw || "{}");
    const filePath =
      payload?.tool_input?.file_path ?? payload?.tool_response?.filePath ?? "";
    const f = String(filePath).replace(/\\/g, "/");

    // pt locale files (messages/pt.json, locales/pt-BR.json, i18n/pt.json, ...)
    const isPtMessages = /(^|\/)(messages|locales|i18n)\/pt(-br)?\.json$/i.test(f);
    // any JSX/TSX component (UI copy lives here)
    const isComponent = /\.(tsx|jsx)$/.test(f);
    if (!isPtMessages && !isComponent) process.exit(0);

    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      process.exit(0); // file gone or unreadable
    }

    const hits = findProseEmDashLines(text);
    if (hits.length) {
      process.stderr.write(
        `Copy pt-BR: em-dash (U+2014) usado como conector de frase em ${f} (linha(s): ${hits.join(", ")}). ` +
          "Regra de casa: nunca usar como conector. Substituir por ':' (lista de exemplos), " +
          "'.' (contraste/conclusao), '()' (clarificacao lateral) ou ',' (sequencia natural). " +
          "Placeholders '—', atribuicao '— autor', separadores e comentarios sao permitidos e ja ignorados.\n",
      );
      process.exit(2);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
