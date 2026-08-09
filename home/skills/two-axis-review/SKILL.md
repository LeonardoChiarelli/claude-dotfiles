---
name: two-axis-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes — Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/PRD asked for?). Runs both reviews as parallel sub-agents and reports them side by side. Use when the user wants a spec-vs-implementation review, to catch scope creep, or to "review since X" against the originating issue.
---

> **Adaptado de [mattpocock/skills](https://github.com/mattpocock/skills)** (skill original: `review`). Convenções locais:
> - Renomeado para `two-axis-review` para não colidir com os comandos nativos `/review` (revisa um PR) e `/code-review` (revisa o diff atual). O valor exclusivo deste skill é o **eixo Spec**: confere se o que foi implementado bate com a issue/PRD de origem e flagra scope creep. Os comandos nativos não fazem isso.
> - Roteamento de sub-agentes segue a convenção do usuário (orchestrator/agents nomeados), **não** `general-purpose` hardcoded: eixo **Standards** roda no agent `code-reviewer` aplicando a rubrica `~/.claude/outcomes/code-review.yml`; eixo **Spec** roda em um sub-agente focado read-only.
> - Saída e resumos em **pt-BR**.

# Two-Axis Review

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / PRD / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you — run `/setup-engineering-pipeline` if `docs/agents/issue-tracker.md` is missing.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. Don't be opinionated; pass it through. If they didn't specify one, ask: "Revisar contra o quê — uma branch, um commit, ou `main`?" Don't proceed until you have it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, etc.) — fetch via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A PRD/spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written. Common locations:

- `CLAUDE.md`, `AGENTS.md` (root, local, and `~/.claude/CLAUDE.md` global)
- `CONTRIBUTING.md`
- `CONTEXT.md`, `CONTEXT-MAP.md`, per-context `CONTEXT.md` files
- `docs/adr/` and `.claude/memory/decisions.md` (architectural decisions are standards)
- `~/.claude/outcomes/code-review.yml` (rubrica de review deste usuário)
- `.editorconfig`, `eslint.config.*`, `biome.json`, `prettier.config.*`, `tsconfig.json` (machine-enforced standards — note them but don't re-check what tooling already checks)
- Any `STYLE.md`, `STANDARDS.md`, `STYLEGUIDE.md`, or similar at the repo root or under `docs/`

Collect the list of files. The **Standards** sub-agent will read them.

### 4. Spawn both axes in parallel

Send a single message with two `Task` tool calls so they run concurrently.

**Standards axis** — use the **`code-reviewer`** agent (não `general-purpose`). Prompt includes:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, incluindo `~/.claude/outcomes/code-review.yml`.
- The brief: "Read the standards docs and the `code-review.yml` rubric. Then read the diff. Report — per file/hunk where relevant — every place the diff violates a documented standard. Cite the standard (file + the rule). Distinguish hard violations from judgement calls. Skip anything tooling enforces. Report o score por critério da rubrica. Under 400 words."

**Spec axis** — use a focused read-only sub-agent (`general-purpose` é aceitável aqui pois não há agent nomeado para checagem de spec). Prompt includes:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Read the spec. Then read the diff. Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec axis and note this in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate so the user can see them independently.

End with a one-line summary (pt-BR): total de findings por eixo, e o pior problema isolado (se houver).

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.

## Relação com os comandos nativos

- `/code-review` (nativo) — caça bugs de correção + cleanups no diff atual. Qualidade/correção, **sem** checagem de spec.
- `/review` (nativo) — revisa um PR do GitHub.
- `two-axis-review` (este) — adiciona o eixo **Spec** (implementou o que a issue pediu? scope creep?) que falta nos outros, e roda o eixo Standards via `code-reviewer` + rubrica. Use quando houver uma issue/PRD de origem para conferir.
