---
name: git-guardrails
description: Set up a Claude Code PreToolUse hook that blocks dangerous git commands (push, reset --hard, clean -f, branch -D, checkout ., restore .) before they execute. Use when the user wants to prevent destructive git operations or add git safety hooks.
---

> **Adaptado de [mattpocock/skills](https://github.com/mattpocock/skills)** (skill original: `git-guardrails-claude-code`). Convenções locais:
> - O script foi portado de bash para **Node ESM** (`hooks/block-dangerous-git.mjs`) para rodar no Windows/PowerShell sem depender de bash ou jq, no mesmo estilo dos hooks existentes (`guard-edits.mjs`, `check-emdash.mjs`).
> - Complementa, não substitui, o hook `guard-edits.mjs` (que bloqueia edição de `.env`). Juntos formam a camada de segurança: um protege segredos, outro protege a history do git.
> - Interação com o usuário em **pt-BR**.

# Git Guardrails

Sets up a PreToolUse hook that intercepts and blocks dangerous git commands before Claude executes them.

## What gets blocked

- `git push` (todas variantes, incluindo `--force` / `--force-with-lease`)
- `git reset --hard`
- `git clean -f` / `-fd` / `-xdf`
- `git branch -D`
- `git checkout .` / `git restore .`

Quando bloqueado, o Claude recebe (via stderr, exit 2) uma mensagem dizendo que não tem autoridade para rodar o comando, e que o usuário pode rodá-lo com o prefixo `! <command>` se for realmente necessário.

## Steps

### 1. Confirm scope

Pergunte ao usuário: instalar para **este projeto** (`.claude/settings.json` do repo) ou **todos os projetos** (`~/.claude/settings.json`)? Default sugerido: global, já que o estilo do usuário é manter config genérica em `~/.claude`.

### 2. Place the hook script

O script já vem com este skill em [hooks/block-dangerous-git.mjs](hooks/block-dangerous-git.mjs). Copie-o para:

- **Global**: `~/.claude/hooks/block-dangerous-git.mjs`
- **Projeto**: `.claude/hooks/block-dangerous-git.mjs`

(No Windows não é preciso `chmod +x`: o hook é invocado via `node`.)

### 3. Wire the hook into settings

> **Mudança de comportamento automático.** Editar `settings.json` para adicionar um hook muda como o harness se comporta em toda sessão. **Confirme com o usuário antes de escrever.** Use a skill `update-config` para a edição, ou faça o merge manual abaixo. Nunca sobrescreva hooks existentes: faça merge no array `hooks.PreToolUse`.

**Global** (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node \"$HOME/.claude/hooks/block-dangerous-git.mjs\"" }
        ]
      }
    ]
  }
}
```

**Projeto** (`.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/block-dangerous-git.mjs\"" }
        ]
      }
    ]
  }
}
```

Se o arquivo de settings já existe, faça merge do hook no array `hooks.PreToolUse` existente, sem apagar os outros hooks do usuário.

### 4. Offer customization

Pergunte se o usuário quer adicionar ou remover padrões da lista bloqueada (array `DANGEROUS_PATTERNS` no script). Edite o `.mjs` conforme.

### 5. Verify

Rode um teste rápido (PowerShell):

```powershell
'{"tool_input":{"command":"git push origin main"}}' | node "$HOME/.claude/hooks/block-dangerous-git.mjs"; "exit=$LASTEXITCODE"
```

Deve sair com código 2 e imprimir uma mensagem `BLOCKED:` no stderr. Um comando seguro (ex.: `git status`) deve sair com código 0 e sem output.
