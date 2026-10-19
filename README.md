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
1. Copia `home/` → `~/.claude` seguindo `manifest.json`. Não copia o conteúdo das skills compartilhadas.
2. Para cada skill compartilhada, garante `~/.claude/skills/<skill>` como symlink (macOS e Linux) ou junction (Windows) para `~/.agents/skills/<skill>`. O link só nasce se o caminho não existir. Diretório ou arquivo real no lugar do link vira `[conflict]` e fica como está.
3. Faz merge de `memory/` → `~/.claude/projects/<key>/memory` (nunca apaga arquivo só-local)
4. Registra MCP servers de `mcp.json` via `claude mcp add-json` (OAuth autentica no primeiro uso)
5. Instala jq + rtk e configura o hook rtk em `settings.local.json` (machine-local)
6. Manual: `settings.json` é local da máquina e NÃO é versionado. Em máquina nova, configure à mão plugins e marketplaces (`/plugin`), permissões e o registro dos hooks de `~/.claude/hooks` em `settings.json`

`--dry-run` (sh) / `-DryRun` (ps1) mostra o plano sem executar.

## Dia a dia (sync máquina → repo)

Mudou agent, hook ou outro arquivo só do Claude? Roda `/sync-dotfiles` dentro do Claude Code. Ele exporta pelo manifest, roda scan de segredos, mostra o diff e commita + pusha. O hook `dotfiles-drift.mjs` lembra você quando detectar mudança não sincronizada (1x por sessão). Skills compartilhadas não entram nesse export: o texto delas fica no Codex-dotfiles, e um link em `~/.claude/skills` não dispara o lembrete.

Manual, sem Claude: `node tools/dotfiles.mjs export && node tools/dotfiles.mjs scan`, depois `git add -A && git commit && git push`.

## Layout

```
.gitattributes  # texto em LF, inclusive no checkout do Windows
manifest.json   # o que sincroniza (única fonte de verdade)
home/           # espelho de ~/.claude, sem cópia das skills compartilhadas
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

## Skills compartilhadas

`~/.agents/skills` é a fonte única das skills que o Claude e o Codex usam juntos. O conteúdo mora no Codex-dotfiles (`skills/` instala em `~/.agents/skills`). Este repo não versiona cópia dessas skills. Agents, hooks, outcomes, scripts, `CLAUDE.md`, `RTK.md` e `memory/` continuam aqui: são config só do Claude.

No install, cada nome abaixo vira symlink ou junction, e só se `~/.claude/skills/<skill>` ainda não existir. Se no lugar houver diretório ou arquivo comum, o installer imprime `[conflict]` e segue, sem apagar e sem sobrescrever. Um link que já aponta para `~/.agents/skills/<skill>` é mantido. Um link que aponta para outro lugar também fica como está e entra no mesmo aviso.

Skills presentes nos dois repos: `academy-acervo`, `entrega`, `find-skills`, `git-guardrails`, `graphify`, `grill-with-docs`, `novo-projeto-chiarelli`, `remotion-best-practices`, `setup-engineering-pipeline`, `stripe-best-practices`, `stripe-projects`, `sync-dotfiles`, `to-issues`, `to-prd`, `triage`, `two-axis-review`, `upgrade-stripe`, `video-editor`.

`shell` existe só no Codex. O installer cria o mesmo tipo de link para ela, com a mesma regra de conflito, porque este repo nunca teve cópia dela.

As outras skills do Codex não são ligadas daqui. Equivalente por plugin, quando existe, fica fora deste layout.

## Fim de linha no Windows

`.gitattributes` marca arquivo de texto com `eol=lf`. No Windows o Git deixa de gravar CRLF no checkout (`core.autocrlf`). Sem isso, o installer copiava CRLF para `~/.claude` e, através das junctions, alterava os arquivos físicos em `~/.agents/skills`.

## Paridade de hooks

As diferenças de hooks são específicas de cada host ou ficaram adiadas quando não triviais. `auto-ffprobe.mjs` e `caption-readability.mjs` receberam o ajuste seguro de runner. `autopilot` segue adiada por política e CI, e os agentes de review ainda não foram verificados. O inventário confirma arquivos, mas descoberta nativa e E2E pelos harnesses ainda não foram comprovados.

## Testes

`node tools/dotfiles.mjs roundtrip`: exporta, instala num dir temporário e compara byte a byte. `OK` = os dois caminhos funcionam.

`node --test tools/dotfiles.test.mjs` cobre o install das skills compartilhadas: dry-run sem gravar link, criação do symlink e conflito quando o destino já é arquivo ou diretório real.
