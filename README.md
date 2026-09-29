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
1. Copia `home/` → `~/.claude` seguindo `manifest.json`2. Faz merge de `memory/` → `~/.claude/projects/<key>/memory` (nunca apaga arquivo só-local)
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

## Testes

`node tools/dotfiles.mjs roundtrip` — exporta, instala num dir temporário e compara byte a byte. `OK` = os dois caminhos funcionam.
