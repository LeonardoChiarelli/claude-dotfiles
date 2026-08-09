---
name: setup-engineering-pipeline
description: Sets up an `## Agent skills` block in CLAUDE.md/AGENTS.md and `docs/agents/` so the engineering pipeline skills know this repo's issue tracker (GitHub or local markdown), triage label vocabulary, and domain doc layout. Run once per repo before first use of `to-prd`, `to-issues`, `triage`, `grill-with-docs`, or `two-axis-review` — or if those skills appear to be missing context about the issue tracker, triage labels, or domain docs.
disable-model-invocation: true
---

> **Adaptado de [mattpocock/skills](https://github.com/mattpocock/skills)** (skill original: `setup-matt-pocock-skills`). Convenções locais:
> - Interação com o usuário (explicações, perguntas, resumos) em **pt-BR**. Os arquivos gerados em `docs/agents/*.md` e o bloco `## Agent skills` ficam em inglês, conforme convenção do projeto.
> - Default de issue tracker: **GitHub** (`gh` CLI). Local markdown também sai pronto. GitLab/Jira/Linear: escrever `docs/agents/issue-tracker.md` do zero a partir da descrição do usuário.
> - ADRs deste usuário vivem em `.claude/memory/decisions.md` (formato ADR). O `domain.md` gerado já aponta pra lá.

# Setup Engineering Pipeline

Scaffold the per-repo configuration that the engineering pipeline skills assume:

- **Issue tracker** — where issues live (GitHub by default; local markdown is also supported out of the box)
- **Triage labels** — the strings used for the five canonical triage roles
- **Domain docs** — where `CONTEXT.md` and ADRs live, and the consumer rules for reading them

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `.git/config` — is this a GitHub repo? Which one?
- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section in either?
- `CONTEXT.md` and `CONTEXT-MAP.md` at the repo root
- `docs/adr/` and `.claude/memory/decisions.md` — where do architectural decisions live?
- `docs/agents/` — does this skill's prior output already exist?
- `.scratch/` — sign that a local-markdown issue tracker convention is already in use

### 2. Present findings and ask

Summarise what's present and what's missing. Then walk the user through the three decisions **one at a time** — present a section, get the user's answer, then move to the next. Don't dump all three at once.

Assume the user does not know what these terms mean. Each section starts with a short explainer (what it is, why these skills need it, what changes if they pick differently). Then show the choices and the default.

**Section A — Issue tracker.**

> Explainer: O "issue tracker" é onde as issues deste repo vivem. Skills como `to-issues`, `triage`, `to-prd` e `two-axis-review` leem e escrevem nele: precisam saber se chamam `gh issue create`, escrevem um arquivo markdown em `.scratch/`, ou seguem outro fluxo que você descrever. Escolha onde você realmente rastreia trabalho neste repo.

Default posture: estes skills foram desenhados pro GitHub. Se um `git remote` aponta pro GitHub, proponha GitHub. Senão (ou se o usuário preferir), ofereça:

- **GitHub** — issues no GitHub Issues do repo (usa o `gh` CLI). **Default.**
- **Local markdown** — issues como arquivos em `.scratch/<feature>/` neste repo (bom pra projetos solo ou repos sem remote)
- **Other** (GitLab, Jira, Linear, etc.) — peça ao usuário pra descrever o fluxo em um parágrafo; o skill grava como prosa livre

**Section B — Triage label vocabulary.**

> Explainer: Quando o skill `triage` processa uma issue, ele a move por uma máquina de estados: precisa avaliar, esperando o reporter, pronta pra um agente AFK pegar, pronta pra humano, ou won't fix. Pra isso aplica labels (ou o equivalente no seu tracker) que casam com strings *que você de fato configurou*. Se o repo já usa nomes diferentes (ex.: `bug:triage` em vez de `needs-triage`), mapeie aqui pro skill aplicar os certos em vez de criar duplicados.

The five canonical roles:

- `needs-triage` — maintainer needs to evaluate
- `needs-info` — waiting on reporter
- `ready-for-agent` — fully specified, AFK-ready (an agent can pick it up with no human context)
- `ready-for-human` — needs human implementation
- `wontfix` — will not be actioned

Default: each role's string equals its name. Ask the user if they want to override any. If their issue tracker has no existing labels, the defaults are fine.

**Section C — Domain docs.**

> Explainer: Alguns skills (`grill-with-docs`, `two-axis-review`) leem um `CONTEXT.md` pra aprender a linguagem de domínio do projeto, e os ADRs pra decisões passadas. Precisam saber se o repo tem um contexto global ou vários (ex.: um monorepo com contextos frontend/backend separados) pra olhar no lugar certo. Decisões arquiteturais neste setup vivem em `.claude/memory/decisions.md` por padrão (convenção global do usuário).

Confirm the layout:

- **Single-context** — one `CONTEXT.md` + ADRs em `.claude/memory/decisions.md` (ou `docs/adr/`). Most repos are this.
- **Multi-context** — `CONTEXT-MAP.md` at the root pointing to per-context `CONTEXT.md` files (typically a monorepo).

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)
- The contents of `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`

Let them edit before writing.

### 4. Write

**Pick the file to edit:**

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask the user which one to create — don't pick for them.

Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa) — always edit the one that's already there.

If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections.

The block:

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout — "single-context" or "multi-context"]. See `docs/agents/domain.md`.
```

Then write the three docs files using the seed templates in this skill folder as a starting point:

- [issue-tracker-github.md](./issue-tracker-github.md) — GitHub issue tracker
- [issue-tracker-local.md](./issue-tracker-local.md) — local-markdown issue tracker
- [triage-labels.md](./triage-labels.md) — label mapping
- [domain.md](./domain.md) — domain doc consumer rules + layout

For GitLab / Jira / Linear / "other" issue trackers, write `docs/agents/issue-tracker.md` from scratch using the user's description.

### 5. Done

Tell the user the setup is complete and which pipeline skills will now read from these files (`to-prd`, `to-issues`, `triage`, `grill-with-docs`, `two-axis-review`). Mention they can edit `docs/agents/*.md` directly later — re-running this skill is only necessary if they want to switch issue trackers or restart from scratch.
