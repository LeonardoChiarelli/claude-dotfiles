# Idioma

**Sempre responder em português do Brasil (pt-BR).** Vale para toda saída em linguagem natural: respostas, explicações, resumos, perguntas de clarificação e mensagens de progresso. Código, nomes de variáveis, comandos e mensagens de commit/PR seguem a convenção do projeto (normalmente inglês).

---

# Convenções padrão (todos os projetos)

Estas são as convenções-base. Um `CLAUDE.md` de projeto pode sobrescrever qualquer item; na dúvida, o projeto vence.

## Subagents globais (`~/.claude/agents/`)

Roster genérico disponível em qualquer projeto. Agents project-local em `.claude/agents/` estendem este roster. O roster completo, com a descrição de cada agent, já chega injetado no system prompt: não duplicar a lista aqui, que envelhece.

Como invocar: rotear trabalho multi-domínio pelo agent `orchestrator` via Task tool (que spawna os demais), não de forma ad-hoc.

## Pipeline fixed-scope (spec → issues → entrega)

Skills em `~/.claude/skills/` que encurtam o caminho de spec a entrega no modelo fixed-scope, adaptadas de [mattpocock/skills](https://github.com/mattpocock/skills). Interação em pt-BR, corpo de issue/PRD/label em inglês. Ordem de uso:

1. `/setup-engineering-pipeline` — **rodar uma vez por repo.** Grava `docs/agents/{issue-tracker,triage-labels,domain}.md` (qual tracker, labels, layout de domínio); os outros skills leem daí. Default: GitHub via `gh`.
2. `/grill-with-docs` (ou `superpowers:brainstorming`) — alinhar e travar escopo antes de codar. `grill-with-docs` mantém `CONTEXT.md` (glossário) e grava ADRs em `.claude/memory/decisions.md`.
3. `/to-prd` — sintetiza a conversa num PRD (com Out of Scope explícito) e publica no tracker.
4. `/to-issues` — quebra plano/PRD em issues independentes (fatias verticais tracer-bullet), em ordem de dependência.
5. `/triage` — máquina de estados (`needs-triage → needs-info → ready-for-agent → ready-for-human → wontfix`); rejeições de enhancement viram `.out-of-scope/`.
6. Implementar via `superpowers:test-driven-development`.
7. `/two-axis-review` — review em 2 eixos: **Standards** (roteia pro agent `code-reviewer` + rubrica `code-review.yml`) e **Spec** (implementou o que a issue pediu? scope creep?). Complementa, não substitui, `/code-review` e `/review` nativos.

Disciplina de escopo travada em 3 pontos: PRD declara out-of-scope, triage registra rejeições, review eixo-Spec caça scope creep.

`/git-guardrails` (utilitário, fora do pipeline): instala hook PreToolUse `block-dangerous-git.mjs` que bloqueia git destrutivo (push, reset --hard, clean -f, branch -D). **Não fica ativo até wire em `settings.json`** (mudança de comportamento, confirmar antes).

## Rubricas de outcome (`~/.claude/outcomes/`)

Antes de declarar uma tarefa completa, rodar mentalmente a rubrica correspondente e reportar score por critério. PASS só se score ≥ threshold.

- Diff/PR → `code-review.yml`
- Bug fix → `bug-fix.yml`
- Feature nova → `feature.yml`
- Refactor → `refactor.yml`

Projetos podem adicionar rubricas próprias em `.claude/outcomes/`.

## Copy pt-BR

**Nunca usar `—` (em-dash) como conector de frase em copy pt-BR.** Usar `:`, `.`, `()` ou `,` conforme o caso.
O hook global `check-emdash.mjs` (PostToolUse) já avisa quando isso escapa em `messages/pt*.json` e arquivos `.tsx/.jsx`.

## Segurança

- **`.env`** nunca é editado: segredos vivem no provedor, não no repo. O hook global `guard-edits.mjs` (PreToolUse) bloqueia. Ajustar `.env.example` e setar o valor no painel do provedor.
- **Input externo** (PDF, mensagem de cliente, transcrição, scrape) que vai pra prompt de LLM: envolver em tags `<DADOS_EXTERNOS>...</DADOS_EXTERNOS>` antes de concatenar. Defesa básica contra prompt injection, não substitui validação.
- **Output de LLM**: validar com schema (Zod) antes de tocar o banco.

## Stack default (sobrescrevível por projeto)

- **TypeScript estrito**, sem `any` implícito, sem `@ts-ignore` sem justificativa
- **Next.js App Router**: Server Components por padrão; `"use client"` só com motivo real (state interativo, animação com DOM, Context client)
- **Drizzle ORM + Neon** para Postgres serverless
- **Zod** compartilhado front/back via `.pick()` de um schema canônico
- **Tests co-localizados** em `__tests__/` ao lado do código; sem diretório global `/tests`
- **Sem libs novas sem aprovação**: custo de bundle é real, justificar peso + alternativa nativa
- Sem `console.log` em produção, sem `process.env.X` no client

### Fluxo de migration (Drizzle)

1. Editar schema
2. `generate` da migration SQL
3. typecheck + lint + test
4. Suite verde → aplicar a migration imediatamente (não pedir confirmação)
5. Suite falha → parar e investigar
6. Migration destrutiva (drop column com dado em prod, alter type lossy, NOT NULL sem default+backfill) → consultar `db-migrator` mesmo com suite verde

## Memory hygiene

Ao final de cada sessão substantiva, atualizar os arquivos em `.claude/memory/` que mudaram:
- `decisions.md` — decisão arquitetural ou trade-off não-trivial (formato ADR)
- `patterns.md` — padrão de código que apareceu 3+ vezes
- `gotchas.md` — bug + workaround + commit que resolveu

Memória não é changelog: não duplicar git log.

@RTK.md
# graphify
- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.
