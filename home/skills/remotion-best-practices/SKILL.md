---
name: remotion-best-practices
description: Guia de melhores práticas para Remotion. Use ao criar ou editar composições, configurar renderização, ou gerar vídeos (anúncios de marketing, social, etc.) programaticamente em React. Trigger: /remotion
---

# Remotion Best Practices

## Contexto

Remotion gera vídeos programaticamente em React. Caso comum: anúncios sociais 9:16
(saída `.mp4` para upload em Instagram/TikTok/LinkedIn), ex.: 1080×1920, 30fps.
Quando o projeto tem um app/pacote dedicado a Remotion, ele costuma reusar o design
system do frontend.

## Design tokens compartilhados

Nunca duplicar valores de cor. Se o projeto tem design system/tokens, a config do Remotion
deve reusá-los, não redefini-los:

- Tailwind: usar o mesmo `preset` compartilhado de tokens em `tailwind.config.ts`
- CSS: `@import` do arquivo de CSS vars do projeto no `style.css` do Remotion

Se o tema dark é o default dos tokens (`:root, [data-theme="dark"]`), o vídeo renderiza dark
sem classe de tema. As classes Tailwind (`bg-surface-1`, `text-accent`, etc.) ficam iguais às
do frontend.

## Fontes

Carregar via `@remotion/google-fonts` e aplicar `fontFamily` inline (tokens normalmente não
expõem var de fonte):

```ts
import { loadFont as loadDisplay } from '@remotion/google-fonts/Fraunces';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
const { fontFamily: display } = loadDisplay();
```

## Timing e animações

- `useCurrentFrame()` para timing baseado em frame, nunca `Date.now()`
- `interpolate()` com `extrapolateLeft/Right: 'clamp'` para transições
- `spring()` para entradas com física natural
- `Sequence` para cenas com offset. Centralizar durações numa fonte única (ex.: `src/theme/timing.ts`)

```tsx
import { useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';

const MyAnimation = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scale = spring({ frame, fps, config: { damping: 10 } });
  return <div style={{ opacity, transform: `scale(${scale})` }} />;
};
```

## Assets e fontes

- Imagens: use `<Img>` do Remotion (não `<img>`) para o frame esperar o carregamento
- Vídeos embutidos: `<Video>` do Remotion com `src={staticFile('video.mp4')}`
- Assets externos (API/DB): pré-busque com `delayRender()` / `continueRender()`

## Renderização

```bash
npx remotion studio          # preview (remotion studio)
npx remotion render <id>     # render da composição -> out/<arquivo>.mp4
npx remotion still <id>      # thumbnail de um frame
```

Use o script de render do projeto se houver (ex.: `pnpm --filter <pkg> render`). A saída
costuma ir para `out/` (gitignored). O primeiro render baixa o Chrome Headless Shell.

## Performance

- Componentes re-renderizam por frame: memoize componentes pesados
- Imports pesados (D3, Three.js) devem ser justificados (custo de bundle)

## Testes

Teste smoke co-localizado valida a metadata da composição (id, fps, dimensões,
durationInFrames). Compositions visuais não recebem unit test pesado.
