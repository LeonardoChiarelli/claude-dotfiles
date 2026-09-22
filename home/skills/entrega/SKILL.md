---
name: entrega
description: Fluxo automático de entrega com papéis por modelo. A sessão principal (Fable no Claude, Astra no Codex) organiza e faz a revisão final; implementer implementa cada fatia; slice-reviewer revisa e corrige cada fatia; branch-promoter faz push, PR e squash merge com validação local aprovada. Use quando o usuário pedir para implementar uma feature/bug/issue de ponta a ponta, ou invocar /entrega.
---

# /entrega

Você é o **organizador**. Não implemente fatias você mesmo: planeje, despache, integre e faça a revisão final. Comunique-se com o usuário em pt-BR.

| Papel | Claude | Codex |
|---|---|---|
| Organiza + revisão final | sessão principal (Fable) | sessão principal (Astra) |
| Implementa | `implementer` (Sonnet) | `implementer` (Terra) |
| Revisa e corrige cada fatia | `slice-reviewer` (Opus) | `slice-reviewer` (Sol) |
| Promove a branch | `branch-promoter` (Haiku) | `branch-promoter` (Luna) |

## 1. Enquadrar (bloqueante)
- Leia AGENTS.md/CLAUDE.md do repo: comandos de validação, áreas críticas.
- Escopo, critérios de aceite e **fora de escopo** explícitos. Se a origem for issue/PRD, use-a. Se o pedido for ambíguo, pergunte antes de seguir (uma rodada, perguntas objetivas).
- Classifique o risco: `baixo` (doc, copy, config local), `médio` (feature comum), `alto` (auth, pagamentos, dados, migrations, infra).

## 2. Preparar o worktree
- Branch `feat/<escopo>` ou `fix/<escopo>` a partir da base atualizada (`git fetch`).
- `git worktree add <repo>/.worktrees/<escopo> -b <branch> origin/<base>`.
- Registre worktree absoluto, branch e base; eles vão em todo despacho.

## 3. Plano em fatias
- Fatias verticais pequenas, cada uma com critério de aceite verificável e ordem de dependência.
- Fatias que tocam os mesmos arquivos são sequenciais. Fatias independentes só rodam em paralelo com worktrees separados (um por fatia, mesclados na branch da tarefa por você).
- Mostre o plano ao usuário em até 10 linhas e siga, a menos que o risco seja `alto`: nesse caso espere o OK.

## 4. Loop por fatia
Para cada fatia, em ordem:
1. Despache `implementer` com: worktree, branch, objetivo, critérios de aceite, fora de escopo, comandos de validação.
2. `status != done` → resolva o contexto faltante e despache de novo (máximo 2 tentativas; depois pare e reporte ao usuário).
3. Despache `slice-reviewer` com: worktree, branch, **SHA** do implementer, critérios, relatório do implementer.
4. `changes_requested` → devolva os blockers ao `implementer` (máximo 2 ciclos; depois pare e reporte).
5. Registre: fatia, SHAs, veredito, validações.

Nunca deixe dois agentes escrevendo no mesmo worktree ao mesmo tempo.

## 5. Revisão final (você)
- `git -C <worktree> diff origin/<base>...HEAD` completo, não só as fatias.
- Rode a suíte obrigatória do `AGENTS.md` do repo (lint, typecheck, test, build; e2e se existir e o risco for ≥ médio) sobre o SHA final. **Esta validação local é o gate de merge**: o CI do GitHub Actions não é contratado e é só informativo. Guarde os comandos e o resultado para o despacho do promotor.
- Verifique: todos os critérios atendidos, nada fora de escopo, coerência entre fatias, segredos ausentes, migrations seguras (destrutiva → consultar `db-migrator`).
- Risco `médio` ou `alto`: revisão cruzada pelo outro fornecedor via `/codex:review` (diff contra a base) e registre no corpo do PR (seção "Revisão cruzada"). Aplique só apontamentos que você aprovar, como nova fatia.
- Risco `alto`: despache também `security-reviewer`.
- Aplique a rubrica de `~/.claude/outcomes/` correspondente (feature/bug-fix/refactor) e reporte score por critério.
- Veredito: `approve` ou volte ao passo 4 com as fatias afetadas.

## 6. Promoção
- Só com `approve` e suíte local verde: despache `branch-promoter` com `final_verdict: approve`, `local_validation: pass` (comandos + resultado), SHA final, worktree, repo principal, branch, base, título e corpo do PR (resumo, commits, validação local, vereditos).
- `ci_failed` (check executou e falhou) → leia a saída, trate como nova fatia de correção (passo 4) e promova de novo. `conflict` → pare e reporte ao usuário.

## 7. Encerramento
Relatório curto ao usuário:
- PR e merge commit, ou onde parou e por quê.
- Fatias com SHAs e vereditos.
- Validações executadas com resultado.
- Pendências e riscos aceitos.
- Worktree removido ou preservado (com motivo).
