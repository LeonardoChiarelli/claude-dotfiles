# Política do Setup Learning

O staging aceita somente candidatos já registrados, uma worktree Git real, um commit verificável e arquivos regulares declarados. O manifesto registra hashes SHA-256 antes e depois, base, diff e commit. Metadados declarados não substituem a leitura do diff real.

O fluxo automático permite criar ou atualizar skills não sensíveis, criar a área gerenciada `setup-learning:preferences` em `home/AGENTS.md` e instalar somente templates JSON fechados de `advisory-reminder` em `home/hooks/setup-learning-generated/`. Na primeira alteração de AGENTS, somente o bloco gerenciado pode ser acrescentado. Nas alterações posteriores, apenas seu conteúdo interno pode mudar: prefixo, sufixo e o único par de marcadores permanecem byte a byte. O lembrete é texto estático curto no `sessionStart`, sem interpolação, comando, rede, bloqueio ou campo adicional. Qualquer outra alteração fica `pending`.

Essa allowlist é global. Candidato derivado de um único repositório pode ser registrado e entregue para qualificação, mas não pode ser staged nem aplicado nessas roots sem adapter dedicado ao projeto. O modelo não define nem eleva escopo.

Nunca entram na allowlist: o motor `setup-learning`, `entrega`, `sync-dotfiles`, `consult-claude`, `create-hook`, `create-skill`, `academy-acervo`, guardrails, instalação, promoção, segurança, testes obrigatórios ou configuração de runtime. MCP novo fica `pending-install`; uma atualização de MCP não ganha permissão por não adicionar poderes.

Um candidato qualificado orienta a abertura de uma entrega via `/entrega`, com Linear e revisão. A qualificação consulta descrições e conteúdo do catálogo, pois nome e path não demonstram equivalência semântica. Ela é autônoma para melhorias já autorizadas e não introduz confirmação humana por padrão. Isso não cria código, executa comando recebido de sugestão nem equivale a aprovação humana. Staging também não instala MCP, não ativa hook, não altera `config.toml`, arquivos `.env`, runtime Claude ou Cursor.
