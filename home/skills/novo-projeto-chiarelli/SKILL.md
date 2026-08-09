---
name: novo-projeto-chiarelli
description: Scaffold de projeto novo de cliente do Chiarelli Labs (desktop-python, automacao, agente-ia ou web-app) com padrões da casa e provisionamento (telemetria, GitHub, Vercel+Neon). Use quando o founder pedir "projeto novo da empresa", "scaffold de cliente" ou /novo-projeto-chiarelli.
---

# Novo projeto Chiarelli Labs

## Configuração (paths desta máquina)

- SITE: `C:\Users\Leonardo\Documents\Code\Chiarelli-Labs`
- PROJETOS: `C:\Users\Leonardo\Documents\Code`
- TEMPLATES: `https://github.com/chiarelli-dev/project-templates` (clone local em `PROJETOS\project-templates`; se não existir, clonar; se existir, `git pull` antes de usar)

## Fluxo

### 1. Wizard (coletar antes de qualquer ação)

Perguntar (AskUserQuestion quando disponível):

1. Nome do cliente (livre)
2. Tipo: `desktop-python` | `automacao` | `agente-ia` | `web-app`
3. Slug da ferramenta (validar `^[a-z][a-z0-9_-]{1,49}$`)
4. Nome do projeto (kebab-case; vira nome do repo e da pasta)
5. Email de contato do cliente
6. Valor do contrato em centavos (opcional)

### 2. Resumo + confirmação única

Mostrar TUDO que será criado antes de qualquer efeito externo:

- Pasta `PROJETOS\<projeto>`
- Repo `chiarelli-dev/<projeto>` (privado, branches dev/staging/main, default dev)
- Registro de cliente no DB de produção (api_key de telemetria)
- Se web-app: projeto Vercel + DB Neon

Uma confirmação só. Sem confirmação, parar.

### 3. Montagem

```bash
cd PROJETOS/project-templates && git pull
python tools/scaffold.py --tipo <tipo> --dest "PROJETOS/<projeto>" \
  --cliente-nome "<cliente>" --ferramenta-slug <slug> --projeto-nome <projeto>
```

Exit 1 = parar e mostrar o erro. Nunca prosseguir com montagem incompleta.

### 4. Provisionamento (ordem fixa, cada passo com pré-checagem)

Idempotente por checagem: se um passo já foi feito (re-run após falha),
pular e seguir. Sem rollback automático.

**4a. Git + GitHub** (pular se `gh repo view chiarelli-dev/<projeto>` já existe: avisar e seguir pro 4b)

```bash
cd "PROJETOS/<projeto>"
git init -b main && git add -A && git commit -m "chore: scaffold from project-templates"
gh repo create chiarelli-dev/<projeto> --private --source . --push
git branch staging && git branch dev
git push origin staging dev
gh repo edit chiarelli-dev/<projeto> --default-branch dev
git checkout dev
git config core.hooksPath .githooks
```

**4b. Api_key de telemetria** (antes, checar duplicidade: perguntar ao founder se ele já criou cliente com esse slug; em dúvida, conferir no painel admin. Slug já registrado: perguntar antes de criar registro novo)

Pré-checagem: `SITE/.env.local` existe e contém `DATABASE_URL` e
`ENCRYPTION_KEY`. Faltando: parar e instruir o founder a preencher.

```bash
cd SITE
npm run db:seed-client -- --nome "<cliente>" --ferramenta "<slug>" \
  --email "<email>" [--valor-cents <valor>]
```

Capturar do output `CHIARELLI_API_KEY` e `CHIARELLI_API_SECRET` e gravar
IMEDIATAMENTE em `PROJETOS/<projeto>/.env.local` (arquivo gitignored).
Esses valores aparecem UMA vez; perda exige novo seed. NUNCA gravar em
arquivo versionado, NUNCA ecoar em log persistente.

**4c. Vercel + Neon** (só web-app; pular pros demais)

```bash
cd "PROJETOS/<projeto>"
vercel link --yes --project <projeto>
vercel git connect
```

Neon: criar projeto/DB via MCP do Neon (ou `neonctl projects create --name <projeto>`).
Setar env vars na Vercel (production + preview): `DATABASE_URL` (do Neon),
`CHIARELLI_API_KEY`, `CHIARELLI_API_SECRET`, `NEXT_PUBLIC_BASE_URL`.
Adicionar `DATABASE_URL` também no `.env.local` local.

### 5. Receipt final

Reportar em bloco único:

- Pasta, repo (URL), branches criadas, default
- Cliente registrado (identificador público do output do seed)
- Secrets: avisar que estão em `.env.local` e mostrar UMA vez pro founder
  guardar no gerenciador de senhas
- Vercel/Neon: URLs, se aplicável
- Provenance: `templateSha` gravado em `.chiarelli/template.json`
- Passos manuais restantes, se algum passo falhou (e que re-rodar a
  skill continua do faltante)

## Regras

- Confirmação única ANTES de qualquer efeito externo; depois dela, não
  pedir confirmação por passo.
- Falha num passo: registrar no receipt, seguir pros passos independentes,
  nunca desfazer o que já foi criado.
- Sync de projeto existente: NÃO implementado. Pedido de sync: apontar
  `docs/sync-plan.md` do repo de templates.
