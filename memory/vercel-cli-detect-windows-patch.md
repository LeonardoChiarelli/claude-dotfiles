---
name: vercel-cli-detect-windows-patch
description: "Plugin oficial Vercel reporta falso \"CLI não instalado\" no Windows; patch local em ~/.claude/scripts/patch-vercel-cli-detect.mjs precisa ser reaplicado após update do plugin"
metadata: 
  node_type: memory
  type: project
  originSessionId: 55eb6e52-dd91-41e7-a0e3-2263a4e5b087
  modified: 2026-08-19T19:01:32.284Z
---

O hook SessionStart do plugin `claude-plugins-official/vercel` (`hooks/session-start-profiler.mjs`, função `checkVercelCli`) injeta falsamente `"IMPORTANT: The Vercel CLI is not installed."` no Windows, mesmo com `vercel` instalado e funcional. Atinge Claude Code e Codex (mesmo plugin, mesmo cache, versão 0.45.1 em 2026-08-19).

Dois bugs empilhados:
1. `getBinaryPathCandidates()` testa o sufixo vazio antes de PATHEXT. `accessSync(p, X_OK)` no Windows equivale a `F_OK`, então resolve o shim `...\npm\vercel` (script sh) em vez de `vercel.cmd`, e `CreateProcess` devolve ENOENT.
2. Mesmo resolvendo pro `.cmd`, `execFileSync` sem `shell: true` recusa `.cmd`/`.bat` desde Node 18.20.2 / 20.12.2 (CVE-2024-27980), devolvendo EINVAL.

O `catch` retorna `{ installed: false }`. O mesmo defeito atinge o lookup de `npm` (resolve `C:\Program Files\nodejs\npm`), então o check de versão latest também falha calado.

Gating explica o "só às vezes": o profiler só roda quando o projeto é greenfield (dir vazio) ou tem marcadores Vercel (`vercel.json`, `next.config`, `.vercel/`). Em outros dirs o hook sai cedo e o aviso não aparece.

**Why:** é bug upstream do plugin, não config da máquina. Reinstalar o `vercel` não resolve nada.

**How to apply:** rodar `node ~/.claude/scripts/patch-vercel-cli-detect.mjs` (idempotente, faz backup `.orig`, cobre `~/.claude` e `~/.codex`). O patch vive no cache do plugin, então **some a cada update do plugin Vercel**: reaplicar, ou checar com `--check`. Se os âncoras de texto mudarem numa versão nova, o script falha com mensagem explícita em vez de corromper o arquivo.

Relacionado: [[claude-dotfiles-bootstrap]], [[machine-migration-status]].
