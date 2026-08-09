---
name: video-editor-toolkit
description: "Toolkit Claude Code pra editar vídeos (corte+transcrição+legenda+animação) inspirado no repo hyperframes; spec+plano1 escritos, não implementado"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9cca7db9-696a-40c2-b044-c9659c49ef54
---

Objetivo: editar vídeos com Claude Code. Arquitetura híbrida: FFmpeg = timeline mestre, HyperFrames (heygen-com/hyperframes) = só overlays alpha de animação, legenda via ASS/libass karaokê. Contrato central = `manifest.json` (Zod). Agente decide, compositor obedece determinístico.

Restrições: Windows, sem GPU → faster-whisper CPU int8 (modelo small). Footage imutável (hook guard). Saída multi-perfil 9x16 + 16x9.

6 agents: media-inspector, transcriber, director (cérebro), motion-designer, compositor, qa-reviewer. Hooks universais em ~/.claude: guard-source-footage, validate-manifest, ffmpeg-safety, auto-ffprobe, lint-hyperframes, caption-readability. Hooks NÃO ativam até wire em settings.json (confirmar antes, igual [[engineering-pipeline-skills]] git-guardrails).

Spec: docs/superpowers/specs/2026-06-15-video-editor-toolkit-design.md
Plano 1 (M0-M3 núcleo determinístico): docs/superpowers/plans/2026-06-15-video-editor-toolkit-part1-core.md
Plano 2 (M4-M6 animações+agents+perfis): docs/superpowers/plans/2026-06-15-video-editor-toolkit-part2-animation.md
Repo alvo: C:/Users/Leonardo/video-editor-toolkit (ainda não criado).

Plano 2 Task 1 = SPIKE obrigatório: confirmar CLI/flags de render alpha e formato de composição do hyperframes antes de codar (minha memória da CLI é incerta). Plano 2 depende do Plano 1 verde.

Status em 2026-06-15: IMPLEMENTADO via workflow ultracode (Sonnet impl + Opus review, 66 agents). Repo C:/Users/Leonardo/video-editor-toolkit existe, ~34 commits, 54 tests pass / 2 skip. E2E 16x9 VERIFICADO de verdade (corte+legenda ASS+overlay alpha hyperframes+mux → out/final-16x9.mp4).

ffmpeg instalado via winget (Gyan.FFmpeg) em C:/Users/Leonardo/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_*/ffmpeg-8.1.1-full_build/bin — NÃO está no PATH de sessões bash; precisa export PATH ou reiniciar shell. hyperframes 0.6.99 via npx (baixa Chromium na 1ª vez). Sem GPU.

Bugs reais achados na validação E2E (workflow não pegou pois nenhum render rodou nele, testes skipados sem ffmpeg) e CORRIGIDOS por mim:
1. npx: execFileSync("npx") quebra no Windows (npx.cmd, EINVAL no Node 22) -> trocado por execSync com shell em render-alpha.ts + lint-hyperframes.mjs.
2. blocos do catálogo estavam no formato errado (data-hf-* do plano original) apesar do spike ter documentado o certo -> reescritos com data-composition-id/data-start/data-duration/class=clip/window.__timelines GSAP.
3. build não copiava blocks/*.html pro dist/ -> add script copy:assets.

3 gaps FECHADOS em 2026-06-15 (2º workflow ultracode, 8 agents, Opus revisou rodando ffmpeg/ffprobe/testes de verdade):
- A) overlay 9x16: blocos parametrizados {{WIDTH}}/{{HEIGHT}}, renderAlphaClip(a,projectDir,fps,profile) gera clip por-perfil; index.ts renderiza dentro do loop de perfis. Verificado: final-9x16.mp4=1080x1920 e final-16x9.mp4=1920x1080, ambos com overlay+legenda. (commit 990dedf)
- B) transcrição: transcribe.py ganhou param de language; teste de integração com fixture de fala real (tests/fixtures/speech16.wav via Windows SAPI), modelo small/en -> words reais (revenue/grew/40/percent/quarter). (commit 0fcd32d)
- C) hooks PreToolUse BLOCK instalados em ~/.claude/hooks + wired em settings.json (user autorizou): guard-source-footage (Write|Edit+Bash), validate-manifest (Write|Edit), ffmpeg-safety (Bash). Merge preservou guard-edits/check-emdash. Fix de falso-positivo via invoker detection. Verificado 17+ casos BLOCK/ALLOW + no-op em trabalho normal. (commit aab5e5e)

Estado final: TODOS os 6 hooks de vídeo wired (3 PreToolUse BLOCK + 3 PostToolUse). Suíte 72 pass / 3 skip. E2E 9x16 E 16x9 verificados.

Restos cosméticos não-bloqueantes: comentário freegen enganoso em render-alpha.ts (diz passar --variables mas não passa) + cria dir por-perfil vazio no branch freegen; untracked leftovers (tests/fixtures/proj*, speech.wav); drift no runner guard entre cópias do ffmpeg-safety.mjs (lógica central idêntica). block-dangerous-git continua não-wired.
