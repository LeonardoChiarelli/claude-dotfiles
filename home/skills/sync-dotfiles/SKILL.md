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
2. **Atualizar antes de exportar:** antes de qualquer pull ou export, confirme a árvore limpa. Em clone compartilhado, rode `git -C <dir> pull --ff-only`; em worktree de entrega, confirme também a base autorizada. Se houver divergência ou alteração prévia, PARE e reporte. Nunca force.
3. **Exportar:** `node <dir>/tools/dotfiles.mjs export`. Mostrar o resumo do output.
4. **Scan de segredos:** `node <dir>/tools/dotfiles.mjs scan`. Se sair com código diferente de 0, PARE: reporte somente os caminhos que a própria ferramenta apresentar; inclua linha e categoria apenas quando já vierem na saída, sem abrir o achado nem reproduzir trecho ou valor, e aguarde decisão do usuário. Nunca commite conteúdo flagrado sem aprovação explícita.
5. **Revisar:** mostrar `git -C <dir> status --short` e `git -C <dir> diff --stat`. Ler o diff completo de hooks e skills antes de commitar, não só o diffstat. `settings.json` e `config.toml` NÃO são versionados e nunca devem aparecer no diff.
6. **Isolar o diff próprio:** stage apenas os arquivos desta tarefa. Se o export gerar drift alheio, preserve-o fora do stage e reverta somente os artefatos gerados por este export, nunca a fonte na máquina. Não use `git add -A`, nem “commit tudo”.
7. **Commitar, push e propor:** antes do commit, confirme que o checkout está numa branch de feature. Faça um commit convencional em inglês para o diff próprio, push normal somente dessa branch e abra um PR após os gates aplicáveis. Não commite nem faça push direto na `main`, merge ou promoção sem a autorização aplicável.
8. **Reportar** por alvo: arquivos alterados, hash do commit, status do push e estado do PR. No fim, um resumo dos dois.

## Depois dos dois alvos (uma vez)

9. Kit candidate: depois de concluir os passos 1 a 8 nos dois alvos e confirmar que o PR Codex foi integrado por squash, atualize `origin/main` e chame **uma vez** a skill `setup-ia-sanitize`, passando um clone ou worktree Codex com checkout na `main` atualizada, nunca a worktree de feature, e `$HOME/Documents/Business/chiarelli-dev/setup-ia-kit`. Se o PR Codex ainda estiver aberto, reporte a etapa do kit como pendente e não crie candidato nem checkpoint. Se o kit não existir, pule com essa razão. Nunca rode o candidato contra o alvo Claude, não duplique candidato ou checkpoint, e não publique nada sem o ok do Léo.

## Notas

### Comuns

- `settings.local.json`, `.env*` e caches nunca entram nos repos (os manifests excluem).
- Alterações válidas em `manifest.json` via Write/Edit são permitidas: o hook global `validate-manifest.mjs` valida o conteúdo proposto antes de aceitá-las. Não contorne o hook com shell; corrija o manifest até ele validar e preserve a formatação existente do arquivo.
- Antes de deletar qualquer clone "duplicado" em `~/dotfiles`, checar `git worktree list`. Um segundo diretório costuma ser worktree do mesmo repo, e nesse caso a remoção correta é `git worktree remove`, não `rm -rf`.

### Alvo claude

- `settings.json` é local da máquina e não é versionado. Plugins, marketplaces, hooks e permissões são configurados à mão em máquina nova.
- `scan` e `roundtrip` falham se um `settings.json`/`settings.local.json` aparecer no repo.
- O export Claude não percorre junctions. Após o export e antes do scan, para as skills desta tarefa expostas por junction, copie explicitamente somente os arquivos autorizados da fonte canônica `~/.agents/skills/<nome>/` para `home/skills/<nome>/`, valide a paridade e não infira exclusão pela ausência no export. Não siga outros links nem copie arquivos pessoais.
- `home/scripts/` carrega scripts de manutenção da máquina (ex.: `patch-vercel-cli-detect.mjs`). Arquivo novo em `~/.claude/scripts` viaja sozinho; diretório de topo novo em `~/.claude` só viaja se entrar no `include` do manifest.

### Alvo codex

- `config.toml` e `auth.json` NÃO são versionados: export e install os pulam com aviso.
- `scan` e `verify` falham se algum aparecer no repo. MCPs portáveis vivem em `mcp.json`.
- Os skills do Codex vêm de `~/.agents/skills`, não de `~/.codex/skills`.
