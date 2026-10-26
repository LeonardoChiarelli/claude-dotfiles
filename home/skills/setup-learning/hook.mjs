import { appendEvent, recordSource } from './state.mjs';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { cursorTranscriptRoot, renderAdvisoryReminder, validateAdvisoryTemplate } from './adapters.mjs';
import { normalizeHookEvent } from './history.mjs';

const lifecycle = new Map([['SessionStart', 'SessionStart'], ['sessionStart', 'SessionStart'], ['Stop', 'Stop'], ['stop', 'Stop']]);
const hookName = (payload) => payload?.hook_event_name ?? payload?.hookEventName;

/** Records only sanitized metadata when an explicitly configured private state exists. */
export async function captureHookEvent({ host, payload, stateDir, home, now = () => new Date().toISOString() }) {
  const eventName = lifecycle.get(hookName(payload));
  if (eventName && typeof stateDir === 'string' && stateDir.length > 0) {
    const session = payload.sessionId ?? payload.session_id ?? (eventName === 'Stop' ? payload.conversationId ?? payload.conversation_id : undefined); const at = payload.occurredAt ?? payload.timestamp ?? now();
    if (typeof session === 'string' && typeof at === 'string') {
      const cursorSource = host === 'cursor' ? await cursorTranscriptRoot(payload, home) : null;
      if (cursorSource?.status === 'pending') return { recorded: false, reason: cursorSource.reason };
       const locator = cursorSource?.locator ?? `${host}://hook/${createHash('sha256').update(`${session}\0${eventName}`).digest('hex').slice(0, 32)}`;
      await recordSource(stateDir, { host, event: eventName, session, occurredAt: at, locator }); return { recorded: false, reason: 'source_locator', locator };
    }
  }
  const event = normalizeHookEvent(host, payload);
  if (!event || typeof stateDir !== 'string' || stateDir.length === 0) return { recorded: false, reason: event ? 'state_unconfigured' : 'unsupported_event' };
  await appendEvent(stateDir, event);
  return { recorded: true };
}

/** Executes only reviewed static reminders already installed in the managed template directory. */
export async function executeAdvisoryTemplates({ host, payload, templateDir }) {
  if (lifecycle.get(hookName(payload)) !== 'SessionStart' || typeof templateDir !== 'string') return { status: 'pending', reason: 'event_unsupported' };
  let names;
  let realTemplateDir;
  try {
    if ((await lstat(templateDir)).isSymbolicLink()) return { status: 'pending', reason: 'templates_untrusted' };
    realTemplateDir = await realpath(templateDir);
    names = (await readdir(templateDir)).filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort().slice(0, 32);
  } catch { return { status: 'pending', reason: 'templates_unavailable' }; }
  const reminders = [];
  for (const name of names) {
    try {
      const path = join(templateDir, name); const info = await lstat(path); const realFile = await realpath(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (!realFile.startsWith(`${realTemplateDir}\\`) && !realFile.startsWith(`${realTemplateDir}/`))) continue;
      const reminder = validateAdvisoryTemplate(JSON.parse(await readFile(path, 'utf8'))).reminder;
      if ([...reminders, reminder].join(' ').length <= 512) reminders.push(reminder);
    } catch { /* One invalid template cannot make an advisory hook block the host. */ }
  }
  if (reminders.length === 0) return { status: 'pending', reason: 'templates_unavailable' };
  return renderAdvisoryReminder(host, { version: 1, kind: 'advisory-reminder', event: 'sessionStart', reminder: reminders.join(' ') });
}

export async function runHostHook(input) {
  const capture = await captureHookEvent(input).catch(() => ({ recorded: false, reason: 'capture_failed' }));
  const advisory = await executeAdvisoryTemplates(input).catch(() => ({ status: 'pending', reason: 'executor_failed' }));
  return { capture, advisory };
}
