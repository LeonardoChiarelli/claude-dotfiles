import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareDigest, reconcile } from '../digest.mjs';
import { runCli } from '../cli.mjs';
import { beginSend, finishSend, loadState, recordCandidates, recordInstallation, recordPreparedDigest, sendDigest } from '../state.mjs';

const now = '2026-10-25T21:00:00.000Z';

function candidate(id = 'candidate-1', status = 'pending') {
  return {
    id,
    patternKey: 'prefer-small-diffs',
    scope: { kind: 'global' },
    artifactKind: 'skill',
    status,
    sourceEventIds: ['event-1'],
    baselineHash: null,
    diffHash: null,
    policyVersion: '1',
    version: 0,
  };
}

function searchResult(envelope, id = 'message-1') {
  return { structuredContent: { emails: [{ id, label_ids: ['SENT'], to: envelope.to, subject: envelope.subject }] } };
}
function fullResult(envelope, id = 'message-1', extra = {}) {
  return { structuredContent: { id, labelIds: ['SENT'], payload: { headers: [{ name: 'To', value: envelope.to }, { name: 'Subject', value: envelope.subject }], parts: [{ mimeType: 'text/plain', content: 'fallback' }, { mimeType: 'text/html', content: envelope.html }] }, ...extra } };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'setup-learning-digest-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('prepara somente um envelope pt-BR com resumo semântico e HTML escapado', () => {
  assert.equal(prepareDigest({ candidates: [], ledger: [] }, { now, timeZone: 'America/Sao_Paulo' }), null);
  const envelope = prepareDigest({ candidates: [candidate('candidate-1')], suggestions: [{ patternKey: 'prefer-small-diffs', summary: 'Use <helper>.' }], events: [{ id: 'event-1', session: 'session-1' }], ledger: [] }, { now, timeZone: 'America/Sao_Paulo' });
  assert.equal(envelope.to, 'leonardo@chiarelli.dev');
  assert.match(envelope.subject, /^Resumo de aprendizado \[SL:[A-Za-z0-9_-]+\]$/);
  assert.match(envelope.html, /Use &lt;helper&gt;\./);
  assert.equal(envelope.html.includes('candidate-1'), false);
  assert.match(envelope.text, /pendente/); assert.match(envelope.text, /1 sinal generalizado em 1 sessão/); assert.match(envelope.text, /Próximo gate:/);
  assert.equal(envelope.interval.timeZone, 'America/Sao_Paulo');
});

test('primeiro digest pode usar somente um fato real de instalação, sem Event ou Candidate falso', async () => withDir(async (dir) => {
  const contentHash = createHash('sha256').update('installed artifact').digest('hex');
  await recordInstallation(dir, { id: 'codex-setup-learning', host: 'codex', artifactKind: 'skill', status: 'installed', contentHash, observedAt: now, evidenceRef: 'install-receipt-1' });
  const state = await loadState(dir); const envelope = prepareDigest(state, { now, timeZone: 'America/Sao_Paulo' });
  assert.equal(state.events.length, 0); assert.equal(state.candidates.length, 0);
  assert.match(envelope.text, /Instalação observada de skill em codex/); assert.match(envelope.text, /instalado/); assert.match(envelope.text, /validar integração e smoke nativo/); assert.equal(envelope.text.includes(contentHash), false);
}));

test('não gera novidade a partir de cursor, timestamp ou suporte equivalente', () => {
  const base = { candidates: [candidate()], cursors: { import: 1, analysis: 2 }, ledger: [] };
  const envelope = prepareDigest(base, { now, timeZone: 'America/Sao_Paulo' });
  const sent = { ...envelope.ledger, state: 'sent', messageId: 'message-1', evidenceRef: 'gmail:message-1' };
  const equivalent = {
    candidates: [{ ...candidate(), sourceEventIds: ['event-2'], version: 7 }],
    cursors: { import: 99, analysis: 100 },
    ledger: [sent],
  };
  assert.equal(prepareDigest(equivalent, { now: '2026-10-26T21:00:00.000Z', timeZone: 'America/Sao_Paulo' }), null);
  const changed = { ...equivalent, candidates: [candidate('candidate-1', 'local_applied')] };
  assert.ok(prepareDigest(changed, { now: '2026-10-26T21:00:00.000Z', timeZone: 'America/Sao_Paulo' }));
});

test('respeita 18h IANA e mantém um único catch-up para o mesmo snapshot', () => {
  const state = { candidates: [candidate()], ledger: [] };
  assert.equal(prepareDigest(state, { now: '2026-10-25T20:59:00.000Z', timeZone: 'America/Sao_Paulo' }), null);
  const catchup = prepareDigest(state, { now: '2026-10-25T22:30:00.000Z', timeZone: 'America/Sao_Paulo' });
  assert.ok(catchup);
  assert.equal(prepareDigest({ ...state, ledger: [catchup.ledger] }, { now: '2026-10-26T22:30:00.000Z', timeZone: 'America/Sao_Paulo' }), null);
  assert.equal(prepareDigest(state, { now: '2026-10-26T03:00:00.000Z', timeZone: 'America/Sao_Paulo' }), null);
});

