import { createHash } from 'node:crypto';

const recipient = 'leonardo@chiarelli.dev';
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const states = new Map([
  ['candidate', 'candidato'], ['pending', 'pendente'], ['rejected', 'rejeitado'],
  ['local_applied', 'aplicado localmente'], ['synced', 'sincronizado'],
  ['merged', 'integrado'], ['remote_active', 'ativo remotamente'], ['rolled_back', 'revertido'],
  ['installed', 'instalado'], ['disabled', 'desativado'], ['prepared', 'preparado'],
  ['rollback_prepared', 'rollback preparado'], ['superseded', 'substituído'],
]);

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function escapeHtml(value) { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function localParts(now, timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}
function semantic(state) {
  const candidates = (state.candidates ?? []).map(({ id, patternKey, artifactKind, scope, status, sourceEventIds }) => {
    const suggestion = [...(state.suggestions ?? [])].reverse().find((item) => item.patternKey === patternKey);
    const sources = (state.events ?? []).filter((event) => sourceEventIds.includes(event.id));
    return { id, patternKey, summary: suggestion?.summary ?? 'Padrão generalizado registrado.', artifactKind, scope, status, evidenceCount: sources.length, sessionCount: new Set(sources.map(({ session }) => session)).size };
  });
  const kinds = new Map((state.candidates ?? []).map(({ id, artifactKind }) => [id, artifactKind]));
  const installations = (state.applications ?? []).flatMap(({ id, candidateId, entries }) => entries.map(({ host, appliedHash, phase }) => ({ id: `installation:${id}:${host}`, artifactKind: kinds.get(candidateId) ?? 'skill', scope: { kind: 'global' }, status: phase, candidateId, appliedHash })));
  const observed = (state.installations ?? []).map(({ id, host, artifactKind, status, contentHash }) => ({ id: `installation-fact:${id}`, artifactKind, scope: { kind: 'global' }, status, host, appliedHash: contentHash }));
  return [...candidates, ...installations, ...observed].sort((left, right) => left.id.localeCompare(right.id));
}
export function digestSnapshot(state) { return digest(JSON.stringify(semantic(state))); }

export function gmailSendRequest(envelope) {
  if (!envelope || envelope.to !== recipient || typeof envelope.id !== 'string' || envelope.subject !== `Resumo de aprendizado [SL:${envelope.id}]` || typeof envelope.text !== 'string' || typeof envelope.html !== 'string' || envelope.contentHash !== digest(envelope.html)) throw new TypeError('digest envelope is invalid');
  return { to: recipient, subject: envelope.subject, payload: { mime_type: 'text/html', charset: 'utf-8', body: { content: envelope.html } }, response_fields: ['id', 'thread_id'] };
}

function nextGate(status) {
  return ({
    candidate: 'iniciar entrega e revisão', pending: 'resolver a evidência pendente', rejected: 'reabrir somente por revisão explícita', prepared: 'concluir os gates de aplicação', local_applied: 'validar os demais hosts', synced: 'integrar a mudança revisada', merged: 'confirmar ativação remota', remote_active: 'monitorar o resultado', rollback_prepared: 'concluir o rollback com prova nativa', rolled_back: 'reabrir somente por revisão explícita', superseded: 'monitorar o artefato substituto', installed: 'validar integração e smoke nativo', disabled: 'manter desativado até revisão explícita',
  })[status] ?? 'revisar o estado observado';
}

function digestItems(changes) {
  return changes.map((change) => {
    if (change.patternKey) return { summary: change.summary, status: states.get(change.status) ?? change.status, evidence: `${change.evidenceCount} ${change.evidenceCount === 1 ? 'sinal generalizado' : 'sinais generalizados'} em ${change.sessionCount} ${change.sessionCount === 1 ? 'sessão' : 'sessões'}`, gate: nextGate(change.status), artifactKind: change.artifactKind };
    if (change.id.startsWith('installation-fact:')) return { summary: `Instalação observada de ${change.artifactKind}${change.host ? ` em ${change.host}` : ''}.`, status: states.get(change.status) ?? change.status, evidence: '1 fato de instalação observado pelo controlador', gate: nextGate(change.status), artifactKind: change.artifactKind };
    return { summary: `Aplicação observada de ${change.artifactKind}${change.host ? ` em ${change.host}` : ''}.`, status: states.get(change.status) ?? change.status, evidence: '1 estado de aplicação persistido', gate: nextGate(change.status), artifactKind: change.artifactKind };
  });
}

export function prepareDigest(state, { now, timeZone = 'America/Sao_Paulo' }) {
  const local = localParts(now, timeZone);
  if (local.hour < 18) return null;
  const changes = semantic(state);
  if (changes.length === 0) return null;
  const snapshotHash = digestSnapshot(state);
  const ledger = Array.isArray(state.ledger) ? state.ledger : [];
  if (ledger.some((entry) => entry.snapshotHash === snapshotHash)) return null;
  if (ledger.some((entry) => entry.interval?.date === local.date && ['prepared', 'sending', 'unknown'].includes(entry.state))) return null;
  const id = `sl-${digest(`${local.date}:${snapshotHash}`).slice(0, 20)}`;
  const subject = `Resumo de aprendizado [SL:${id}]`;
  const items = digestItems(changes);
  const lines = items.map(({ summary, artifactKind, status, evidence, gate }) => `<li><strong>${escapeHtml(summary)}</strong><br>Status: ${escapeHtml(status)} (${escapeHtml(artifactKind)})<br>Evidência: ${escapeHtml(evidence)}<br>Próximo gate: ${escapeHtml(gate)}</li>`).join('');
  const text = `Resumo de aprendizado\n\n${items.map(({ summary, artifactKind, status, evidence, gate }) => `${summary}\nStatus: ${status} (${artifactKind})\nEvidência: ${evidence}\nPróximo gate: ${gate}`).join('\n\n')}`;
  const html = `<h1>Resumo de aprendizado</h1><ul>${lines}</ul>`;
  const contentHash = digest(html);
  return { id, to: recipient, subject, text, html, contentHash, snapshotHash, interval: { date: local.date, timeZone }, ledger: { id, to: recipient, subject, text, html, contentHash, snapshotHash, interval: { date: local.date, timeZone }, preparedAt: new Date(now).toISOString(), state: 'prepared' } };
}

export function gmailLookupRequest(entry) {
  if (!entry || entry.state !== 'unknown' || typeof entry.subject !== 'string') throw new TypeError('unknown digest ledger entry is required');
  return { label_ids: ['SENT'], query: `subject:"${entry.subject}"` };
}

export function gmailReadRequest(messageId) {
  if (typeof messageId !== 'string' || !identifier.test(messageId)) throw new TypeError('Gmail message id is invalid');
  return { format: 'full', message_id: messageId };
}

function header(payload, name) {
  const value = payload?.headers?.find((item) => typeof item?.name === 'string' && item.name.toLowerCase() === name)?.value;
  return typeof value === 'string' ? value : null;
}
function htmlPart(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const mime = payload.mimeType ?? payload.mime_type;
  if (mime === 'text/html') return typeof payload.content === 'string' ? payload.content : typeof payload.body?.content === 'string' ? payload.body.content : null;
  for (const part of Array.isArray(payload.parts) ? payload.parts : []) { const content = htmlPart(part); if (content !== null) return content; }
  return null;
}

export async function reconcile(state, { lookup }) {
  for (const entry of state.ledger ?? []) {
    if (entry.state !== 'unknown') continue;
    const result = await lookup(gmailLookupRequest(entry));
    const emails = result?.structuredContent?.emails;
    if (Array.isArray(emails)) {
      const ids = [...new Set(emails.map(({ id }) => id).filter((id) => typeof id === 'string' && identifier.test(id)))].slice(0, 20);
      if (ids.length > 0) return { envelopeId: entry.id, result: 'unknown', reconciled: false, retry: false, requests: ids.map(gmailReadRequest) };
      continue;
    }
    const structured = result?.structuredContent;
    const messages = Array.isArray(structured?.fullEmails) ? structured.fullEmails : [structured?.email ?? structured?.message ?? structured];
    for (const message of messages) if (message && typeof message === 'object') {
      const labels = message?.label_ids ?? message?.labelIds;
      const content = htmlPart(message.payload);
      if (!Array.isArray(labels) || !labels.includes('SENT') || header(message.payload, 'to') !== entry.to || header(message.payload, 'subject') !== entry.subject || content !== entry.html || digest(content) !== entry.contentHash || typeof message.id !== 'string' || !identifier.test(message.id)) continue;
      const evidenceRef = `gmail:${message.id}`;
      return { envelopeId: entry.id, result: 'sent', messageId: message.id, evidenceRef, reconciled: true, retry: false, entry: { ...entry, state: 'sent', messageId: message.id, evidenceRef } };
    }
  }
  return { envelopeId: (state.ledger ?? []).find(({ state: status }) => status === 'unknown')?.id ?? null, result: 'unknown', reconciled: false, retry: false };
}
