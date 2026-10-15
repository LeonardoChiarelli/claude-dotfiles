import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureDraft, curate, safeDirectory, validateTimestamp } from './archive.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseJson(content) {
  try { return JSON.parse(content); } catch { throw new Error('invalid JSON input'); }
}

export async function loadConfig(path) {
  if (typeof path !== 'string' || !path) throw new Error('academy-acervo config path is required');
  const value = parseJson(await readFile(resolve(path), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('academy-acervo config must be an object');
  if (Object.keys(value).some((key) => !['archiveRoot', 'activatedAt', 'enabled'].includes(key))) throw new Error('academy-acervo config has unsupported field');
  if (typeof value.archiveRoot !== 'string' || !value.archiveRoot) throw new Error('academy-acervo config requires archiveRoot');
  validateTimestamp(value.activatedAt, 'academy-acervo config activatedAt');
  if (typeof value.enabled !== 'boolean') throw new Error('academy-acervo config requires enabled');
  return { archiveRoot: resolve(value.archiveRoot), activatedAt: value.activatedAt, enabled: value.enabled };
}

export async function captureConfigured(config, record) {
  if (!config.enabled) return { status: 'skipped', reason: 'disabled' };
  const result = await captureDraft(config.archiveRoot, record, { activationCutoff: config.activatedAt });
  if (result.status === 'written' || result.status === 'duplicate') {
    const source = record.source;
    if (source?.harness && source?.session && source?.checkpoint) {
      const folder = await safeDirectory(config.archiveRoot, ['acervo', 'rascunhos', '.academy-acervo-hooks']);
      const id = createHash('sha256').update(`${source.harness}\0${source.session}\0${source.checkpoint}`).digest('hex');
      await unlink(join(folder, `${id}.pending`)).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
      await unlink(join(folder, `${id}.continued`)).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    }
  }
  return result;
}

export async function markPending(config, metadata) {
  if (!config.enabled) return { status: 'skipped', reason: 'disabled' };
  if (metadata?.optedOut === true) return { status: 'skipped', reason: 'opted-out' };
  if (metadata?.noWrite === true) return { status: 'skipped', reason: 'no-write' };
  if (metadata?.personal === true) return { status: 'skipped', reason: 'personal' };
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some((field) => !['harness', 'session', 'checkpoint'].includes(field))) throw new Error('pending metadata has unsupported field');
  for (const field of ['harness', 'session', 'checkpoint']) if (typeof metadata[field] !== 'string' || !ID.test(metadata[field])) throw new Error(`invalid ${field}`);
  const folder = await safeDirectory(config.archiveRoot, ['acervo', 'rascunhos', '.academy-acervo-hooks']);
  const id = createHash('sha256').update(`${metadata.harness}\0${metadata.session}\0${metadata.checkpoint}`).digest('hex');
  const path = join(folder, `${id}.pending`);
  const temporary = join(folder, `.${id}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ harness: metadata.harness, session: metadata.session, checkpoint: metadata.checkpoint, pending: true }), 'utf8'); } finally { await handle.close(); }
    await link(temporary, path);
    await unlink(temporary);
    return { status: 'pending' };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error?.code === 'EEXIST') return { status: 'duplicate' };
    throw new Error('destination unavailable');
  }
}

export async function curateConfigured(config, request) {
  return curate(config.archiveRoot, request);
}

async function payload(option) {
  let content = option ? await readFile(resolve(option), 'utf8') : '';
  if (!option) for await (const chunk of process.stdin) content += chunk;
  return parseJson(content);
}

export async function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  const config = await loadConfig(option('--config'));
  const input = await payload(option('--input'));
  const result = args[0] === 'pending' ? await markPending(config, input)
    : args[0] === 'capture' ? await captureConfigured(config, input)
      : args[0] === 'curate' ? await curateConfigured(config, input)
        : (() => { throw new Error('usage: host.mjs capture|pending|curate --config academy-acervo.json [--input file.json]'); })();
  process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { process.stderr.write(`academy-acervo: ${error.message}\n`); process.exitCode = 1; });
