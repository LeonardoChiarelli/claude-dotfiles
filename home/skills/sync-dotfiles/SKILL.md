---
name: sync-dotfiles
description: Export current ~/.claude config (skills, agents, hooks, settings, outcomes, memory, MCP list) to the claude-dotfiles repo, review the diff, scan for secrets, commit and push. Use when Claude config changed on this machine, when the drift hook warns about it, or when the user asks to sync/backup Claude config.
---

# sync-dotfiles

Sincroniza a config desta máquina para o repo `LeonardoChiarelli/claude-dotfiles` (direção: máquina → repo; a direção repo → máquina é o installer).

Localização do repo: `$CLAUDE_DOTFILES_DIR` se definida, senão `~/dotfiles/claude`.

## Passos

1. **Localizar o repo.** Se o diretório não existir, clonar: `git clone https://github.com/LeonardoChiarelli/claude-dotfiles.git <dir>`.
2. **Atualizar antes de exportar:** `git -C <dir> pull --ff-only`. Se falhar (divergência), PARAR e reportar ao usuário — nunca forçar.
3. **Exportar:** `node <dir>/tools/dotfiles.mjs export`. Mostrar o resumo do output.
4. **Scan de segredos:** `node <dir>/tools/dotfiles.mjs scan`. Se sair com código ≠ 0, PARAR: mostrar as linhas flagradas e aguardar decisão do usuário. Nunca commitar conteúdo flagrado sem aprovação explícita.
5. **Revisar:** mostrar `git -C <dir> status --short` e `git -C <dir> diff --stat`.
6. **Commitar** tudo com mensagem convencional em inglês descrevendo a mudança real (ex.: `feat(skills): add sync-dotfiles skill`, `chore(sync): update agents and memory`). Nada de mensagem genérica tipo "sync".
7. **Push:** `git -C <dir> push`. Se rejeitado, PARAR e reportar — nunca `--force`.
8. **Reportar:** arquivos alterados, hash do commit, status do push.

## Notas

- `settings.local.json` e caches nunca entram no repo (manifest exclui).
- `home/settings.json` no repo fica tokenizado (`{{CLAUDE_HOME}}`, `{{NODE}}`) — isso é esperado, não é bug.
- Mudança de plugin/marketplace já viaja dentro de `home/settings.json` (`enabledPlugins`); não existe manifest separado de plugins.
