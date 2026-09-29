---
name: codex-daemon-console-windows
description: Janelas do Windows Terminal piscando ao abrir o Codex CLI vêm do daemon gerenciado 0.157+; daemon_auto_start=false não basta se já há daemon rodando
metadata:
  node_type: memory
  type: project
  originSessionId: 50dbb646-e536-4342-91a1-4298003f9fc6
  modified: 2026-09-29T01:33:01.470Z
---

Janelas do Windows Terminal (títulos `git.exe`, `pwsh.exe`, `cmd`) que aparecem e somem ao abrir `codex` no CLI vêm do daemon gerenciado do Codex (`codex.exe app-server --listen unix:// --managed-daemon`, versão 0.158.0). Ele roda sem console e cria filhos sem `CREATE_NO_WINDOW`. Bug conhecido do upstream (openai/codex #48074, #44768, #48090, #48921). Diagnosticado em 2026-09-28; não vinha do Claude, do ai-bridge nem da statusline.

**Why:** `daemon_auto_start = false` (em `[features]` do `~/.codex/config.toml`) só impede iniciar daemon novo; o CLI ainda se conecta a um daemon já em execução (#48778). `codex app-server daemon stop` deixa vivo o `pid-update-loop` (#48195).

**How to apply:** se as janelas voltarem, listar processos `codex.exe` com `managed-daemon` ou `pid-update-loop`; rodar `codex app-server daemon stop` e encerrar o `pid-update-loop` à mão; se persistir, iniciar sempre com `codex --no-daemon`. Não confundir com o app desktop do Codex (`AppData\Local\OpenAI\Codex\bin\...\codex.exe`), que é outro processo. Reavaliar quando sair versão com o #48921 resolvido. Método de diagnóstico que funcionou: vigia de janelas visíveis (EnumWindows, classe CASCADIA_HOSTING_WINDOW_CLASS) + vigia de processos novos com pai e linha de comando, correlacionados por horário.

Ver também [[windows-shell-path-gotchas]].
