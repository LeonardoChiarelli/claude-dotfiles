import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const home = resolve(import.meta.dirname, '..', '..');
const { main } = await import(pathToFileURL(join(home, '.claude', 'skills', 'academy-acervo', 'hook.mjs')).href);
process.argv.push('--harness', 'claude', '--config', join(home, 'academy-acervo.json'));
await main().catch(() => process.stdout.write('{}\n'));
