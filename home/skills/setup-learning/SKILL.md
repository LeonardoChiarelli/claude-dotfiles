---
name: setup-learning
description: Mantém estado privado e recuperável para candidatos de aprendizado global.
---

# Setup Learning

O estado operacional fica exclusivamente em `%LOCALAPPDATA%/setup-learning` ou em `stateDir` configurado localmente. Ele não escreve em memórias gerenciadas, Academy Acervo, histórico Git ou configuração de runtime.

Os eventos persistidos contêm somente metadados sanitizados e localizadores permitidos. O journal, os sinais imutáveis, o snapshot e o lock ficam dentro de `stateDir`. Toda mutação usa escritor único. `recover-lock` só remove um lock após TTL, prova de PID morto e releitura da mesma identidade; lock ativo, recente ou incerto permanece `pending`.

Consulte [a política](references/policy.md) antes de coletar, analisar ou aplicar qualquer candidato.

## CLI e limites

Execute `node skills/setup-learning/cli.mjs <rota> --state-dir <diretório-privado>`. As rotas determinísticas nunca aceitam `exec`, comandos do modelo nem caminhos vindos de sugestões. `prepare-analysis` recebe pela entrada padrão buffers já sanitizados e transitórios vinculados a eventos persistidos; não imprime nem persiste buffers, prompts ou histórico.

Antes de `propose`, inspecione descrições e conteúdo dos artefatos para montar o catálogo real. Nome ou path semelhante não comprova equivalência. A qualificação ocorre autonomamente no fluxo `/entrega`, sem pedir confirmação humana por padrão e antes de qualquer geração. Um sinal isolado não cria issue.

`stage` vincula o candidato a blobs, base, commit e patch Git reais. Em AGENTS, a primeira mudança cria a área gerenciada de preferências e as seguintes alteram somente seu interior, preservando todo o restante. Essa escrita não aceita texto livre: usa o catálogo fechado de quatro preferências de `managedPreferences` e `renderManagedPreferences`. `check-apply` reexecuta a política sobre o manifesto persistido e informa motivos verificáveis. Ele é somente preflight: não ativa runtime, hook ou MCP.

## Worker, controlador e digest

O backfill executável é `worker --mode manual --deadline <ISO UTC>` com janela máxima de 20 minutos. A CLI monta em código as dependências nativas de descoberta, parser, releitura por locator, analyzer da assinatura, catálogo e detector. O escopo vem somente do `cwd` nativo: Git `git-common-dir` vira uma identidade hash canônica, inclusive entre worktrees; home e roots globais fixas viram global. Origem sem prova fica `uncertain` e nunca ganha escopo global pelo modelo. No modo agendado, o mesmo comando exige `scheduler: available` persistido por `record-capability --result <JSON>` após observação do controlador. A evidência tem schema fechado com capability, status, evidenceRef e observedAt. O analyzer recebe no máximo 120 segundos e nunca mais do que o restante da janela. Cursor inválido, diagnóstico ou lease concorrente mantêm o ciclo `pending`. Um lote parcial também retorna `pending`, mas evidência completa de fontes independentes ainda pode produzir um candidato; itens incertos não entram na evidência. Hooks nativos sem timestamp usam o relógio local somente como horário observado da fonte de lifecycle, nunca como horário da mensagem humana. O hook Cursor persiste somente locator allowlisted. O worker o resolve novamente sob `.cursor/projects`; como o JSONL nativo confirmado não possui timestamp por mensagem, não inventa horário nem evento e informa `cursor_timestamp_uncertain`.

Sugestões, evidência combinada e IDs analisados são confirmados na mesma transação curta. O lease exclusivo do worker não segura o lock de coleta ou digest durante a chamada ao modelo. Só um candidato novo, inclusive `pending`, é persistido por ciclo. Um `pending` fica visível no digest sem reservar handoff; o ciclo seguinte pode considerar outro padrão. A CLI devolve `action: start-delivery` e `skill: entrega`; o controlador verifica sessão ociosa, executa `/entrega` e registra a prova por `finish-handoff --result <JSON>`. `reject --result <JSON>` aceita somente motivo fechado e evidência, grava transição e tombstone e não reabre automaticamente. Padrão aplicado só pode gerar um novo candidato rastreável quando houver correção humana verificada posterior à última aplicação e sem contradição. Node não cria issue nem recebe função, comando ou path de JSON do modelo. MCP pode chegar a staging, mas ativação, credencial e novo poder continuam fora do worker.

`activate` e `rollback` exigem candidato e receipt persistidos. A CLI isolada devolve um plano `pending`. Candidato derivado de um único repositório pode seguir para digest e handoff, mas stage e apply nas roots globais ficam `pending` até existir adapter dedicado ao projeto. O controlador confiável cria `createNativeActivationController` com `sourceWorktree` absoluto, adapters fixos de skill, hook ou agents, probes nativos de idle e smokes por host. Os targets vêm somente do manifesto persistido. O modelo não fornece funções, comandos, roots ou paths. MCP continua pendente de aprovação específica.

O controlador nativo executa Gmail fora do Node. `prepare-digest` cria um resumo generalizado com estado, contagem de evidência e próximo gate. `begin-digest` grava `sending` antes de devolver a requisição MIME HTML fechada. `finish-digest` recebe a prova normalizada. Em resultado incerto, `reconcile-digest` primeiro consulta SENT pelo assunto, depois pede `gmail_read_email` em formato `full` para cada ID retornado e confirma destinatário, assunto e corpo HTML exato. `record-installation --fact <JSON>` registra somente fatos observados de host e hash para o primeiro digest, sem inventar Event ou Candidate. Sem Gmail autenticado, o envio permanece `pending`; não use outro provedor.

O catálogo é calculado a partir de artefatos reais e hash-bound nas skills canônicas e no cache instalado de plugins. O controlador projeta a observação nativa `skills/list` em memória para um ledger fechado com source, evidenceRef, observedAt e entradas path, hash e disabled. Somente path e hash que ainda batem com arquivo confinado definem `enabled`. Skills desativadas continuam visíveis com `enabled: false`; sem inventário correspondente ficam `enabled: unknown` e inelegíveis para atualização automática. As capabilities em `references/host-capabilities.json` são estado declarado inicial; só evidência posterior observada e persistida pelo controlador pode elevá-las.

## Sincronização e limites de prova

Adapters, importer, executor estático e fonte geradora do snapshot permanecem canônicos. A integração final copia a fonte canônica, registra hooks, gera o snapshot Cursor a partir do SHA final e sincroniza Claude. Não use runtime Claude ou Cursor como fonte e não deixe espelho stale após mudar o worker. A existência do código, um teste sintético ou capability declarada não comprova trust, instalação, agenda observada nem smoke nativo.

O scanner de segredos reconhece formatos conhecidos e reduz exposição acidental, mas não comprova ausência universal de segredos. A validação do commit revisado usa ambiente reduzido, porém não constitui sandbox de rede ou do sistema operacional. Essas limitações exigem revisão do diff, roots fixos e probes nativos antes da ativação.

## Observabilidade local

O1, O3, O4 e O5 não se aplicam como produto nesta etapa: o equivalente local são estados sanitizados, erros sanitizados, eventos de nomes fixos e diagnóstico da CLI. O2 e O6 ficam para verificação de integração. Fork com origem incerta permanece `pending`.
