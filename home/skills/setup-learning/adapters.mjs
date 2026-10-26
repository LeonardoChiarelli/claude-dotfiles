import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sensitive = /(?:\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]|\b(?:Bearer\s+|sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{8,})/i;

function descriptionFrom(header) {
  const match = header.match(/^description:\s*(.*)$/im); if (!match) return null; const value = match[1].trim();
  if (value === '>' || value === '|') {
    const rest = header.slice((match.index ?? 0) + match[0].length).replace(/^\r?\n/, '').split(/\r?\n/); const lines = [];
    for (const line of rest) { if (!/^\s+\S/.test(line)) break; lines.push(line.trim()); }
    return lines.length === 0 ? null : value === '>' ? lines.join(' ') : lines.join('\n');
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1).trim() || null;
  return value || null;
}

export function privateStateDir(localAppData = process.env.LOCALAPPDATA) {
  if (typeof localAppData !== 'string' || !isAbsolute(localAppData)) throw new Error('LOCALAPPDATA is unavailable');
  return join(localAppData, 'setup-learning');
}

export function fixedHistoryRoots(home = homedir()) {
  return [
    { host: 'codex', path: join(home, '.codex', 'sessions'), locator: 'codex://sessions' },
    { host: 'claude', path: join(home, '.claude', 'projects'), locator: 'claude://projects' },
  ];
}

async function regularFiles(root, accept, maxFiles = 10_000) {
  const files = []; const stack = [root];
  while (stack.length > 0 && files.length < maxFiles) {
    const directory = stack.pop(); let entries;
    try { if ((await lstat(directory)).isSymbolicLink()) continue; entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && accept(path)) files.push(path);
      if (files.length === maxFiles) break;
    }
  }
  return files.sort();
}

/** Discovers only JSONL transcripts below the fixed, local history roots. */
export async function discoverHistoryRoots(home = homedir(), sources = []) {
  const result = [];
  for (const descriptor of fixedHistoryRoots(home)) {
    for (const path of await regularFiles(descriptor.path, (value) => value.toLowerCase().endsWith('.jsonl'))) {
      const rel = relative(descriptor.path, path).split(sep).map(encodeURIComponent).join('/');
      result.push({ host: descriptor.host, path, locator: `${descriptor.host}://history/${rel}`, root: descriptor.path });
    }
  }
  for (const source of Array.isArray(sources) ? sources : []) {
    const descriptor = await cursorHistoryDescriptor(source, home);
    if (descriptor && !result.some(({ locator }) => locator === descriptor.locator)) result.push(descriptor);
  }
  return result;
}

/** Returns a real, hash-bound artifact catalog. Disabled skills remain visible and ineligible for reactivation. */
export async function catalogArtifacts(home = homedir(), skillInventory = null) {
  const specs = [
    { root: join(home, '.agents', 'skills'), kind: 'skill', accept: (path) => path.endsWith(`${sep}SKILL.md`) },
    { root: join(home, '.codex', 'plugins', 'cache'), kind: 'skill', accept: (path) => path.endsWith(`${sep}SKILL.md`) },
    { root: join(home, '.codex', 'hooks'), kind: 'hook', accept: (path) => path.endsWith('.mjs') },
    { root: join(home, '.codex', 'agents'), kind: 'agents', accept: (path) => path.endsWith('.toml') },
  ];
  const result = [];
  for (const spec of specs) {
    for (const path of await regularFiles(spec.root, spec.accept, 2_000)) {
      const content = await readFile(path); const relativePath = relative(home, path).split(sep).join('/'); const contentHash = createHash('sha256').update(content).digest('hex'); const header = content.toString('utf8').match(/^---[\s\S]*?---/)?.[0] ?? '';
      const frontmatterDisabled = spec.kind === 'skill' && /disabled-environments:\s*(?:\[[^\]]*\bcodex\b[^\]]*\]|(?:\r?\n[ \t]*-[ \t]*[^\r\n]*)*\bcodex\b)/i.test(header);
      const observed = spec.kind === 'skill' && skillInventory?.source === 'skills/list' && Array.isArray(skillInventory.skills)
        ? skillInventory.skills.find((item) => item?.path === relativePath && item?.hash === contentHash) : null;
      const enabled = spec.kind !== 'skill' ? true : frontmatterDisabled ? false : observed ? observed.disabled === false : 'unknown';
      const summary = descriptionFrom(header);
      result.push({ path: relativePath, kind: spec.kind, scope: { kind: 'global' }, hash: contentHash, enabled, summary });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export async function cursorTranscriptRoot(metadata, home = homedir()) {
  const path = metadata?.transcript_path; const allowed = resolve(home, '.cursor', 'projects');
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 1024) return { status: 'pending', reason: 'transcript_path_unavailable' };
  const candidate = resolve(path); const rel = relative(allowed, candidate); const parts = rel.split(sep); const transcriptIndex = parts.indexOf('agent-transcripts');
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || parts.length < 3 || parts.length > 8 || parts.includes('subagents') || transcriptIndex < 1 || transcriptIndex >= parts.length - 1 || !parts.every((part) => safeSegment.test(part)) || !parts.at(-1).endsWith('.jsonl')) return { status: 'pending', reason: 'transcript_path_untrusted' };
  try {
    if ((await lstat(allowed)).isSymbolicLink()) return { status: 'pending', reason: 'transcript_path_untrusted' };
    let current = allowed;
    for (const part of parts) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) return { status: 'pending', reason: 'transcript_path_untrusted' }; }
    if (!(await lstat(candidate)).isFile()) return { status: 'pending', reason: 'transcript_path_untrusted' };
    const realAllowed = await realpath(allowed); const realCandidate = await realpath(candidate);
    if (!realCandidate.startsWith(`${realAllowed}${sep}`)) return { status: 'pending', reason: 'transcript_path_untrusted' };
  } catch { return { status: 'pending', reason: 'transcript_path_unavailable' }; }
  return { host: 'cursor', path: candidate, locator: `cursor://projects/${parts.join('/')}`, status: 'ready' };
}

/** Resolves only locators emitted by cursorTranscriptRoot back under the fixed transcript allowlist. */
export async function cursorHistoryDescriptor(source, home = homedir()) {
  if (source?.host !== 'cursor' || typeof source.locator !== 'string' || !source.locator.startsWith('cursor://projects/')) return null;
  const parts = source.locator.slice('cursor://projects/'.length).split('/');
  if (parts.some((part) => !safeSegment.test(part))) return null;
  const path = join(resolve(home, '.cursor', 'projects'), ...parts);
  const resolved = await cursorTranscriptRoot({ transcript_path: path }, home);
  if (resolved.status !== 'ready' || resolved.locator !== source.locator) return null;
  return { host: 'cursor', path: resolved.path, locator: resolved.locator, root: resolve(home, '.cursor', 'projects') };
}

export function validateAdvisoryTemplate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'event,kind,reminder,version' || value.version !== 1 || value.kind !== 'advisory-reminder' || value.event !== 'sessionStart' || typeof value.reminder !== 'string' || value.reminder.length < 1 || value.reminder.length > 512 || /[\r\n\0`{}<>$]/.test(value.reminder) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(value.reminder) || sensitive.test(value.reminder)) throw new TypeError('advisory template is invalid');
  return value;
}

export function renderAdvisoryReminder(host, value) {
  validateAdvisoryTemplate(value);
  if (host === 'cursor') return { status: 'ready', output: { additional_context: value.reminder } };
  if (host === 'codex' || host === 'claude') return { status: 'ready', output: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: value.reminder } } };
  return { status: 'pending', reason: 'host_unsupported' };
}
