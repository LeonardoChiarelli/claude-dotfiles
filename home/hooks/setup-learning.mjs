#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const maxInputBytes = 64 * 1024;

async function readInput() {
  const chunks = []; let bytes = 0; let oversized = false;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxInputBytes) { oversized = true; continue; }
    chunks.push(chunk);
  }
  return oversized ? null : Buffer.concat(chunks, bytes).toString('utf8');
}

async function main() {
  const raw = await readInput(); if (raw === null) return;
  const payload = JSON.parse(raw || '{}');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.agent_id || payload.subagent_id || (payload.hook_event_name === 'Stop' && payload.stop_hook_active !== false)) return;
  const home = resolve(import.meta.dirname, '..', '..');
  const configRoot = resolve(import.meta.dirname, '..'); const host = ({ '.codex': 'codex', '.claude': 'claude', '.cursor': 'cursor' })[basename(configRoot)] ?? 'codex';
  const skillRoot = host === 'cursor'
    ? join(configRoot, 'skills', 'setup-learning')
    : join(home, '.agents', 'skills', 'setup-learning');
  const hook = await realpath(join(skillRoot, 'hook.mjs')); const adapters = await realpath(join(skillRoot, 'adapters.mjs'));
  const [{ runHostHook }, { privateStateDir }] = await Promise.all([import(pathToFileURL(hook).href), import(pathToFileURL(adapters).href)]);
  const result = await runHostHook({ host, payload, home, stateDir: privateStateDir(), templateDir: join(configRoot, 'hooks', 'setup-learning-generated') });
  if (result.advisory?.status === 'ready') process.stdout.write(`${JSON.stringify(result.advisory.output)}\n`);
}

await main().catch(() => {});
