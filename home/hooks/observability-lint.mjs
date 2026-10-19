#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) hook: avisos do padrao de observabilidade.
// Regras: console.log em codigo de servidor, next sem @sentry/nextjs no
// package.json e nome de evento de analytics fora de snake_case.
// Warn-only: saida 2 devolve a mensagem ao modelo e nao reverte a edicao.
// Qualquer erro termina com saida 0.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EVENT_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const EVENT_CALL = /\b(?:trackEvent\(|track\(|sendFunnelEvent\(|gtag\(\s*(['"`])event\1\s*,)\s*(['"`])([^'"`$]*)\2/g;

// Testes usam nomes invalidos e console.log de proposito: nenhuma regra se aplica.
const isTestFile = (file) => file.includes("/__tests__/") || /\.(test|spec)\.tsx?$/.test(file);

function isServerFile(file, text) {
  if (!file.endsWith(".ts")) return false;
  if (isTestFile(file)) return false;
  if (!(file.includes("/src/app/api/") || file.includes("/src/lib/") || file.endsWith("/route.ts"))) return false;
  const first = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return !/^['"]use client['"];?$/.test(first.trim());
}

export function findObservabilityWarnings(filePath, text) {
  const file = String(filePath).replace(/\\/g, "/");
  const warnings = [];

  if (isServerFile(file, text) && /\bconsole\.log\s*\(/.test(text)) {
    warnings.push(
      `Observabilidade: console.log em codigo de servidor (${file}). Usar o logger do produto (JSON por linha), nao console.log.`,
    );
  }

  if (file.split("/").pop() === "package.json") {
    try {
      const pkg = JSON.parse(text);
      const deps = { ...pkg?.devDependencies, ...pkg?.dependencies };
      if (deps.next && !deps["@sentry/nextjs"]) {
        warnings.push(
          `Observabilidade: ${file} usa next sem @sentry/nextjs. Adicionar o Sentry conforme a skill padrao-observabilidade.`,
        );
      }
    } catch {
      // JSON invalido: sem aviso.
    }
  }

  if (/\.(ts|tsx)$/.test(file) && !isTestFile(file)) {
    for (const match of text.matchAll(EVENT_CALL)) {
      const name = match[3];
      if (name === "pageview" || EVENT_NAME.test(name)) continue;
      warnings.push(
        `Observabilidade: evento "${name}" fora do padrao snake_case objeto_acao (ex.: cta_click) em ${file}.`,
      );
    }
  }

  return warnings;
}

function runHook() {
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(raw || "{}");
      const filePath = payload?.tool_input?.file_path ?? payload?.tool_response?.filePath ?? "";
      const file = String(filePath).replace(/\\/g, "/");
      if (!file) process.exit(0);
      const warnings = findObservabilityWarnings(file, readFileSync(file, "utf8"));
      if (warnings.length) {
        process.stderr.write(`${warnings.join("\n")}\n`);
        process.exit(2);
      }
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHook();
