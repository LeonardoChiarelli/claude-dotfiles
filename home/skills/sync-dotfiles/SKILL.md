---
name: sync-dotfiles
description: Export current ~/.claude and ~/.codex config (skills, agents, hooks, settings, outcomes, memory, MCP list) to the claude-dotfiles and Codex-dotfiles repos, review the diff, scan for secrets, commit and push. Use when Claude or Codex config changed on this machine, when the drift hook warns about it, or when the user asks to sync/backup harness config.
---

# sync-dotfiles

Sincroniza a config desta máquina para os repos de dotfiles (direção: máquina → repo; a direção repo → máquina é o installer).

São **dois** alvos, um por harness. Rodar os dois por padrão. Se o usuário pedir explicitamente só um ("sincroniza o Claude"), rodar só aquele e dizer que o outro ficou de fora.

| alvo | dir do repo | fonte na máquina | repo |
|---|---|---|---|
| claude | `$CLAUDE_DOTFILES_DIR`, senão `~/dotfiles/claude` | `~/.claude` | `LeonardoChiarelli/claude-dotfiles` (público) |
| codex | `$CODEX_DOTFILES_DIR`, senão `~/dotfiles/Codex` | `~/.codex` + `~/.agents/skills` | `LeonardoChiarelli/Codex-dotfiles` (privado) |

Pular um alvo, sem tratar como erro, quando a fonte não existe nesta máquina (ex.: só Claude instalado). Reportar o pulo.

## Passos

Rodar o ciclo abaixo **por alvo**, um de cada vez. Terminar um antes de começar o outro, para que um scan sujo em `codex` não deixe `claude` num estado pela metade.

1. **Localizar o repo.** Se o diretório não existir, clonar (`gh repo clone LeonardoChiarelli/<repo> <dir>`; o repo do Codex é privado e precisa do `gh` autenticado).
2. **Atualizar antes de exportar:** `git -C <dir> pull --ff-only`. Se falhar por divergência, PARAR e reportar ao usuário. Nunca forçar.
3. **Exportar:** `node <dir>/tools/dotfiles.mjs export`. Mostrar o resumo do output.
4. **Scan de segredos:** `node <dir>/tools/dotfiles.mjs scan`. Se sair com código diferente de 0, PARAR: mostrar as linhas flagradas e aguardar decisão do usuário. Nunca commitar conteúdo flagrado sem aprovação explícita.
5. **Revisar:** mostrar `git -C <dir> status --short` e `git -C <dir> diff --stat`. Ler o diff de `config.toml` (codex) e de `settings.json` (claude) antes de commitar, não só o diffstat.
6. **Commitar** tudo com mensagem convencional em inglês descrevendo a mudança real (ex.: `feat(skills): add sync-dotfiles skill`, `chore(sync): update agents and memory`). Nada de mensagem genérica tipo "sync".
7. **Push:** `git -C <dir> push`. Se rejeitado, PARAR e reportar. Nunca `--force`.
8. **Reportar** por alvo: arquivos alterados, hash do commit, status do push. No fim, um resumo dos dois.

## Notas

### Comuns

- `settings.local.json`, `.env*` e caches nunca entram nos repos (os manifests excluem).
- Nunca editar `manifest.json` com Write/Edit: o hook global `validate-manifest.mjs` bloqueia qualquer manifest.json, inclusive estes. Editar via shell (`node -e`, `sed`) e preservar a formatação existente do arquivo.
- Antes de deletar qualquer clone "duplicado" em `~/dotfiles`, checar `git worktree list`. Um segundo diretório costuma ser worktree do mesmo repo, e nesse caso a remoção correta é `git worktree remove`, não `rm -rf`.

### Alvo claude

- `home/settings.json` fica tokenizado no repo (`{{CLAUDE_HOME}}`, `{{NODE}}`). Isso é esperado, não é bug.
- Mudança de plugin/marketplace já viaja dentro de `home/settings.json` (`enabledPlugins` + `extraKnownMarketplaces`). Não existe manifest separado de plugins.
- `home/scripts/` carrega scripts de manutenção da máquina (ex.: `patch-vercel-cli-detect.mjs`). Arquivo novo em `~/.claude/scripts` viaja sozinho; diretório de topo novo em `~/.claude` só viaja se entrar no `include` do manifest.

### Alvo codex

- `config.toml` não é copiado cru: passa por `portableConfig()` em `tools/dotfiles.mjs`, que trabalha com duas allowlists, `PORTABLE_SECTIONS` (seções) e `PORTABLE_ROOT_KEYS` (chaves de raiz).
- Ficam de fora de propósito: `sandbox_mode` (decisão por máquina), `auth.json`, os blocos `[projects.*]` com trust level e o path do `notify`.
- Consequência: chave de configuração nova na raiz do `config.toml` some calada do export até ser adicionada a `PORTABLE_ROOT_KEYS`. Ao revisar o diff, conferir se alguma chave que existe em `~/.codex/config.toml` sumiu do `home/config.toml`.
- Os skills do Codex vêm de `~/.agents/skills`, não de `~/.codex/skills`.
