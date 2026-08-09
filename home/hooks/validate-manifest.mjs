import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

// Carrega o schema de forma fail-closed: se dist/ não estiver disponível, bloqueia em vez de crashar.
let manifestSchema;
try {
  const mod = await import("./schema.bundle.mjs");
  manifestSchema = mod.manifestSchema;
} catch (e) {
  // Se o schema não puder ser carregado em runtime, falha fechado (block) em vez de crashar silenciosamente.
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.stderr.write(`BLOCKED: falha ao carregar schema (dist/ ausente ou corrompido): ${e.message}\n`);
    process.exit(2);
  }
  // Em contexto de teste (import pelo vitest), relança o erro normalmente.
  throw e;
}

export function manifestErrors(obj) {
  const r = manifestSchema.safeParse(obj);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

// Runner (só quando executado como hook, não em teste)
// Usa pathToFileURL para comparação robusta no Windows (backslashes vs forward slashes).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const { tool_name, tool_input } = JSON.parse(raw || "{}");
    const fp = tool_input?.file_path || "";
    if ((tool_name === "Write" || tool_name === "Edit") && /manifest\.json$/.test(fp)) {
      // Write: conteúdo no input; Edit: relê o arquivo final
      let obj;
      try {
        obj = tool_name === "Write" ? JSON.parse(tool_input.content) : JSON.parse(readFileSync(fp, "utf8"));
      } catch (e) {
        process.stderr.write(`BLOCKED: manifest.json não é JSON válido (${e.message}).\n`);
        process.exit(2);
      }
      const errs = manifestErrors(obj);
      if (errs.length) {
        process.stderr.write("BLOCKED: manifest inválido:\n- " + errs.join("\n- ") + "\n");
        process.exit(2);
      }
    }
    process.exit(0);
  });
}
