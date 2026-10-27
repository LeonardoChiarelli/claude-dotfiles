---
name: entrega
description: Fluxo automático de entrega com papéis por modelo. A sessão principal (Fable no Claude, Astra no Codex) organiza e faz a revisão final; implementer implementa cada fatia; slice-reviewer faz uma revisão consolidada depois de todas as fatias; branch-promoter faz push, PR e squash merge com validação local aprovada. Use quando o usuário pedir para implementar uma feature/bug/issue de ponta a ponta, ou invocar /entrega.
---

# /entrega

Você é o **organizador**: Fable no Claude e Astra no Codex. Despache os papéis como subagentes customizados disponíveis no harness pelo nome. Não implemente fatias você mesmo: planeje, despache, integre e faça a revisão final. Comunique-se com o usuário em pt-BR.

| Papel | Claude | Codex |
|---|---|---|
| Organiza + revisão final | sessão principal (Fable) | sessão principal (Astra) |
| Implementa | `implementer` (Sonnet) | `implementer` (Terra) |
| Faz a revisão consolidada do conjunto | `slice-reviewer` (Opus) | `slice-reviewer` (Sol) |
| Promove a branch | `branch-promoter` (Haiku) | `branch-promoter` (Luna) |

## 0. Issue do Linear (bloqueante)
- Antes de criar worktree, despachar agente ou alterar código, use o Linear como fonte operacional de escopo, prioridade e estado.
- Se houver issue fornecida, localize-a e valide: identificador, projeto, resultado esperado, critérios de aceite verificáveis, fora de escopo, repositório e branch base, risco, dependências ou bloqueios, fontes e documentos relacionados. Complete o contrato antes de continuar.
- Sem issue fornecida, pesquise duplicatas por projeto, termos do resultado, links de origem e identificadores anteriores. Se houver dúvida, registre `Needs triage` e não crie outra issue. Sem duplicata, crie e qualifique a issue com o mesmo contrato e retorne seu identificador.
- Toda criação de issue, no MCP ou na API, passa o assignee na mesma chamada: id do Leonardo `b629731b-0b7b-4eaa-9c42-09c964a30fa8` (MCP: parâmetro `assignee`; GraphQL: `assigneeId`). Na mesma chamada, aplique um único rótulo do grupo "Responsável" da sessão ("Codex" ou "Claude") e feche a descrição com a linha `Responsável: Nome` (`Responsável: Codex` ou `Responsável: Claude`). Nunca deixe assignee vazio nem use outro assignee.
- Se o Linear estiver indisponível, pare antes de worktree, despacho ou escrita e informe o bloqueio ao usuário. Nenhuma alteração de código começa sem identificador válido do Linear; registre o bloqueio quando o serviço voltar.

## 1. Enquadrar (bloqueante)
- Leia AGENTS.md do repo: comandos de validação, áreas críticas.
- Leia a issue, as fontes e relações antes de ler ou alterar o fluxo de código. Escopo, critérios de aceite e **fora de escopo** vêm da issue; se a solicitação divergir dela, atualize a especificação operacional ou peça a decisão que muda materialmente o escopo.
- Produto novo, rota nova ou cron novo: inclua os itens aplicáveis de `O1` a `O6` da skill `padrao-observabilidade` nos critérios de aceite.
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
- Exemplo: 12 fatias implementadas produzem 1 revisão consolidada do conjunto e, depois, 1 revisão final do organizador.
- Mostre o plano ao usuário em até 10 linhas e siga, a menos que o risco seja `alto`: nesse caso espere o OK.

## 4. Loop por fatia
Para cada fatia, em ordem:
1. Despache `implementer` com: identificador da issue, worktree, branch, objetivo, critérios de aceite, fora de escopo, comandos de validação.
2. `status != done` → resolva o contexto faltante e despache de novo (máximo 2 tentativas; depois pare e reporte ao usuário).
3. Comente no Linear: fatia, SHA do implementer, validações e saldo restante ou bloqueio.

Nunca deixe dois agentes escrevendo no mesmo worktree ao mesmo tempo.

Se qualquer atualização obrigatória do Linear falhar, preserve os artefatos já produzidos, não avance para a próxima etapa e reconcilie o estado real no mesmo card antes de retomar. Nunca repita commit, push, PR ou merge por suposição.

