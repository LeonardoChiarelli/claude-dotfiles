# claude-dotfiles

Bootstrap completo da minha config do Claude Code: skills, agents, hooks, outcomes, MCP servers e memória persistente. Um clone + um comando reproduzem o setup inteiro em qualquer máquina.

## Máquina nova

**Windows (PowerShell 7+):**
```powershell
git clone https://github.com/LeonardoChiarelli/claude-dotfiles.git $HOME\dotfiles\claude
pwsh -File $HOME\dotfiles\claude\install.ps1
```

**macOS / Linux:**
```bash
git clone https://github.com/LeonardoChiarelli/claude-dotfiles.git ~/dotfiles/claude
bash ~/dotfiles/claude/install.sh
```

Pré-requisitos: git + Node.js. O installer:
1. Copia `home/` → `~/.claude` seguindo `manifest.json`
2. Faz merge de `memory/` → `~/.claude/projects/<key>/memory` (nunca apaga arquivo só-local)
3. Registra MCP servers de `mcp.json` via `claude mcp add-json` (OAuth autentica no primeiro uso)
4. Instala jq + rtk e configura o hook rtk em `settings.local.json` (machine-local)
5. Manual: `settings.json` é local da máquina e NÃO é versionado. Em máquina nova, configure à mão plugins e marketplaces (`/plugin`), permissões e o registro dos hooks de `~/.claude/hooks` em `settings.json`

`--dry-run` (sh) / `-DryRun` (ps1) mostra o plano sem executar.

## Dia a dia (sync máquina → repo)

Mudou skill/hook/agent? Roda `/sync-dotfiles` dentro do Claude Code. Ele exporta pelo manifest, roda scan de segredos, mostra o diff e commita + pusha. O hook `dotfiles-drift.mjs` lembra você quando detectar mudança não sincronizada (1x por sessão).

Manual, sem Claude: `node tools/dotfiles.mjs export && node tools/dotfiles.mjs scan`, depois `git add -A && git commit && git push`.

## Layout

```
manifest.json   # o que sincroniza (única fonte de verdade)
home/           # espelho 1:1 de ~/.claude
memory/         # espelho da memória persistente
mcp.json        # MCP servers user-scope, sem segredos (gerado)
tools/dotfiles.mjs  # export | install | scan | roundtrip
install.ps1 / install.sh
```

## Regras

- `settings.json` e `settings.local.json` NUNCA entram no repo (locais da máquina). `scan` e `roundtrip` falham se qualquer um dos dois existir em qualquer pasta do repo.
- `mcp.json`: segredo em `env`, `headers` (ex.: `Authorization`) ou `args` (`--api-key`) vira `{{SECRET:...}}` no export; o installer pula esse server e manda registrar à mão.
- Segredo detectado pelo scan aborta o commit. Sem exceção sem revisão humana.

## Hook de documentação interna

`home/CLAUDE.md` já importa `@~/.codex/AGENTS.md`, onde a avaliação obrigatória de documentação interna é definida. O hook `project-docs.mjs` só lembra essa decisão semântica ao agente: não lê arquivos, prompt, transcrição ou resposta final, não grava documentos nem mantém estado. Em `Stop`, ele bloqueia apenas quando `stop_hook_active` é exatamente `false`; a continuidade fica liberada para evitar recursão. Fechamentos abruptos e o disparo pelo harness real não são garantidos por este gate.

Em `~/.claude/settings.json`, mescle os dois eventos abaixo sem substituir hooks já existentes:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/project-docs.mjs", "timeout": 3 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/project-docs.mjs", "timeout": 3 }]
    }]
  }
}
```

## Paridade de skills e hooks

`trail-code` tem fonte única em `~/.agents/skills/trail-code`. Exponha-a ao Claude por junction, sem cópia:

```powershell
npm install -g @trailhq/trail-code@0.23.0
node "$HOME\.agents\skills\trail-code\scripts\install.mjs"
```

O instalador cria a junction sem sobrescrever destino divergente, mescla os registros no `hooks.json` do Codex e no `settings.json` do Claude e persiste `trail telemetry disable`, preservando hooks, permissões, statusline e demais entradas. Na primeira sessão Codex após instalar ou alterar a definição, revise e aprove os quatro registros em `/hooks`; não contorne essa revisão com `--dangerously-bypass-hook-trust`. O Trail é mapa estrutural local somente. Não use `trail init`, learnings, MCP, cloud ou `--deep`.

O registro Claude resultante usa estes eventos. O comando abaixo é esquemático; o instalador grava o caminho absoluto do host:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"<HOME>/.agents/skills/trail-code/scripts/trail-code.mjs\" hook", "timeout": 125 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"<HOME>/.agents/skills/trail-code/scripts/trail-code.mjs\" hook", "timeout": 125 }] }],
    "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell", "hooks": [{ "type": "command", "command": "node \"<HOME>/.agents/skills/trail-code/scripts/trail-code.mjs\" hook", "timeout": 125 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"<HOME>/.agents/skills/trail-code/scripts/trail-code.mjs\" hook", "timeout": 125 }] }]
  }
}
```

Início, prompt e shell fazem somente o `check` leve pelo fingerprint do Trail 0.23.0, sem escrita. Edição por ferramenta estruturada faz `check -> build -> check`; `Stop` repete o ensure apenas quando uma edição estruturada anterior ficou pendente. Shell sem alvo estruturado não pode ser atribuído com segurança: depois de comando mutante, a skill exige `ensure` explícito. Antes da entrega, a skill exige `ensure` e `verify`; o gate aceita apenas o grafo íntegro e a ausência esperada de contexto no modo mapa. Falha, timeout ou lock não confirmam frescor. Diretórios ocultos não entram no mapa, e o wrapper rejeita cache desconhecido ou com links.

O inventário local, sem plugins nem `synced/`, tem 43 skills em `~/.agents/skills` e 18 em `~/.claude/skills`. Nesta rodada, a organizadora expôs `shell` por junction, totalizando 19 skills locais compartilhadas; 24 não foram migradas. Isso não afirma que o Claude não disponha de equivalentes por plugins.

`shell` permanece versionada no Codex, sem cópia no Claude. Se o destino ainda não existir, crie a junction sem sobrescrever nada:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE/.claude/skills/shell" -Target "$env:USERPROFILE/.agents/skills/shell"
```

`padrao-observabilidade` (LEO-358) segue o mesmo modelo: fonte única no Codex, exposta ao Claude por link, sem cópia aqui. O hook `observability-lint.mjs` (só aviso) fica em `home/hooks/` e é registrado à mão no `settings.json`, no bloco `PostToolUse` com matcher `Edit|Write|MultiEdit`, ao lado do `check-emdash.mjs`:

```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE/.claude/skills/padrao-observabilidade" -Target "$env:USERPROFILE/.agents/skills/padrao-observabilidade"
```

As diferenças de hooks são deliberadamente específicas de cada host ou ficaram adiadas quando não triviais. Nesta rodada, apenas `auto-ffprobe.mjs` e `caption-readability.mjs` receberam o ajuste seguro de runner. `autopilot` segue adiada por política e CI, e os agentes de review ainda não foram verificados. O inventário confirma arquivos, mas descoberta nativa e E2E pelos harnesses ainda não foram comprovados.

## Testes

`node tools/dotfiles.mjs roundtrip`: exporta, instala num dir temporário e compara byte a byte. `OK` = os dois caminhos funcionam.
