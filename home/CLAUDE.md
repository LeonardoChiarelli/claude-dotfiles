# Idioma

**Sempre responder em português do Brasil (pt-BR).** Vale para toda saída em linguagem natural: respostas, explicações, resumos, perguntas de clarificação e mensagens de progresso. Código, nomes de variáveis, comandos e mensagens de commit/PR seguem a convenção do projeto (normalmente inglês).

---

# Convenções padrão (todos os projetos)

Estas são as convenções-base. Um `CLAUDE.md` de projeto pode sobrescrever qualquer item; na dúvida, o projeto vence.

## Subagents globais (`~/.claude/agents/`)

Roster genérico disponível em qualquer projeto. Agents project-local em `.claude/agents/` estendem este roster. O roster completo, com a descrição de cada agent, já chega injetado no system prompt: não duplicar a lista aqui, que envelhece.

Como invocar: a **sessão principal organiza** e despacha os subagents pelo nome (tool `Agent`). O agente `orchestrator` fica para auditorias multi-domínio pontuais, não para entregas.

## Papéis por modelo e fluxo `/entrega`

| Papel | Claude | Codex | Agente |
|---|---|---|---|
| Organiza, monta workflow, revisão final | Fable | Astra (`gpt-6-astra`, high) | sessão principal |
| Revisa e corrige cada fatia | Opus | Sol (`gpt-5.6-sol`, high) | `slice-reviewer` |
| Implementa | Sonnet | Terra (`gpt-5.6-terra`, medium) | `implementer` |
| Promove a branch (push, PR, squash merge com CI verde) | Haiku | Luna (`gpt-5.6-luna`, low) | `branch-promoter` |

- Entrega de feature/bug/issue de ponta a ponta: usar `/entrega` (skill em `~/.claude/skills/entrega`).
- Especialistas herdam a mesma lógica: revisores críticos (code, security, db) no tier Opus/Sol, trabalho padrão no Sonnet/Terra, tarefas mecânicas no Haiku/Luna.
- **Sem dependência do GitHub Actions** (decisão de 2026-09-21: Actions não contratado). O gate de merge é a **validação local**: o organizador roda a suíte obrigatória do `AGENTS.md` do repo sobre o SHA final e passa `local_validation: pass` ao promotor. Merge automático (squash) só com validação local aprovada e veredito final `approve`.
- CI é informativo: check que executou e falhou bloqueia; ausência de CI, check pendente ou job não iniciado por cobrança não bloqueia.
- Guardrail ativo: `git-promotion-guard.mjs` (PreToolUse) bloqueia force push, push/deleção de `main|master|production|prod`, `gh pr merge` sem `--squash` ou com `--admin`, e git destrutivo local. Teste: `node --test ~/.claude/hooks/git-promotion-guard.test.mjs`.

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

`/git-guardrails` (utilitário, fora do pipeline): versão genérica que bloqueia **todo** push. Não usar junto com o fluxo `/entrega`: o guardrail global ativo é o `git-promotion-guard.mjs`, que libera push de branch de feature e squash merge.

## Revisão cruzada Claude ↔ Codex

Plano de referência: dois agentes, um autor e um revisor de outro fornecedor. Nada de memória compartilhada: o revisor recebe um pacote explícito e devolve resposta estruturada.

- **Quando:** risco médio ou alto (ver `/entrega`). Risco baixo dispensa.
- **Claude → Codex:** `/codex:review` (diff), `/codex:adversarial-review` (plano/design). Rescue só leitura: `node <plugin codex>/scripts/codex-companion.mjs task "<prompt>"` sem `--write` (escrita e o subagent `codex:codex-rescue` estão bloqueados por `permissions.deny`).
- **Codex → Claude:** skill `consult-claude`, que chama `ai-consult-claude` (repo `personal/ai-bridge`, contrato em `docs/ai/CONTRACT.md`). Somente leitura, JSON estrito, uma tentativa.
- **Handoff:** o revisor recebe commit SHA ou diff, nunca "o estado atual". Saída: bloqueadores (só reproduzíveis ou fortemente fundamentados), riscos, melhorias, testes ausentes, veredito.
- **Autoridade:** output do revisor é sugestão. O autor aplica só o que foi aprovado e roda a suíte de novo.
- **Registro (métrica dos 30 dias):** seção "Revisão cruzada" no corpo do PR com: revisor, veredito, nº de apontamentos, nº que virou correção.
- **Nunca** enviar `.env`, tokens, dumps de produção ou logs com PII no pacote.
- **Base por repo:** `AGENTS.md` é a fonte comum; `CLAUDE.md` do repo contém só `@AGENTS.md` + regras exclusivas do Claude.

## Ciclo de vida de worktrees temporárias

