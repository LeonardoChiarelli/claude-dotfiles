---
name: scaffold-projetos-status
description: Scaffold de projetos de cliente (repo project-templates + skill novo-projeto-chiarelli) entregue em 2026-08-09; pendências E2E e merge do PR
metadata: 
  node_type: memory
  type: project
  originSessionId: 1ccd6bde-77e9-42ce-b276-aff0ed91c15a
  modified: 2026-08-09T04:12:20.942Z
---

Sistema de scaffold de projetos de cliente do Chiarelli Labs entregue em
2026-08-09 (ultracode: Opus implementou, Fable revisou, Sonnet commitou):

- Repo `chiarelli-dev/project-templates` (privado, branch única `main`, CI 5/5
  verde): overlay `shared/` → `stack-python|ts/` → `<tipo>/`, 4 tipos
  (desktop-python, automacao, agente-ia, web-app), `tools/scaffold.py`
  stdlib-only, provenance `.chiarelli/template.json`, `docs/sync-plan.md`
  (V2 escrito, não implementado).
- Skill global `novo-projeto-chiarelli` instalada em `~/.claude/skills`
  (fonte canônica em `skill/` no repo de templates). Wizard → scaffold →
  provisioning (gh + `db:seed-client` no site + Vercel/Neon pra web).
- Spec + plano no repo do site: `docs/superpowers/specs/2026-08-09-scaffold-projetos-design.md`
  e `docs/superpowers/plans/2026-08-09-scaffold-projetos.md`.

**Pendências:**
1. PR #209 do site (spec+plano+pointer no CLAUDE.md, `chore/spec-scaffold-projetos` → `dev`) aberto, aguardando merge.
2. E2E descartável nunca rodou (cria registro no DB de PRODUÇÃO via seed + repo `teste-scaffold`; só com confirmação do founder).
3. Smoke manual da skill em sessão nova não feito.

**Gotchas aprendidos:** `Documents\Code` é um repo git (project-templates é
aninhado; sempre `git -C`); CI de projeto gerado roda `pytest` sem cwd no
path (pyproject precisa `pythonpath = ["src", "."]`); script npm `prepare`
com hooksPath precisa `|| exit 0` pra install fora de repo git.

Relacionado: [[engineering-pipeline-skills]], [[claude-dotfiles-bootstrap]].
