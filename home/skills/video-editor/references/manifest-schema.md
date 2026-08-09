# Edit Manifest (`manifest.json`) — o contrato

Artefato central. O agente escreve; o render lê. Tudo downstream é determinístico a partir dele.

```jsonc
{
  "version": 1,
  "source": {
    "path": "footage/raw.mp4",      // imutável, nunca sobrescrito
    "duration": 124.5, "fps": 30, "width": 1920, "height": 1080,
    "hasAudio": true
  },
  "profiles": ["9x16", "16x9"],      // perfis de saída

  // EDITORIAL — ordem das fontes no timeline final (concat implícito)
  "timeline": [
    { "id": "c1", "source": "raw.mp4", "in": 3.2, "out": 41.0 },
    { "id": "c2", "source": "raw.mp4", "in": 58.0, "out": 90.5 }
  ],

  // TRANSCRICAO — tempo já no domínio do timeline final (pós-corte)
  "transcript": {
    "engine": "faster-whisper", "model": "small", "lang": "pt",
    "words": [ { "t": 0.0, "d": 0.32, "w": "Receita" } ]
  },

  // LEGENDAS — viram ASS/libass por perfil
  "captions": {
    "style": "karaoke-pop",
    "maxCharsPerLine": 24, "maxLines": 2, "cps": 17,
    "safeZone": { "9x16": "center-low", "16x9": "bottom" }
  },

  // ANIMACOES CONTEXTUAIS — o miolo criativo
  "animations": [
    {
      "id": "a1", "t": 12.4, "d": 2.5,
      "anchor": { "wordIndex": 88 },     // ancorado à palavra "+40%"
      "kind": "catalog",                  // catalog | freegen
      "block": "number-pop",
      "params": { "value": "+40%", "label": "Receita", "accent": "#00E0A4" },
      "layout": { "9x16": "upper-third", "16x9": "right-third" },
      "render": { "alpha": true }
    },
    {
      "id": "a2", "t": 30.0, "d": 4.0, "kind": "freegen",
      "composition": "compositions/a2/index.html",
      "render": { "alpha": true }
    }
  ]
}
```

## Pontos de design

- **Tempo no domínio do timeline final** (pós-corte). O render não recalcula offsets.
- **`anchor.wordIndex`** liga a animação à palavra, sync preciso, sobrevive a re-timing.
- **`kind: catalog | freegen`** = híbrido: bloco do catálogo OU composição HTML livre.
- **`source.path` imutável** -- protegido por hook `guard-source-footage`.
- Validável por Zod -- hook `validate-manifest` valida antes do render.
- 1 manifest -> N perfis.

## Schema Zod (campos obrigatórios)

| Campo | Tipo | Descrição |
|---|---|---|
| `version` | `1` (literal) | Versão do schema |
| `source.path` | `string` | Path do footage (relativo ao projectDir) |
| `source.duration` | `number > 0` | Duração em segundos |
| `source.fps` | `number > 0` | FPS do footage original |
| `source.width` / `height` | `int > 0` | Resolução original |
| `source.hasAudio` | `boolean` | Se tem faixa de áudio |
| `profiles` | `Array<"9x16" \| "16x9">` | Perfis de saída (min 1) |
| `timeline` | `Array<Segment>` | Cortes em ordem (min 1) |
| `timeline[].id` | `string` | ID único do segmento |
| `timeline[].source` | `string` | Nome do arquivo de footage |
| `timeline[].in` | `number >= 0` | Ponto de entrada (seg) |
| `timeline[].out` | `number > in` | Ponto de saída (seg) |
| `transcript` | (opcional) | Saída do faster-whisper parseada |
| `captions` | (opcional) | Configuração de legenda |
| `animations` | `Array<Animation>` | Default `[]` |

### Validações cruzadas (superRefine)

- `animation.t + animation.d <= source.duration`
- `animation.kind === "catalog"` exige `animation.block`
- `animation.kind === "freegen"` exige `animation.composition`
- `segment.out > segment.in`

## Profiles e resolucoes

| Profile | Resolução | Uso |
|---|---|---|
| `"9x16"` | 1080 x 1920 | Reels, TikTok, Stories |
| `"16x9"` | 1920 x 1080 | YouTube, Desktop |

## Layout de pasta por projeto

```
my-video/
  footage/raw.mp4          # source, read-only (imutável, protegido por hook)
  manifest.json            # contrato (validado por hook antes de gravar)
  compositions/<id>/       # overlays free-gen (HyperFrames) -- M4+
  build/                   # intermediários: audio.wav, captions-9x16.ass, edited.mp4
  out/                     # saída final: final-9x16.mp4, final-16x9.mp4
```

## Como executar o render

```bash
# build do toolkit (uma vez, ou após mudanças)
cd C:/Users/Leonardo/video-editor-toolkit && npm run build

# render completo a partir do manifest
node C:/Users/Leonardo/video-editor-toolkit/dist/index.js /path/to/my-video
```

## Hooks de segurança

Vivem em `~/.claude/hooks/` (global). Precisam estar wired no `settings.json`.

| Hook | Dispara em | Faz |
|---|---|---|
| `guard-source-footage.mjs` | Write/Edit + Bash(ffmpeg) | Bloqueia escrita em `footage/` |
| `validate-manifest.mjs` | Write/Edit em `manifest.json` | Valida contra Zod schema |
| `ffmpeg-safety.mjs` | Bash(ffmpeg) | Exige output em `build/` ou `out/`; bloqueia in-place |

Bloco de wiring para `~/.claude/settings.json` (somente após confirmação do usuário):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [
        { "type": "command", "command": "node ~/.claude/hooks/guard-source-footage.mjs" },
        { "type": "command", "command": "node ~/.claude/hooks/validate-manifest.mjs" }
      ]},
      { "matcher": "Bash", "hooks": [
        { "type": "command", "command": "node ~/.claude/hooks/guard-source-footage.mjs" },
        { "type": "command", "command": "node ~/.claude/hooks/ffmpeg-safety.mjs" }
      ]}
    ]
  }
}
```
