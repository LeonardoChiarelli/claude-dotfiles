---
name: video-editor
description: Editar vídeos (cortar, transcrever, legendar, animar) via manifest determinístico. Trigger quando o usuário quer editar footage, gerar legendas karaokê, adicionar animações contextuais ou montar um vídeo a partir de um manifest.json.
---

# Video Editor

Production loop determinístico: footage -> manifest -> corte -> transcrição -> legenda -> animações -> MP4.

## Fluxo
1. Rodar `media-inspector` (ffprobe) -> preencher `source{}` no manifest.json.
2. Rodar `transcriber` -> `transcript{}`.
3. **Direção criativa de estilo novo (obrigatório quando aplicável):** se o vídeo pede um estilo de motion design sem precedente no catálogo ou em composição já aprovada, rodar `superpowers:brainstorming` com o founder ANTES do `director` fechar `animations[]`. Alinhar referência visual, paleta/tipografia (`src/styles/tokens.css`) e esforço por clipe. Reaproveitar estilo já aprovado não precisa repetir o brainstorm.
4. `director` decide `timeline[]`, `captions{}` e `animations[]`.
5. `motion-designer` (quando houver cue `kind:"freegen"`) escreve a composição HyperFrames.
6. **Gate de mockup (obrigatório, não pular):** antes do render completo, exportar preview (screenshot do frame-chave ou clipe curto) de 2-3 trechos representativos com a animação aplicada e apresentar na tela pro founder decidir. Só seguir pro `compositor` após aprovação explícita.
7. `compositor` executa: `node dist/index.js <projectDir>` (ou os run-*.ts).
8. `qa-reviewer` valida a saída. Em FAIL -> volta ao `director`.

**Por que o gate de mockup não é opcional:** um estilo `freegen` sofisticado (tipografia cinética em path curvo, reveal whiteboard) é composição autoral repetida em N clipes. Erro de execução no mockup = erro replicado no vídeo inteiro. Aprovar a referência (perfil de terceiro) não é o mesmo que aprovar a execução com nossa marca.

| Desculpa pra pular o mockup | Realidade |
|---|---|
| "Resto do vídeo é só repetir o padrão" | O padrão é exatamente o que precisa validação antes de escalar. |
| "Founder já aprovou a referência/estilo em geral" | Aprovar referência ≠ aprovar execução com nossa paleta/tipografia. |
| "Render final é rápido, ajusto depois se precisar" | Ajuste pós-render = re-render de tudo. Mockup é mais barato que retrabalho. |

## Nível de motion design (barra de qualidade)

Referência de mercado (perfis com edição autoral: tipografia cinética seguindo path curvo,
reveal desenhado à mão / whiteboard-style com traço e tachado animado, palavra-chave em
destaque com cor de marca) define o NÍVEL de execução técnica a perseguir, não o visual.
Composição `freegen` sofisticada é trabalho de design novo por clipe, não template
reaproveitado.

Usar SEMPRE a identidade do Chiarelli Labs (`src/styles/tokens.css`: `--color-accent`,
`--color-bg`, `--color-dark-bg`, tipografia do design system). Nunca portar paleta, fonte
ou assets do perfil de referência de terceiros.

## Animações

O campo `animations[]` do manifest suporta dois modos:

### kind: "catalog"
Usa um dos 4 blocos curados do catálogo. O `director` escolhe o bloco pelo nome e passa `params`.

| Bloco | Params obrigatórios | Uso típico |
|---|---|---|
| `number-pop` | `value`, `label`, `accent` | Destaque de métrica numérica (ex: "+40% Receita") |
| `lower-third` | `title`, `subtitle` | Identificação de pessoa/cargo |
| `keyword-highlight` | `word`, `accent` | Palavra-chave em destaque |
| `bullet-list` | `items`, `accent` | Lista de tópicos |

Exemplo de entrada no manifest:
```json
{ "id": "a1", "t": 1.0, "d": 1.0, "kind": "catalog", "block": "number-pop",
  "params": { "value": "+40%", "label": "Receita", "accent": "#00E0A4" },
  "layout": { "16x9": "center", "9x16": "center" }, "render": { "alpha": true } }
```

### kind: "freegen"
Para cues sem equivalente no catálogo, o `director` marca `kind:"freegen"` e o `motion-designer` cria a composição HyperFrames em `compositions/<id>/index.html`. Requer `composition` apontando para o diretório.

### Ancoragem por wordIndex
O `director` DEVE ancorar cada cue à palavra-chave do transcript via `anchor.wordIndex` para garantir sincronia com o corte. O tempo `t` deve estar no domínio do timeline final (pós-corte).

### Render alpha + composição
Cada animação vira um clipe transparente (.webm vp9 ou .mov prores 4444) renderizado pelo HyperFrames. O FFmpeg compõe via `overlay` com `enable='between(t,start,end)'`. Ver `docs/hyperframes-cli.md` para o comando exato.

## Regras
- footage/ é imutável (hook bloqueia escrita).
- Toda saída em build/ (intermediários) ou out/ (final).
- manifest.json valida contra o schema Zod (hook bloqueia inválido).
- Render é determinístico: fps fixo, crf fixo, clipes alpha por animação compartilhados entre perfis.

## Perfis de saída
- `16x9`: 1920x1080 (horizontal)
- `9x16`: 1080x1920 (vertical)

O campo `layout` de cada animação especifica o token de posicionamento por perfil. Clipes alpha são full-frame; o posicionamento visual vive no CSS do bloco.

Ver `references/manifest-schema.md` para o schema completo e `docs/hyperframes-cli.md` para o spike da CLI.
