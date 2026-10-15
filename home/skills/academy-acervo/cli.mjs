import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureDraft, curate, defaultRoot } from './archive.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseJson(content) {
  try { return JSON.parse(content); } catch { throw new Error('invalid JSON input'); }
}

async function input() {
  const file = option('--input');
  if (file) return parseJson(await readFile(resolve(file), 'utf8'));
  let content = '';
  for await (const chunk of process.stdin) content += chunk;
  return parseJson(content);
}

const command = process.argv[2];
const root = resolve(option('--root') ?? process.env.ACADEMY_ACERVO_ROOT ?? defaultRoot());
const activationCutoff = option('--activation-cutoff') ?? process.env.ACADEMY_ACERVO_ACTIVATION_CUTOFF;
try {
  const payload = await input();
  const result = command === 'capture' ? await captureDraft(root, payload, { activationCutoff }) : command === 'curate' ? await curate(root, payload) : (() => { throw new Error('usage: cli.mjs capture|curate [--input file] [--root trusted-root]'); })();
  process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`academy-acervo: ${error.message}\n`);
  process.exitCode = 1;
}