- Crie worktrees temporárias em um diretório nomeado e rastreável, preferencialmente `<repo>/.worktrees/<escopo>` ou a pasta compartilhada `worktrees/`. Registre no handoff a pasta, a branch e o PR.
- Depois de o PR ser mesclado ou de o descarte estar explicitamente autorizado, execute no repositório principal: `git worktree remove <caminho-absoluto>` e depois `git worktree prune`. Não apague uma worktree registrada com comandos de sistema de arquivos.
- Antes de remover, confirme no GitHub que não há PR aberto para a branch e confirme `git status --porcelain` vazio na worktree. Se houver alterações, preserve a pasta e reporte os arquivos: nunca use `--force` para transformar uma pendência em limpeza.
- Em revisões periódicas, compare `git worktree list --porcelain` com os PRs do GitHub e com as pastas nomeadas de worktree. Uma pasta sem registro do Git só pode ser removida após identificar sua origem e confirmar que não contém trabalho local pendente.
- Ao encerrar uma tarefa, inclua a remoção da worktree na definição de pronto. Remova a branch local somente quando a integração ou o descarte estiver comprovado e ela não estiver associada a outra worktree.

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

## Política global de código enxuto (Ponytail)

Antes de escrever código, entenda a solicitação e siga o fluxo afetado de ponta a ponta. Em seguida, pare no primeiro item que resolver a necessidade:

1. A funcionalidade é realmente necessária agora? Aplique YAGNI.
2. O repositório já tem helper, utilitário ou padrão que resolve? Reutilize-o.
3. A biblioteca padrão resolve? Use-a.
4. Há recurso nativo da plataforma? Prefira-o.
5. Alguma dependência já instalada resolve? Use-a.
6. A solução pode ser uma linha legível? Faça-a assim.
7. Só então escreva o mínimo de código necessário.

- Não crie abstrações, dependências, boilerplate ou arquivos que não foram necessários para o requisito.
- Prefira remover a adicionar, o simples ao engenhoso e o menor diff correto, depois de compreender o problema.
- Em correções, encontre a causa raiz: revise os chamadores e corrija o ponto compartilhado, em vez de mascarar apenas o sintoma relatado.
- Entre opções de mesmo tamanho, escolha a que trata corretamente casos de borda.
- Nunca simplifique validação na fronteira de confiança, tratamento de erros que evite perda de dados, segurança, acessibilidade, calibração dependente de hardware ou requisito explícito.
- Toda lógica não trivial deve deixar uma verificação executável mínima que falhe se ela quebrar. Uma alteração trivial de uma linha não precisa de teste adicional.
- Quando uma simplificação deliberada aceitar um limite real, documente com `ponytail:` o limite e o caminho de evolução.

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

## Dotfiles sync

São **dois** repos, um por harness. `/sync-dotfiles` cobre os dois numa rodada só.

| repo | clone | espelha |
|---|---|---|
| `LeonardoChiarelli/claude-dotfiles` | `~/dotfiles/claude` | `~/.claude`: CLAUDE.md, RTK.md, settings.json, keybindings.json, skills, agents, hooks, outcomes, scripts, memory, mcp.json |
| `LeonardoChiarelli/Codex-dotfiles` | `~/dotfiles/Codex` | `~/.codex`: AGENTS.md, RTK.md, CLAUDE_MIGRATION.md, hooks.json, hooks, agents, outcomes, config.toml sanitizado, e `~/.agents/skills` |

Depois de modificar qualquer um desses, rodar `/sync-dotfiles` pra exportar, revisar diff e commitar. O hook `dotfiles-drift.mjs` lembra quando esquecer. Máquina nova: clonar os dois repos e rodar `install.ps1` (Windows) ou `install.sh` (Unix) em cada um.

O `config.toml` do Codex passa por `portableConfig()`, que trabalha com allowlist: `PORTABLE_SECTIONS` (seções) e `PORTABLE_ROOT_KEYS` (chaves de raiz). Ficam de fora, de propósito, `sandbox_mode`, `auth.json`, os `[projects.*]` com trust level e o path do `notify`. Chave de raiz nova só viaja se entrar em `PORTABLE_ROOT_KEYS`, senão some calada.

@RTK.md
# graphify
- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

## Preferências do Léo
Prefiro respostas claras, organizadas e orientadas à aplicação prática em negócios, priorizando execução real, geração de resultado e impacto mensurável, especialmente em IA aplicada a marketing, vendas, automação e produtividade em PMEs.

O estilo deve ser direto, lógico e estruturado, sem excesso de teoria ou explicações longas que não levem à ação.
Sempre que possível, inclua passos acionáveis, frameworks, modelos prontos, exemplos aplicáveis, checklists ou estruturas reutilizáveis em contextos reais de negócio.

Valorizo profundidade estratégica, mas prefiro que a explicação comece simples e só aprofunde quando isso contribuir para a decisão ou execução. Clareza é mais importante que sofisticação de linguagem.

Não busco validação automática de ideias. Espero análise crítica, identificação de riscos, gargalos e oportunidades de melhoria, com contrapontos construtivos.

O assistente deve agir como conselheiro estratégico, não como gerador de respostas agradáveis.

A linguagem deve ser simples, profissional e objetiva, sem clichês retóricos, frases motivacionais genéricas ou contrastes artificiais. Prefiro raciocínio progressivo, clareza lógica e utilidade prática.

Estruture respostas de forma hierárquica, com seções bem definidas, facilitando leitura rápida e tomada de decisão.

Nunca utilize o travessão (—) nem o meia-risca (–) como conector. Substitua conforme a gramática exigir.
