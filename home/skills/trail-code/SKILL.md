---
name: trail-code
description: Mantém e consulta o mapa estrutural local Trail-Code de repositórios Git. Use ao explorar código, localizar relações e chamadores, avaliar impacto de mudanças ou verificar o frescor do mapa.
---

# Trail-Code

Use somente `scripts/trail-code.mjs`. Ele fixa o cache local em `graft/`, desativa telemetria e impede comandos de learnings, cloud, MCP e `--deep`. Nunca execute `trail init`, `trail note`, `trail check` ou `trail mcp` diretamente.

1. Passe sempre a raiz Git absoluta em `--repo`. A API rejeita a home, raiz de drive e cache `graft/` que seja link.
2. No início de trabalho com escrita autorizada, execute `node ~/.agents/skills/trail-code/scripts/trail-code.mjs ensure --repo <raiz>`. Em revisão somente leitura, use `check`.
3. Consulte com `node ~/.agents/skills/trail-code/scripts/trail-code.mjs query --repo <raiz> <ask|grep|skeleton|callers|map|blast> [argumentos]`. Coloque perguntas com várias palavras entre aspas, por exemplo `ask "quem chama save?"`. A consulta não reconstrói nem altera o mapa do projeto: só roda quando ele já está fresco; se necessário, execute `ensure` antes em escopo com escrita autorizada.
4. Depois de edição por ferramenta estruturada, o hook executa `ensure`. Comandos shell recebem apenas `check`, porque o hook não interpreta texto de comando. Após shell que altere, renomeie, exclua arquivos ou troque branch, execute `ensure` explicitamente.
5. Antes de concluir uma entrega, execute `ensure` e depois `verify`. O `check` cotidiano usa o fingerprint leve do Trail 0.23.0; `verify` roda a checagem profunda do grafo e aceita somente a ausência esperada de contexto no modo mapa. Falha, timeout ou lock não comprovam frescor.
6. Para um mapa local offline, use `node ~/.agents/skills/trail-code/scripts/trail-code.mjs export --repo <raiz> --out <arquivo.html> --theme <arquivo.json> [--ref origin/dev]`. O mapa precisa estar fresco antes da exportação e é confirmado depois. A saída pode ser um caminho explícito fora da worktree quando seu diretório já existe e não contém links. Ela é HTML autocontido para `file://` e mostra nome, ref, SHA, data e origem dos tokens. `--ref` só é aceito quando resolve para o `HEAD` atual.

O tema é JSON estrito: `name` e `source` são textos. A origem precisa ser arquivo regular relativo ao repositório, sem links. `colors` contém hexadecimais literais para `background`, `foreground`, `accent`, `muted`, `border`, `panel`, `panel2` e `canvas`, e `radius` é um número de 0 a 32. `fonts.sans` e `fonts.mono` são opcionais e só aceitam arquivos `.woff2` ou `.ttf` válidos de até 10 MB, relativos ao repositório e sem links simbólicos. Campos adicionais, CSS, HTML e JavaScript arbitrários são rejeitados. O viewer usa Visão geral, Código e Arquivos, fixa o tema claro e permite zoom até 3%. Código agrega o grafo por arquivo; selecionar um arquivo abre os símbolos e relações, enquanto Arquivos mantém o grafo integral navegável. A exportação exige árvore fonte limpa.

O HTML remove transições declarativas quando o sistema pede movimento reduzido. A simulação de layout para quando a aba Arquivos oculta o canvas.

O wrapper usa Trail-Code 0.23.0 com `DO_NOT_TRACK=1` e `CI=1`, faz `check -> build -> check` e registra `/graft/` somente no exclude local do Git. A CLI fixa ainda pode consultar metadados públicos de versão no npm uma vez ao dia e gravar `~/.graft/update-check.json`; a versão 0.23.0 não oferece opt-out suportado para esse upkeep e o wrapper não faz atualização automática. Diretórios ocultos não entram no mapa. Não consulte nem reproduza segredos encontrados no código.
