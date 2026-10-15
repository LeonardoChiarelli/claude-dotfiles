import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const CATEGORIES = new Set(['product', 'engineering', 'sales', 'marketing', 'management', 'operations']);
const RESULT_STATUSES = new Set(['observed', 'reported', 'hypothesis', 'pending']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT = 4_000;
const MAX_RECORD = 50_000;
const SENSITIVE = /(?:\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b|(?<![A-Za-z0-9_-])(?:\+?55\s*)?(?:\(\d{2}\)|\d{2})\s*9?\d{4}[-\s]?\d{4}(?![A-Za-z0-9_-])|\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b|\bsk-(?:proj|ant-api\d{2})-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[A-Z0-9]{16}\b|\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+)/i;

function fail(message) { throw new Error(message); }

function only(object, fields, name) {
  if (Object.keys(object).some((key) => !fields.has(key))) fail(`${name} contains unsupported field`);
}

function text(value, field, { optional = false, max = MAX_TEXT } = {}) {
  if (value === undefined && optional) return;
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${field} must be a non-empty string up to ${max} characters`);
  if (SENSITIVE.test(value)) fail(`${field} contains sensitive data`);
}

function identifier(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${field} must be a safe identifier`);
  if (SENSITIVE.test(value)) fail(`${field} contains sensitive data`);
}

export function validateTimestamp(value, field) {
  text(value, field, { max: 40 });
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) fail(`${field} must be an ISO timestamp with timezone`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) fail(`${field} must contain a valid calendar date`);
}

