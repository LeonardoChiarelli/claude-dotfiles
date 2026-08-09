# claude-dotfiles

Bootstrap completo da minha config do Claude Code: skills, agents, hooks, outcomes, settings, plugins, MCP servers e memória persistente. Um clone + um comando reproduzem o setup inteiro em qualquer máquina.

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
1. Copia `home/` → `~/.claude` seguindo `manifest.json` e renderiza `settings.json` (tokens `{{CLAUDE_HOME}}`/`{{NODE}}` → paths da máquina; backup `.bak` se já existir)
2. Faz merge de `memory/` → `~/.claude/projects/<key>/memory` (nunca apaga arquivo só-local)
3. Registra MCP servers de `mcp.json` via `claude mcp add-json` (OAuth autentica no primeiro uso)
4. Instala jq + rtk e configura o hook rtk em `settings.local.json` (machine-local)
5. Plugins: nada a fazer — `settings.json` traz `enabledPlugins` + `extraKnownMarketplaces`; abra o Claude Code uma vez e eles se instalam sozinhos

`--dry-run` (sh) / `-DryRun` (ps1) mostra o plano sem executar.

## Dia a dia (sync máquina → repo)

Mudou skill/hook/agent/settings? Roda `/sync-dotfiles` dentro do Claude Code. Ele exporta pelo manifest, roda scan de segredos, mostra o diff e commita + pusha. O hook `dotfiles-drift.mjs` lembra você quando detectar mudança não sincronizada (1x por sessão).

Manual, sem Claude: `node tools/dotfiles.mjs export && node tools/dotfiles.mjs scan`, depois `git add -A && git commit && git push`.

## Layout

```
manifest.json   # o que sincroniza (única fonte de verdade)
home/           # espelho 1:1 de ~/.claude (settings.json tokenizado)
memory/         # espelho da memória persistente
mcp.json        # MCP servers user-scope, sem segredos (gerado)
tools/dotfiles.mjs  # export | install | scan | roundtrip
install.ps1 / install.sh
```

## Regras

- `settings.local.json` NUNCA entra no repo (permissions/hooks machine-local).
- `home/settings.json` fica tokenizado; paths reais só existem em `~/.claude`.
- Segredo detectado pelo scan aborta o commit. Sem exceção sem revisão humana.
- Marketplace com source `directory` (ex.: cowork-roles) não é reproduzível de GitHub — o installer avisa e segue.

## Testes

`node tools/dotfiles.mjs roundtrip` — exporta, instala num dir temporário e compara byte a byte (templados comparados na forma tokenizada). `OK` = os dois caminhos funcionam.
