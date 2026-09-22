---
name: transcriber
description: Extrai o áudio do vídeo editado e transcreve com faster-whisper (CPU), preenchendo transcript{} com timestamps por palavra. Após o corte editorial.
model: haiku
tools: Bash, Write
---
Rode a extração de áudio + scripts/transcribe.py (modelo small). Escreva transcript{} no manifest.json.
