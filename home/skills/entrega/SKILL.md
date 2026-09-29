---
name: entrega
description: Fluxo automático de entrega com papéis por modelo. A sessão principal (Fable no Claude, Astra no Codex) organiza e faz a revisão final; implementer implementa cada fatia; slice-reviewer revisa e corrige cada fatia; branch-promoter faz push, PR e squash merge com validação local aprovada. Use quando o usuário pedir para implementar uma feature/bug/issue de ponta a ponta, ou invocar /entrega.
---

# /entrega

Você é o **organizador** (Astra). Despache os papéis como subagentes customizados de `~/.codex/agents/` pelo nome. Não implemente fatias você mesmo: planeje, despache, integre e faça a revisão final. Comunique-se com o usuário em pt-BR.

| Papel | Claude | Codex |
|---|---|---|
| Organiza + revisão final | sessão principal (Fable) | sessão principal (Astra) |
| Implementa | `implementer` (Sonnet) | `implementer` (Terra) |
| Revisa e corrige cada fatia | `slice-reviewer` (Opus) | `slice-reviewer` (Sol) |
| Promove a branch | `branch-promoter` (Haiku) | `branch-promoter` (Luna) |

## 0. Issue do Linear (bloqueante)
- Antes de criar worktree, despachar agente ou alterar código, use o Linear como fonte operacional de escopo, prioridade e estado.
- Se houver issue fornecida, localize-a e valide: identificador, projeto, resultado esperado, critérios de aceite verificáveis, fora de escopo, repositório e branch base, risco, dependências ou bloqueios, fontes e documentos relacionados. Complete o contrato antes de continuar.
- Sem issue fornecida, pesquise duplicatas por projeto, termos do resultado, links de origem e identificadores anteriores. Se houver dúvida, registre `Needs triage` e não crie outra issue. Sem duplicata, crie e qualifique a issue com o mesmo contrato e retorne seu identificador.
- Se o Linear estiver indisponível, pare antes de worktree, despacho ou escrita e informe o bloqueio ao usuário. Nenhuma alteração de código começa sem identificador válido do Linear; registre o bloqueio quando o serviço voltar.

## 1. Enquadrar (bloqueante)
- Leia AGENTS.md do repo: comandos de validação, áreas críticas.
- Leia a issue, as fontes e relações antes de ler ou alterar o fluxo de código. Escopo, critérios de aceite e **fora de escopo** vêm da issue; se a solicitação divergir dela, atualize a especificação operacional ou peça a decisão que muda materialmente o escopo.
- Classifique o risco: `baixo` (doc, copy, config local), `médio` (feature comum), `alto` (auth, pagamentos, dados, migrations, infra).

## 2. Preparar o worktree
- Registre no Linear plano de fatias, risco, worktree absoluto, branch e base; mova a issue para `In Progress` quando o trabalho começar.
- Crie uma única worktree para a sessão, logo após qualificar a issue do Linear. Todos os agentes trabalham nela, um escritor por vez.
- Branch `feat/<escopo>` ou `fix/<escopo>` a partir da base atualizada (`git fetch`).
- `git worktree add <repo>/.worktrees/<escopo> -b <branch> origin/<base>`.
- Registre worktree absoluto, branch e base; eles vão em todo despacho.

## 3. Plano em fatias
- Fatias verticais pequenas, cada uma com critério de aceite verificável e ordem de dependência.
- Uma worktree por sessão: todas as fatias rodam nela. Fatias que tocam os mesmos arquivos são sequenciais; fatias independentes só rodam em paralelo quando tocam arquivos disjuntos e são commitadas em sequência pelo organizador. Nada de worktree por fatia.
- Mostre o plano ao usuário em até 10 linhas e siga, a menos que o risco seja `alto`: nesse caso espere o OK.

## 4. Loop por fatia
Para cada fatia, em ordem:
1. Despache `implementer` com: identificador da issue, worktree, branch, objetivo, critérios de aceite, fora de escopo, comandos de validação.
2. `status != done` → resolva o contexto faltante e despache de novo (máximo 2 tentativas; depois pare e reporte ao usuário).
3. Despache `slice-reviewer` com: worktree, branch, **SHA** do implementer, critérios, relatório do implementer.
4. `changes_requested` → devolva os blockers ao `implementer` (máximo 2 ciclos; depois pare e reporte).
5. Comente no Linear: fatia, SHA, validações, veredito do revisor e saldo restante ou bloqueio.

Nunca deixe dois agentes escrevendo no mesmo worktree ao mesmo tempo.

Se qualquer atualização obrigatória do Linear falhar, preserve os artefatos já produzidos, não avance para a próxima etapa e reconcilie o estado real no mesmo card antes de retomar. Nunca repita commit, push, PR ou merge por suposição.

## 5. Revisão final (você)
- Mova a issue para `In Review` antes de iniciar esta etapa.
- `git -C <worktree> diff origin/<base>...HEAD` completo, não só as fatias.
- Rode a suíte obrigatória do `AGENTS.md` do repo (lint, typecheck, test, build; e2e se existir e o risco for ≥ médio) sobre o SHA final. **Esta validação local é o gate de merge**: o CI do GitHub Actions não é contratado e é só informativo. Guarde os comandos e o resultado para o despacho do promotor.
- Verifique: todos os critérios atendidos, nada fora de escopo, coerência entre fatias, segredos ausentes, migrations seguras (destrutiva → consultar `db-migrator`).
- Risco `médio` ou `alto`: revisão cruzada pelo outro fornecedor via a skill `consult-claude` (modo `review`, diff contra a base) e registre no corpo do PR (seção "Revisão cruzada"). Aplique só apontamentos que você aprovar, como nova fatia.
- Risco `alto`: despache também `security-reviewer`.
- Aplique a rubrica de `~/.codex/outcomes/` correspondente (feature/bug-fix/refactor) e reporte score por critério.
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
- Encerre os processos iniciados pela sessão. O `branch-promoter` remove a worktree com `pwsh -File ~/.claude/scripts/worktree-release.ps1 -Repo <repo principal> -Worktree <caminho-absoluto>`. Se retornar `worktree_removed: no`, execute o script mais uma vez; se persistir, preserve a worktree e reporte o motivo e os processos listados.
- Comente no Linear URL do PR, merge commit, validações, riscos aceitos e o resultado exato `worktree_removed: yes|no (<motivo>)`. Mova a issue para `Done` somente com `yes` ou preservação justificada da worktree; se a atualização falhar, reconcilie o card antes de encerrar.
