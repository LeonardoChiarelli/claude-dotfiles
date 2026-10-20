---
name: sync-dotfiles
description: Export current ~/.claude and ~/.codex config (skills, agents, hooks, settings, outcomes, memory, MCP list) to the claude-dotfiles and Codex-dotfiles repos, review the owned diff and scan for secrets. Use when Claude or Codex config changed on this machine, when the drift hook warns about it, or when the user asks to sync/backup harness config.
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

1. **Localizar o repo.** Se o diretório não existir, clonar (`gh repo clone LeonardoChiarelli/<repo> <dir>`; o repo do Codex é privado e precisa do `gh` autenticado). Para uma entrega, use a worktree autorizada; não altere o clone principal sujo.
2. **Atualizar antes de exportar:** em clone compartilhado, `git -C <dir> pull --ff-only`. Em worktree de entrega, confirme a base e a árvore limpa; se houver divergência ou alteração prévia, PARE e reporte. Nunca force.
3. **Exportar:** `node <dir>/tools/dotfiles.mjs export`. Mostrar o resumo do output.
4. **Scan de segredos:** `node <dir>/tools/dotfiles.mjs scan`. Se sair com código diferente de 0, PARE: reporte somente arquivo:linha e categoria, sem trecho ou valor, e aguarde decisão do usuário. Nunca commite conteúdo flagrado sem aprovação explícita.
5. **Revisar:** mostrar `git -C <dir> status --short` e `git -C <dir> diff --stat`. Ler o diff completo de hooks e skills antes de commitar, não só o diffstat. `settings.json` e `config.toml` NÃO são versionados e nunca devem aparecer no diff.
6. **Isolar o diff próprio:** stage apenas os arquivos desta tarefa. Se o export gerar drift alheio, preserve-o fora do stage e reverta somente os artefatos gerados por este export, nunca a fonte na máquina. Não use `git add -A`, nem “commit tudo”.
7. **Commitar, push e propor:** faça um commit convencional em inglês para o diff próprio, push normal somente da branch de feature e abra um PR após os gates aplicáveis. Não faça push direto na `main`, merge ou promoção sem a autorização aplicável.
8. **Reportar** por alvo: arquivos alterados, hash do commit, status do push e estado do PR. No fim, um resumo dos dois.

## Depois dos dois alvos (uma vez)

9. Kit candidate: depois de concluir os passos 1 a 8 nos dois alvos, chame **uma vez** a skill `setup-ia-sanitize`, passando a worktree ou clone Codex e `$HOME/Documents/Business/chiarelli-dev/setup-ia-kit`. Ela executa `node sync/candidate.mjs --dotfiles <dir do codex>`, registra o `analyzedSha` e decide o próximo passo. Se o kit não existir, pule com essa razão. Nunca rode o candidato contra o alvo Claude, não duplique candidato ou checkpoint, e não publique nada sem o ok do Léo.

## Notas

### Comuns

- `settings.local.json`, `.env*` e caches nunca entram nos repos (os manifests excluem).
- Alterações válidas em `manifest.json` via Write/Edit são permitidas: o hook global `validate-manifest.mjs` valida o conteúdo proposto antes de aceitá-las. Não contorne o hook com shell; corrija o manifest até ele validar e preserve a formatação existente do arquivo.
- Antes de deletar qualquer clone "duplicado" em `~/dotfiles`, checar `git worktree list`. Um segundo diretório costuma ser worktree do mesmo repo, e nesse caso a remoção correta é `git worktree remove`, não `rm -rf`.

### Alvo claude

- `settings.json` é local da máquina e não é versionado. Plugins, marketplaces, hooks e permissões são configurados à mão em máquina nova.
- `scan` e `roundtrip` falham se um `settings.json`/`settings.local.json` aparecer no repo.
- `home/scripts/` carrega scripts de manutenção da máquina (ex.: `patch-vercel-cli-detect.mjs`). Arquivo novo em `~/.claude/scripts` viaja sozinho; diretório de topo novo em `~/.claude` só viaja se entrar no `include` do manifest.

### Alvo codex

- `config.toml` e `auth.json` NÃO são versionados: export e install os pulam com aviso.
- `scan` e `verify` falham se algum aparecer no repo. MCPs portáveis vivem em `mcp.json`.
- Os skills do Codex vêm de `~/.agents/skills`, não de `~/.codex/skills`.
