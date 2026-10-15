import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './host.mjs';
import { safeDirectory } from './archive.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function key(value) { return createHash('sha256').update(value).digest('hex'); }
function subagent(event) { return event.agent_id || event.subagent_id; }

async function pendingStates(config, harness, event) {
  if (typeof event.session_id !== 'string' || !ID.test(event.session_id)) throw new Error('hook event lacks stable session metadata');
  const folder = await safeDirectory(config.archiveRoot, ['acervo', 'rascunhos', '.academy-acervo-hooks']);
  if (harness === 'codex') {
    if (typeof event.turn_id !== 'string' || !ID.test(event.turn_id)) return [];
    const path = join(folder, key(`${harness}\0${event.session_id}\0${event.turn_id}`));
    try { return [{ path, value: JSON.parse(await readFile(`${path}.pending`, 'utf8')) }]; } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  }
  const states = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.pending')) continue;
    const path = join(folder, entry.name.slice(0, -'.pending'.length));
    const value = JSON.parse(await readFile(`${path}.pending`, 'utf8'));
    if (value.harness === harness && value.session === event.session_id && value.pending === true) states.push({ path, value });
  }
  return states;
}

async function markContinued(config, harness, event) {
  for (const current of await pendingStates(config, harness, event)) {
    try {
      const handle = await open(`${current.path}.continued`, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ harness, session: current.value.session, checkpoint: current.value.checkpoint, continued: true }), 'utf8'); } finally { await handle.close(); }
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return false;
}

function context(harness, config, event, configPath, hostPath) {
  const checkpoint = harness === 'codex' ? event.turn_id : `prompt-${randomUUID()}`;
  if (typeof event.session_id !== 'string' || !ID.test(event.session_id) || typeof checkpoint !== 'string' || !ID.test(checkpoint)) return 'Academy Acervo está habilitado. Aguarde metadados confiáveis de UserPromptSubmit antes de registrar.';
  const metadata = { harness, session: event.session_id, checkpoint, activatedAt: config.activatedAt, configPath, hostPath };
  return `Academy Acervo: antes de finalizar este turno raiz substantivo, use a skill academy-acervo quando houver aprendizado empresarial elegível. Se o pedido atual for pessoal, optar por exclusão ou proibir gravação, não execute nenhum comando do acervo. Metadados confiáveis do host: <ACADEMY_ACERVO>${JSON.stringify(metadata)}</ACADEMY_ACERVO>. Nunca leia prompt, transcrição ou mensagem final para reconstruir origem.`;
}

export async function runHook({ harness, config, event, configPath = 'academy-acervo.json', hostPath = 'host.mjs' }) {
  if (!config?.enabled || !event || typeof event !== 'object' || subagent(event)) return {};
  if (!['codex', 'claude'].includes(harness)) return {};
  if (event.hook_event_name === 'SessionStart') {
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Academy Acervo está habilitado. Use somente os metadados confiáveis fornecidos em UserPromptSubmit e nunca capture em subagentes.' } };
  }
  if (event.hook_event_name === 'UserPromptSubmit') {
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context(harness, config, event, configPath, hostPath) } };
  }
  if (event.hook_event_name === 'Stop') {
    if (event.stop_hook_active) return {};
    try {
      if (await markContinued(config, harness, event)) return { decision: 'block', reason: 'Conclua o checkpoint pendente do Academy Acervo pela skill, sem incluir prompt, transcrição, mensagem final ou dados sensíveis; depois encerre.' };
    } catch { /* Falha aberta: não alegar pendência que não pôde ser confirmada. */ }
  }
  return {};
}

export async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const configPath = resolve(option('--config'));
  const config = await loadConfig(configPath);
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const result = await runHook({ harness: option('--harness'), config, event: JSON.parse(input), configPath, hostPath: fileURLToPath(new URL('host.mjs', import.meta.url)) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => process.stdout.write('{}\n'));
