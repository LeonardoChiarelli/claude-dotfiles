---
name: engineering-pipeline-skills
description: "Fixed-scope spec→issues→entrega pipeline skills adapted from mattpocock/skills, installed global in ~/.claude/skills"
metadata: 
  node_type: memory
  type: project
  originSessionId: e941e5da-4998-4ab1-b14c-a8b00e92ef84
---

Em 2026-06-01 instalei 7 skills adaptadas de [mattpocock/skills](https://github.com/mattpocock/skills) em `~/.claude/skills/` para o pipeline fixed-scope spec→issues→entrega. Documentadas no CLAUDE.md global (seção "Pipeline fixed-scope").

**Instaladas:** `setup-engineering-pipeline` (renomeado de `setup-matt-pocock-skills`, `disable-model-invocation:true`), `to-prd`, `to-issues`, `triage` (+AGENT-BRIEF.md, OUT-OF-SCOPE.md), `grill-with-docs` (+CONTEXT-FORMAT.md, ADR-FORMAT.md), `two-axis-review` (renomeado de `review`), `git-guardrails` (+hooks/block-dangerous-git.mjs).

**Adaptações aplicadas (não são cópias fiéis):**
- Interação em pt-BR; corpo de issue/PRD/label/commit em inglês.
- `two-axis-review`: renomeado p/ não colidir com `/review` e `/code-review` nativos. Eixo Standards roteia pro agent `code-reviewer` + `~/.claude/outcomes/code-review.yml` (não `general-purpose` hardcoded, ver [[prefer-orchestrator-routing]]). Eixo Spec é o valor exclusivo (scope creep) que os nativos não têm.
- ADRs do `grill-with-docs` vão pra `.claude/memory/decisions.md` (convenção memory-hygiene), não `docs/adr/`.
- `git-guardrails`: script bash original portado pra Node `.mjs` (Windows-compat, estilo de `guard-edits.mjs`/`check-emdash.mjs`). Hook verificado: bloqueia push/reset --hard com exit 2, permite commit/status. **Ainda não wired em settings.json** (mudança de comportamento, pendente de confirmação do usuário).
- Dropei seed GitLab; ficou GitHub + local markdown.

**Não adotadas (overlap com superpowers/setup existente):** `grill-me`≈brainstorming, `tdd`≈superpowers:tdd, `diagnose`≈systematic-debugging, `write-a-skill`≈writing-skills, `caveman` (já tem plugin). Off-topic puladas: writing-*, edit-article, obsidian-vault, scaffold-exercises, migrate-to-shoehorn, teach.

**Crítico:** os skills do pipeline leem config por-repo em `docs/agents/*.md`. Antes do primeiro uso num repo, rodar `/setup-engineering-pipeline`. Skill global = engine; config = por-repo. Ver [[claude-md-autoload-paths]].
