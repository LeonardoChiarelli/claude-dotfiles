---
name: nudge-project
description: "nudge — sistema local Windows de lembretes escalonados (Rust+Tauri); fase 1 implementada e commitada em 2026-07-26, faltam verificações manuais e fases 2-5"
metadata: 
  node_type: memory
  type: project
  originSessionId: 41172910-17cc-4da6-b989-d6e071cf44b3
  modified: 2026-07-26T21:54:41.984Z
---

`nudge` vive em `C:\Users\Leonardo\nudge` (git local, branch `main`, sem remote).

- Spec: `docs/superpowers/specs/2026-07-26-nudge-design.md` (5 fases)
- Plano fase 1: `docs/superpowers/plans/2026-07-26-nudge-fase-1.md` (13 tasks TDD)
- Fase 1 implementada no commit `6c67e68`: 66 testes, clippy `--all-targets` limpo.

Stack: Rust + Tauri v2, escolhido sobre Node/Electron por causa do custo de RAM rodando 24/7 numa máquina de dev.

Restrições que vieram do usuário e não são deriváveis do código:
- O teto de agressividade autorizado é overlay bloqueante + pausa de mídia + bloqueio de app (L4). Ele pediu isso explicitamente; não suavizar por conta própria.
- A falha varia por dia (esquece / vê-e-ignora / não mede), por isso escalonamento em vez de nível fixo.
- Possível produto no futuro, mas v1 é pessoal. Fora por decisão, não esquecimento: sync mobile, Google Calendar, cloud, gamificação.

Armadilhas descobertas na implementação, que valem para as próximas fases:
- `cargo clippy --workspace -- -D warnings` **não** linta targets de teste. Sempre usar `--all-targets`, senão lint quebrado na suíte passa no gate.
- A máquina não tinha toolchain Rust. Foram instalados via winget durante a fase 1: `Rustlang.Rustup` e `Microsoft.VisualStudio.Workload.VCTools` (Build Tools 2022, workload C++). `%USERPROFILE%\.cargo\bin` está no PATH de usuário no registro, mas **não** entra em sessão de shell já aberta: prefixar `$env:PATH` quando rodar cargo.

Antes de planejar a fase 2, rodar o sistema por pelo menos uma semana: ela decide o quanto o sistema pode agredir, e `nudge_event` acumulado é o que separa calibrar de chutar.

Relacionado: [[video-editor-toolkit]] (outro projeto pessoal, spec pronto e sem implementação).