function list(value, field) {
  if (!Array.isArray(value) || value.length > 20) fail(`${field} must be a list with up to 20 items`);
  for (const item of value) text(item, field);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function validate(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('record must be an object');
  if (record.optedOut) return { skip: 'opted-out' };
  if (record.noWrite) return { skip: 'no-write' };
  if (record.personal) return { skip: 'personal' };
  only(record, new Set(['source', 'context', 'problem', 'decision', 'reason', 'alternatives', 'result', 'evidence', 'lesson', 'limits', 'category']), 'record');
  const source = record.source;
  if (!source || typeof source !== 'object') fail('source must be an object');
  only(source, new Set(['harness', 'session', 'checkpoint', 'activatedAt', 'occurredAt', 'product', 'project', 'operation', 'source']), 'source');
  identifier(source.harness, 'source.harness');
  identifier(source.session, 'source.session');
  identifier(source.checkpoint, 'source.checkpoint');
  validateTimestamp(source.activatedAt, 'source.activatedAt');
  validateTimestamp(source.occurredAt, 'source.occurredAt');
  if (Date.parse(source.occurredAt) < Date.parse(source.activatedAt)) fail('source.occurredAt must be on or after source.activatedAt');
  for (const field of ['product', 'project', 'operation']) text(source[field], `source.${field}`, { optional: true, max: 200 });
  if (!source.source || typeof source.source !== 'object' || !['location', 'commit', 'issue'].some((key) => typeof source.source[key] === 'string' && source.source[key])) {
    fail('source must include a local location, commit, or issue');
  }
  only(source.source, new Set(['location', 'commit', 'issue', 'unavailable']), 'source.source');
  if ('unavailable' in source.source && typeof source.source.unavailable !== 'boolean') fail('source.source.unavailable must be boolean');
  for (const [key, value] of Object.entries(source.source)) {
    if (key !== 'unavailable') text(value, `source.source.${key}`, { optional: true, max: 300 });
  }
  for (const field of ['context', 'problem', 'decision', 'reason', 'lesson', 'limits']) text(record[field], field);
  list(record.alternatives, 'alternatives');
  list(record.evidence, 'evidence');
  if (!record.result || typeof record.result !== 'object' || !RESULT_STATUSES.has(record.result.status)) fail('result.status is invalid');
  only(record.result, new Set(['status', 'summary']), 'result');
  text(record.result.summary, 'result.summary');
  if (!CATEGORIES.has(record.category)) fail('category is invalid');
  return { record: {
    source: {
      harness: source.harness, session: source.session, checkpoint: source.checkpoint, activatedAt: source.activatedAt, occurredAt: source.occurredAt,
      ...(source.product ? { product: source.product } : {}), ...(source.project ? { project: source.project } : {}), ...(source.operation ? { operation: source.operation } : {}),
      source: { ...(source.source.location ? { location: source.source.location } : {}), ...(source.source.commit ? { commit: source.source.commit } : {}), ...(source.source.issue ? { issue: source.source.issue } : {}), ...(source.source.unavailable ? { unavailable: true } : {}) },
    },
    context: record.context, problem: record.problem, decision: record.decision, reason: record.reason, alternatives: record.alternatives,
    result: { status: record.result.status, summary: record.result.summary }, evidence: record.evidence, lesson: record.lesson, limits: record.limits, category: record.category,
  } };
}

export async function safeDirectory(root, parts) {
  let current = resolve(root);
  for (;;) {
    let ancestor;
    try { ancestor = await lstat(current); } catch { fail('destination unavailable: root does not exist'); }
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) fail('destination unavailable: root is not a safe directory');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  current = resolve(root);
  let stat;
  for (const part of parts) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if (error?.code !== 'EEXIST') fail('destination unavailable'); }
    try { stat = await lstat(current); } catch { fail('destination unavailable'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('destination unavailable: symlink or junction rejected');
  }
  return current;
}

function draftKey(source) {
  return createHash('sha256').update(`${source.harness}\0${source.session}\0${source.checkpoint}`).digest('hex');
}

export async function captureDraft(root, input, options = {}) {
  const checked = validate(input);
  if (checked.skip) return { status: 'skipped', reason: checked.skip };
  validateTimestamp(options.activationCutoff, 'activationCutoff');
  if (Date.parse(checked.record.source.occurredAt) < Date.parse(options.activationCutoff)) fail('source.occurredAt precedes the trusted activationCutoff');
  const content = `${stable(checked.record)}\n`;
  if (content.length > MAX_RECORD) fail(`record must be at most ${MAX_RECORD} characters`);
  const key = draftKey(checked.record.source);
  const drafts = await safeDirectory(root, ['acervo', 'rascunhos']);
  const path = join(drafts, `${key}.json`);
  const temporary = join(drafts, `.${key}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
    await link(temporary, path);
    await unlink(temporary);
    return { status: 'written', path, key };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error?.code !== 'EEXIST') fail('destination unavailable');
    let existing;
    try { existing = await readFile(path, 'utf8'); } catch { fail('destination unavailable'); }
    if (existing === content) return { status: 'duplicate', path, key };
    fail(`conflict for existing checkpoint ${key}`);
  }
}

async function files(root, folder) {
  const directoryPath = join(root, 'acervo', folder);
  let entries;
  try {
    const stat = await lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('curation directory symlink or junction rejected');
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directoryPath, entry.name);
    if (entry.isFile() && entry.name.endsWith('.json')) result.push(path);
  }
  return result;
}

export async function curate(root, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('request must be an object');
  only(request, new Set(['objective']), 'request');
  if (typeof request.objective !== 'string' || !request.objective.trim() || request.objective.length > 500) fail('objective is required');
  if (SENSITIVE.test(request.objective)) fail('objective contains sensitive data');
  const safeRoot = resolve(root);
  await safeDirectory(safeRoot, ['acervo']);
  const words = request.objective.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const matches = [];
  for (const folder of ['casos', 'rascunhos']) {
    for (const path of await files(safeRoot, folder)) {
      const content = await readFile(path, 'utf8');
      if (content.length > MAX_RECORD || !words.some((word) => content.toLowerCase().includes(word))) continue;
      try {
        const record = JSON.parse(content);
        const checked = validate(record);
        if (!checked.skip) matches.push({ provenance: relative(safeRoot, path).replaceAll('\\', '/'), status: checked.record.result.status, gaps: [checked.record.limits], record: checked.record });
      } catch { /* Curadoria ignora arquivo não estruturado sem executá-lo. */ }
    }
  }
  const externalData = JSON.stringify({ objective: request.objective, matches }, null, 2).replaceAll('<', '\\u003c');
  return `<DADOS_EXTERNOS>\n${externalData}\n</DADOS_EXTERNOS>`;
}

export function defaultRoot(from = import.meta.dirname) {
  return resolve(from, '..', '..');
}