test('recusa prepared obsoleto quando o snapshot mudou antes de adquirir o lock', async () => withDir(async (dir) => {
  await recordCandidates(dir, [candidate()]);
  const envelope = prepareDigest(await loadState(dir), { now, timeZone: 'America/Sao_Paulo' });
  await recordCandidates(dir, [candidate('candidate-2')]);
  await assert.rejects(recordPreparedDigest(dir, envelope), /snapshot/i);
}));

test('recusa persistir um destinatário diferente do único destino autorizado', async () => withDir(async (dir) => {
  await recordCandidates(dir, [candidate()]);
  const envelope = prepareDigest(await loadState(dir), { now, timeZone: 'America/Sao_Paulo' });
  await assert.rejects(recordPreparedDigest(dir, { ...envelope, ledger: { ...envelope.ledger, to: 'other@example.invalid' } }), /digest ledger/i);
}));

test('persiste sending antes da ferramenta e recupera crash como unknown sem reenvio', async () => withDir(async (dir) => {
  await recordCandidates(dir, [candidate()]);
  const envelope = prepareDigest(await loadState(dir), { now, timeZone: 'America/Sao_Paulo' });
  await recordPreparedDigest(dir, envelope);
  await beginSend(dir, envelope.id);
  const crashed = await loadState(dir);
  assert.equal(crashed.ledger[0].state, 'unknown');
  assert.equal(prepareDigest(crashed, { now, timeZone: 'America/Sao_Paulo' }), null);
  assert.equal((await reconcile(crashed, { lookup: async () => null })).retry, false);
}));

test('reconcilia somente uma mensagem SENT que prova destinatário, assunto e conteúdo', async () => withDir(async (dir) => {
  await recordCandidates(dir, [candidate()]);
  const envelope = prepareDigest(await loadState(dir), { now, timeZone: 'America/Sao_Paulo' });
  await recordPreparedDigest(dir, envelope);
  await beginSend(dir, envelope.id);
  await finishSend(dir, { envelopeId: envelope.id, result: 'unknown' });
  const state = await loadState(dir);
  const mismatch = await reconcile(state, { lookup: async () => ({ structuredContent: { emails: [{ id: 'wrong', label_ids: ['SENT'], to: 'other@example.invalid', subject: envelope.subject }] } }) });
  assert.equal(mismatch.reconciled, false);
  let request;
  const found = await reconcile(state, { lookup: async (value) => { request = value; return { structuredContent: { emails: [{ id: 'message-1' }, { id: 'message-2' }], next_page_token: null } }; } });
  assert.equal(found.reconciled, false); assert.deepEqual(found.requests, [{ format: 'full', message_id: 'message-1' }, { format: 'full', message_id: 'message-2' }]);
  const wrong = fullResult(envelope, 'message-1', { payload: { headers: [{ name: 'To', value: 'other@example.invalid' }, { name: 'Subject', value: envelope.subject }], parts: [{ mimeType: 'text/html', content: envelope.html }] } }).structuredContent;
  const matched = await reconcile(state, { lookup: async () => ({ structuredContent: { fullEmails: [wrong, fullResult(envelope, 'message-2').structuredContent] } }) });
  assert.equal(matched.reconciled, true);
  assert.equal(matched.entry.state, 'sent'); assert.equal(matched.messageId, 'message-2');
  assert.deepEqual(request, { label_ids: ['SENT'], query: `subject:"${envelope.subject}"` });
  await finishSend(dir, matched);
  assert.equal((await loadState(dir)).ledger[0].state, 'sent');
}));

test('usa structuredContent do conector, nunca o texto de conclusão, para confirmar o envio', async () => withDir(async (dir) => {
  await recordCandidates(dir, [candidate()]);
  const envelope = prepareDigest(await loadState(dir), { now, timeZone: 'America/Sao_Paulo' });
  await recordPreparedDigest(dir, envelope);
  await beginSend(dir, envelope.id);
  const state = await loadState(dir);
  const result = await reconcile(state, { lookup: async () => ({ ...fullResult(envelope), content: [{ type: 'text', text: 'Action completed.' }] }) });
  assert.equal(result.reconciled, true);
  assert.equal(result.entry.messageId, 'message-1');
  const forged = await reconcile(state, { lookup: async () => ({ id: 'forged', label_ids: ['SENT'], payload: fullResult(envelope).structuredContent.payload, content: [{ type: 'text', text: 'Action completed.' }] }) });
  assert.equal(forged.reconciled, false);
}));