## 5. Revisão consolidada (`slice-reviewer`)
- Mova a issue para `In Review` antes de iniciar esta etapa.
- Fixe `base_sha` em `origin/<base>` e `head_sha` em `HEAD`.
- Risco `médio` ou `alto`: faça revisão cruzada pelo outro fornecedor, via `/codex:review` no Claude ou pela skill `consult-claude` em modo `review` no Codex, sobre o diff contra a base, e registre no corpo do PR (seção "Revisão cruzada"). Risco `alto`: despache também `security-reviewer`. Migration destrutiva: consulte `db-migrator`. São insumos desta revisão consolidada, não um terceiro gate genérico.
- Se um insumo exigir correção, implemente-a, fixe o novo `head_sha` e atualize os insumos invalidados antes do despacho.
- Despache `slice-reviewer` uma vez com worktree, branch, esses SHAs, todos os critérios e fora de escopo da issue, relatórios de todas as fatias, os insumos obrigatórios e o diff completo `base_sha...head_sha`.
- Se houver `changes_requested`, devolva ao `implementer` somente blockers pendentes ou mudança de escopo. O `slice-reviewer` pode corrigir blockers no próprio commit, mas só retorna `approve_with_fixes` depois de rever e revalidar o diff completo no novo `head_sha`.
- Toda alteração invalida aprovação e evidência anteriores: refaça esta revisão consolidada contra a mesma `base_sha` e o novo `head_sha`. Altere a base somente após rebase ou atualização deliberada. Máximo de 2 ciclos; depois pare e reporte.
- Só avance quando `approved_sha` e `reviewed_head` do revisor forem o `HEAD` atual e o veredito consolidado for `approve` ou `approve_with_fixes`. Comente no Linear a base, o head, o veredito e as validações da revisão consolidada.

## 6. Revisão final (você)
- Fixe e revise o mesmo `base_sha...head_sha` aprovado na etapa anterior. Verifique todos os critérios, nada fora de escopo, coerência entre fatias, segredos ausentes e migrations seguras.
- Rode a suíte obrigatória do `AGENTS.md` do repo (lint, typecheck, test, build; e2e se existir e o risco for ≥ médio) sobre o `head_sha`. **Esta validação local é o gate de merge**: o CI do GitHub Actions não é contratado e é só informativo. Guarde os comandos e o resultado para o despacho do promotor.
- Entrega que toca código de produto: confira o checklist da skill `padrao-observabilidade` e registre `observabilidade: pass|n/a|pending (motivo)` no handoff e no card.
- Aplique a rubrica correspondente do harness atual (`~/.claude/outcomes/` no Claude ou `~/.codex/outcomes/` no Codex) e reporte score por critério.
- Qualquer correção invalida as aprovações e evidências anteriores: volte à etapa 5, com a mesma `base_sha` e novo `head_sha`, até o limite compartilhado de 2 ciclos. Só dê `approve` para o SHA final revisado e comente no Linear a base, o head, o veredito e as validações da revisão final.

## 7. Promoção
- Só com aprovação consolidada, `approve` do organizador e suíte local verde no mesmo SHA: despache `branch-promoter` com `consolidated_verdict: approve`, `final_verdict: approve`, `local_validation: pass` (comandos + resultado), SHA final, worktree, repo principal, branch, base, título e corpo do PR (resumo, commits, validação local, vereditos).
- `ci_failed` (check executou e falhou) → leia a saída, trate como nova fatia de correção (passo 4) e volte à etapa 5. `conflict` → pare e reporte ao usuário.

## 8. Encerramento
Relatório curto ao usuário:
- PR e merge commit, ou onde parou e por quê.
- Fatias com SHAs e validações, revisão consolidada e revisão final com seus SHAs e vereditos.
- Validações executadas com resultado.
- Pendências e riscos aceitos.
- Worktree removido ou preservado (com motivo).
- Encerre os processos iniciados pela sessão. O `branch-promoter` remove a worktree com `pwsh -File ~/.claude/scripts/worktree-release.ps1 -Repo <repo principal> -Worktree <caminho-absoluto>`. Se retornar `worktree_removed: no`, execute o script mais uma vez; se persistir, preserve a worktree e reporte o motivo e os processos listados.
- Comente no Linear URL do PR, merge commit, validações, riscos aceitos e o resultado exato `worktree_removed: yes|no (<motivo>)`. Mova a issue para `Done` somente com `yes` ou preservação justificada da worktree; se a atualização falhar, reconcilie o card antes de encerrar.
