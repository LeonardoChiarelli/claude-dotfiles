---
name: ccusage-statusline
description: ccusage instalado global e wired na statusline pra mostrar uso de contexto e limite de sessão (block 5h) no terminal
metadata: 
  node_type: memory
  type: reference
  originSessionId: 602b6ce4-3742-4866-b88e-69ed661e214e
  modified: 2026-08-06T19:29:56.807Z
---

`ccusage` (npm, global, `npm i -g ccusage`) mostra por statusline: modelo, custo sessão/dia/block-5h, burn rate/h, uso de contexto %. Bloco de 5h é o rate-limit window da Anthropic (equivale a "limite de sessão").

Wired em `~/.claude/hooks/caveman-statusline.ps1` (script já era o `statusLine` configurado em `~/.claude/settings.json`).

`ccusage statusline` não tem flag de template/ordem/ícone (confirmado no `config-schema.json` do pacote) — formato de saída é fixo (`🤖 modelo | 💰 custos | 🔥 burn | 🧠 contexto`). Por isso o script chama `ccusage statusline --visual-burn-rate off`, parseia a saída com regex e remonta a linha customizada.

Formato atual (v2, enxuto): `Contexto x% ▪ Sessão x% ▪ Limite Semanal x% ▪ Modelo`, separador `▪` neutro, cor por threshold (verde <50%, amarelo 50-80%, vermelho >80%) em todos os 3 %.
- **Contexto%**: direto do `🧠` do ccusage statusline.
- **Sessão%**: custo do block de 5h (rate-limit window) / `$SessionCapUsd` (default **1768**, env `CAVEMAN_SESSION_CAP_USD`).
- **Limite Semanal%**: custo da semana corrente (`ccusage weekly --json --offline`) / `$WeeklyCapUsd` (default **1098**, env `CAVEMAN_WEEKLY_CAP_USD`).

**Caveat importante**: Anthropic não expõe o teto real de rate-limit (sessão 5h / semana) por API/hook local — só existe como header interno no request real. Os tetos acima foram **calibrados em 2026-08-06** comparando com o app oficial da Anthropic (não são chute): block $88.40 = 5% real → teto sessão ~$1768; semana $659 = 60% real → teto semanal ~$1098. A primeira tentativa (chute sem calibrar: $140 sessão / $1000 semana) errou feio na sessão (mostrava 63% vs 5% real) — ccusage usa API list price, que não escala 1:1 com a unidade de quota interna da Anthropic (mix de modelo, cache hit ratio mudam a razão $/quota). Recalibrar de vez em quando comparando com o app, principalmente se o mix de modelo mudar bastante (mais Opus 5, por exemplo).

`ccusage weekly` escaneia todo o histórico local (~2s, lento pra rodar toda linha) — cacheado em `~/.claude/.caveman-weekly-cache.json` com TTL 300s (env `CAVEMAN_WEEKLY_CACHE_SECONDS`).

Gotcha de encoding Windows: PowerShell decodifica stdout de processo externo com o codepage do console (não UTF-8) por padrão, corrompendo emoji/▪ em `?`. Fix: `[Console]::OutputEncoding = UTF8` pro output, e `$OutputEncoding` pro pipe de entrada do ccusage precisa ser UTF8 **sem BOM** (`New-Object System.Text.UTF8Encoding $false`) — a instância estática `[System.Text.Encoding]::UTF8` inclui BOM e quebra o parser JSON do ccusage.

Gotcha de modelo novo: `ccusage` (pacote antigo/desatualizado) não reconhecia `claude-sonnet-5` no cache offline de pricing (mostrava contagem crua de tokens em vez de %). Resolvido rodando `ccusage statusline --no-offline` uma vez pra ele buscar pricing live (LiteLLM) e cachear local — depois disso o modo offline (padrão, mais rápido) já resolve o % certo.

Opt-out: env var `CAVEMAN_STATUSLINE_USAGE=0`.

Se `ccusage` sumir do PATH ou quebrar, statusline cai silenciosamente pro comportamento antigo (só tag caveman) — try/catch no script cobre isso.
