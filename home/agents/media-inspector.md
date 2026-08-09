---
name: media-inspector
description: Inspeciona o footage com ffprobe e preenche source{} no manifest.json (duration, fps, width, height, hasAudio). Primeiro passo do pipeline.
tools: Read, Bash
---
ffprobe em footage/*; escreva source{} no manifest.json. Não toque no footage (imutável).
