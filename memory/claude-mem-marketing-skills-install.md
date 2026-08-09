---
name: claude-mem-marketing-skills-install
description: marketing-skills (45) instalado globalmente (user scope); claude-mem@thedotmack foi desinstalado em 2026-07-22 pós-migração (estava quebrado)
metadata: 
  node_type: memory
  type: project
  originSessionId: 1c24408a-e11c-4e41-9815-e4c729690972
  modified: 2026-07-22T22:31:55.792Z
---

**marketing-skills@marketingskills** v2.5.1 — 45 skills de marketing, instalado 2026-06-25 em escopo **user** via `claude plugin marketplace add coreyhaines31/marketingskills` + `claude plugin install`. `product-marketing` é a skill base. Sem hooks, leve. `true` em `enabledPlugins`.

**claude-mem@thedotmack removido em 2026-07-22.** Instalado originalmente 2026-06-25 (memória persistente, worker em `localhost:37777`, dados em `~/.claude-mem/`), mas a migração de máquina (lrchi→Leonardo, ver [[machine-migration-status]]) deixou o plugin quebrado: `plugins/cache/thedotmack/claude-mem/` sem versão instalada e worker parado. Usuário optou por desinstalar por completo em vez de reinstalar: removida entry `thedotmack` de `plugins/known_marketplaces.json`, `claude-mem@thedotmack` de `enabledPlugins` em `settings.json`, diretórios `plugins/cache/thedotmack/` e `plugins/marketplaces/thedotmack/`, e os 9.6M de dados em `~/.claude-mem/` (banco de memórias apagado, irrecuperável). Se quiser memória persistente de novo, reinstalar do zero via `npx claude-mem install`.

**Per-repo:** seção "Memória + Marketing skills" no CLAUDE.md de cada repo em `Documents/Code` (Cert-AI, Chiarelli-Labs, Pain-to-Product anexados; Coach-Copilot, coding-drills, marketing-output criados) ainda referencia claude-mem — desatualizado, revisar se for mexer nesses repos. Ver [[claude-config-consolidation]].
