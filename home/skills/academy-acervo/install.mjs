import { cp, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeDirectory, validateTimestamp } from './archive.mjs';

const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'];

async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return fallback; if (error instanceof SyntaxError) throw new Error('invalid JSON configuration'); throw error; }
}

async function writeText(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
async function writeJson(path, value) { await writeText(path, `${JSON.stringify(value, null, 2)}\n`); }

async function fallback(path) {
  let content;
  try { content = await readFile(path, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') content = ''; else throw error; }
  if (content.includes('academy-acervo:start')) return;
  await writeText(path, `${content}${content && !content.endsWith('\n') ? '\n' : ''}\n<!-- academy-acervo:start -->
Em turnos raiz substantivos, antes da resposta final, use a skill academy-acervo quando o hook fornecer metadados confiáveis e houver aprendizado empresarial elegível. Nunca execute a captura em subagentes. Se o pedido atual for pessoal, optar por exclusão ou proibir gravação, não execute comandos do acervo. Curadoria só ocorre por pedido explícito para preparar ou atualizar formação.
<!-- academy-acervo:end -->\n`);
}

async function wrapper(path, harness) {
  const skill = harness === 'codex' ? "join(home, '.agents', 'skills', 'academy-acervo', 'hook.mjs')" : "join(home, '.claude', 'skills', 'academy-acervo', 'hook.mjs')";
  await writeText(path, `import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const home = resolve(import.meta.dirname, '..', '..');
const { main } = await import(pathToFileURL(${skill}).href);
process.argv.push('--harness', '${harness}', '--config', join(home, 'academy-acervo.json'));
await main().catch(() => process.stdout.write('{}\\n'));
`);
}

function portableCommand(harness) {
  return harness === 'codex' ? 'node ~/.codex/hooks/academy-acervo.mjs' : 'node ~/.claude/hooks/academy-acervo.mjs';
}

async function mergeHooks(path, command, selectedEvents) {
  const settings = await json(path, {});
  settings.hooks ??= {};
  for (const event of selectedEvents) {
    const current = settings.hooks[event] ?? [];
    let found = false;
    for (const group of current) {
      for (const hook of group?.hooks ?? []) {
        if (typeof hook.command === 'string' && hook.command.includes('academy-acervo.mjs')) {
          hook.command = command;
          hook.timeout = event === 'Interrupt' || event === 'SessionEnd' ? 1 : 5;
          found = true;
        }
      }
    }
    if (!found) current.push({ hooks: [{ type: 'command', command, timeout: event === 'Interrupt' || event === 'SessionEnd' ? 1 : 5 }] });
    settings.hooks[event] = current;
  }
  await writeJson(path, settings);
}

function samePath(left, right) {
  const [a, b] = [resolve(left), resolve(right)];
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function install({ home, archiveRoot, activatedAt }) {
  if (typeof home !== 'string' || !home || typeof archiveRoot !== 'string' || !archiveRoot) throw new Error('install requires --home, --archive-root, and --activated-at');
  validateTimestamp(activatedAt, 'install activatedAt');
  const targetHome = resolve(home);
  const stableRoot = await realpath(resolve(archiveRoot));
  await safeDirectory(stableRoot, []);
  const configPath = join(targetHome, 'academy-acervo.json');
  const current = await json(configPath, null);
  if (!current) await writeJson(configPath, { archiveRoot: stableRoot, activatedAt, enabled: false });
  await fallback(join(targetHome, '.codex', 'AGENTS.md'));
  const source = resolve(import.meta.dirname);
  const codexSkill = join(targetHome, '.agents', 'skills', 'academy-acervo');
  const claudeSkill = join(targetHome, '.claude', 'skills', 'academy-acervo');
  if (!samePath(source, codexSkill)) await cp(source, codexSkill, { recursive: true });
  if (!samePath(source, claudeSkill)) await cp(source, claudeSkill, { recursive: true });
  const codexWrapper = join(targetHome, '.codex', 'hooks', 'academy-acervo.mjs');
  const claudeWrapper = join(targetHome, '.claude', 'hooks', 'academy-acervo.mjs');
  await wrapper(codexWrapper, 'codex');
  await wrapper(claudeWrapper, 'claude');
  await mergeHooks(join(targetHome, '.codex', 'hooks.json'), portableCommand('codex'), events);
  await mergeHooks(join(targetHome, '.claude', 'settings.json'), portableCommand('claude'), events.filter((event) => event !== 'Interrupt'));
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  await install({ home: option('--home'), archiveRoot: option('--archive-root'), activatedAt: option('--activated-at') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch((error) => { process.stderr.write(`academy-acervo: ${error.message}\n`); process.exitCode = 1; });