test('registra sending antes do adaptador e só aceita id e thread_id estruturados', async () => withDir(async (dir) => {
  await recordCandidates(dir, [candidate()]);
  const envelope = prepareDigest(await loadState(dir), { now, timeZone: 'America/Sao_Paulo' });
  await recordPreparedDigest(dir, envelope);
  let request;
  const sent = await sendDigest(dir, envelope, { send: async (value) => {
    request = value;
    const journal = (await readFile(join(dir, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(journal.at(-1).value.state, 'sending');
    return { structuredContent: { id: 'message-1', thread_id: 'thread-1' }, content: [{ type: 'text', text: 'Action completed.' }] };
  } });
  assert.deepEqual(request, { to: envelope.to, subject: envelope.subject, payload: { mime_type: 'text/html', charset: 'utf-8', body: { content: envelope.html } }, response_fields: ['id', 'thread_id'] });
  assert.equal(sent.state, 'sent');

  await recordCandidates(dir, [candidate('candidate-2')]);
  const next = prepareDigest(await loadState(dir), { now: '2026-10-26T21:00:00.000Z', timeZone: 'America/Sao_Paulo' });
  await recordPreparedDigest(dir, next);
  const unknown = await sendDigest(dir, next, { send: async () => ({ content: [{ type: 'text', text: 'Action completed.' }] }) });
  assert.equal(unknown.state, 'unknown');
}));

test('rejeita regressão de estado durante replay do ledger', async () => withDir(async (dir) => {
  const envelope = prepareDigest({ candidates: [candidate()], ledger: [] }, { now, timeZone: 'America/Sao_Paulo' });
  const sent = { ...envelope.ledger, state: 'sent', messageId: 'message-1', evidenceRef: 'gmail:message-1' };
  await writeFile(join(dir, 'journal.jsonl'), [envelope.ledger, { ...envelope.ledger, state: 'sending' }, sent, { ...envelope.ledger, state: 'unknown' }].map((value) => JSON.stringify({ type: 'digest', value })).join('\n') + '\n');
  await assert.rejects(loadState(dir), /digest transition/i);
}));

test('aceita confirmação tardia da mesma tentativa, mas não de tentativa diferente', async () => withDir(async (dir) => {
  await recordCandidates(dir, [candidate()]);
  const envelope = prepareDigest(await loadState(dir), { now, timeZone: 'America/Sao_Paulo' });
  await recordPreparedDigest(dir, envelope);
  await beginSend(dir, envelope.id);
  await finishSend(dir, { envelopeId: envelope.id, result: 'sent', messageId: 'message-1', evidenceRef: 'gmail:message-1' });
  assert.equal((await loadState(dir)).ledger[0].state, 'sent');
  await assert.rejects(finishSend(dir, { envelopeId: 'other-envelope', result: 'sent', messageId: 'message-2', evidenceRef: 'gmail:message-2' }), /envelope/i);
}));

test('CLI entrega ao controlador uma requisição Gmail somente após registrar sending', async () => withDir(async (dir) => {
  await recordCandidates(dir, [candidate()]);
  let stdout = ''; let stderr = '';
  const dependencies = { now: () => now, writeOut: (value) => { stdout += value; }, writeErr: (value) => { stderr += value; } };
  assert.equal(await runCli(['prepare-digest', '--state-dir', dir], dependencies), 0);
  const prepared = JSON.parse(stdout);
  assert.equal(prepared.status, 'prepared');
  stdout = '';
  assert.equal(await runCli(['begin-digest', '--state-dir', dir, '--envelope', prepared.envelopeId], dependencies), 0);
  const sending = JSON.parse(stdout);
  assert.equal(sending.status, 'sending');
  assert.equal(sending.request.to, 'leonardo@chiarelli.dev');
  assert.equal((await loadState(dir)).ledger[0].state, 'unknown');
  stdout = '';
  assert.equal(await runCli(['reconcile-digest', '--state-dir', dir], dependencies), 0);
  const lookup = JSON.parse(stdout); assert.equal(lookup.status, 'lookup'); assert.match(lookup.request.query, /Resumo de aprendizado/);
  const ledger = (await loadState(dir)).ledger[0]; stdout = '';
  const search = searchResult(ledger); assert.equal(await runCli(['reconcile-digest', '--state-dir', dir, '--result', JSON.stringify(search)], dependencies), 0);
  const read = JSON.parse(stdout); assert.equal(read.status, 'lookup'); assert.deepEqual(read.requests, [{ format: 'full', message_id: 'message-1' }]); stdout = '';
  assert.equal(await runCli(['reconcile-digest', '--state-dir', dir, '--result', JSON.stringify(fullResult(ledger))], dependencies), 0);
  assert.equal(JSON.parse(stdout).state, 'sent');
}));
