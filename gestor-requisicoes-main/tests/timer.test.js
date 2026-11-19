const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

let env;

before(() => {
  env = makeApp();
});

after(() => {
  env.cleanup();
});

const db = () => env.app.locals.db;
const jobByTitle = (title) => db().prepare('SELECT * FROM requests WHERE title = ?').get(title);

async function login(email, password) {
  const agent = request.agent(env.app);
  const res = await agent.post('/login').type('form').send({ email, password });
  assert.equal(res.status, 302);
  return agent;
}
const admin = () => login('admin@empresa.local', 'Admin@123');
const user = () => login('usuario@empresa.local', 'Usuario@123');

test('starting a Novo job timer moves it to Em andamento', async () => {
  const agent = await user();
  const job = jobByTitle('Ajuste no layout do portal');
  assert.equal(job.status, 'Novo');

  const res = await agent.post(`/requisicoes/${job.id}/timer/iniciar`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/requisicoes/${job.id}`);

  const updated = jobByTitle('Ajuste no layout do portal');
  assert.equal(updated.status, 'Em andamento');

  const entry = db()
    .prepare('SELECT * FROM time_entries WHERE request_id = ? AND user_id = ?')
    .get(job.id, updated.responsible_id);
  assert.ok(entry, 'time entry should exist');
  assert.equal(entry.status, 'running');
  assert.ok(entry.started_at, 'started_at should be recorded');
});

test('detail page renders the server-backed timer', async () => {
  const agent = await user();
  const job = jobByTitle('Ajuste no layout do portal');
  const res = await agent.get(`/requisicoes/${job.id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Controle de tempo/);
  assert.match(res.text, /Pausar/);
  assert.match(res.text, /Concluir job/);
  assert.match(res.text, /data-timer-seconds/);
});

test('pausing accumulates time and resuming keeps the total', async () => {
  const agent = await user();
  const job = jobByTitle('Ajuste no layout do portal');

  let res = await agent.post(`/requisicoes/${job.id}/timer/pausar`);
  assert.equal(res.status, 302);

  let entry = db().prepare('SELECT * FROM time_entries WHERE request_id = ?').get(job.id);
  assert.equal(entry.status, 'paused');
  assert.equal(entry.started_at, null);
  const pausedTotal = entry.accumulated_seconds;
  assert.ok(pausedTotal >= 0);

  res = await agent.post(`/requisicoes/${job.id}/timer/retomar`);
  assert.equal(res.status, 302);

  entry = db().prepare('SELECT * FROM time_entries WHERE request_id = ?').get(job.id);
  assert.equal(entry.status, 'running');
  assert.equal(entry.accumulated_seconds, pausedTotal);
  assert.ok(entry.started_at);
});

test('finishing the timer moves the job to Em processo and keeps the log', async () => {
  const agent = await user();
  const job = jobByTitle('Ajuste no layout do portal');

  // O relato é registrado em "O que está sendo feito?" antes de concluir.
  await agent.post(`/requisicoes/${job.id}/comentarios`).type('form').send({ body: 'Layout ajustado e revisado no navegador.' });
  const res = await agent.post(`/requisicoes/${job.id}/timer/concluir`).type('form').send({});
  assert.equal(res.status, 302);

  const updated = jobByTitle('Ajuste no layout do portal');
  assert.equal(updated.status, 'Em processo');

  const entry = db().prepare('SELECT * FROM time_entries WHERE request_id = ?').get(job.id);
  assert.equal(entry.status, 'finished');
  assert.equal(entry.started_at, null);

  // O comentário obrigatório vira o relato lido pelo cliente na aprovação.
  const comment = db()
    .prepare('SELECT * FROM comments WHERE request_id = ? ORDER BY id DESC LIMIT 1')
    .get(job.id);
  assert.equal(comment.body, 'Layout ajustado e revisado no navegador.');

  // O registro permanece para auditoria e o admin vê o total.
  const adminAgent = await admin();
  const page = await adminAgent.get(`/requisicoes/${job.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Total do job/);
  assert.equal(
    db().prepare('SELECT COUNT(*) AS n FROM time_entries WHERE request_id = ?').get(job.id).n,
    1,
  );
});

test('concluir sem o relato "O que está sendo feito?" é recusado e mantém o timer rodando', async () => {
  const agent = await user();
  const job = jobByTitle('Ajuste no layout do portal');
  // Job ainda sem nenhum relato registrado.
  db().prepare('DELETE FROM comments WHERE request_id = ?').run(job.id);

  let res = await agent.post(`/requisicoes/${job.id}/timer/iniciar`);
  assert.equal(res.status, 302);

  res = await agent.post(`/requisicoes/${job.id}/timer/concluir`).type('form').send({ comment: '   ' });
  assert.equal(res.status, 400);
  assert.match(res.text, /É obrigatório preencher o campo &#34;O que está sendo feito\?&#34; antes de concluir o job\./);
  assert.equal(
    db().prepare('SELECT status FROM time_entries WHERE request_id = ?').get(job.id).status,
    'running',
  );
});

test('only the responsible or an admin can control the timer', async () => {
  const agent = await user();
  // "Correção de login" pertence ao admin.
  const job = jobByTitle('Correção de login');
  assert.notEqual(job.responsible_id, db().prepare('SELECT id FROM users WHERE email = ?').get('usuario@empresa.local').id);

  const res = await agent.post(`/requisicoes/${job.id}/timer/iniciar`);
  assert.equal(res.status, 403);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM time_entries WHERE request_id = ?').get(job.id).n, 0);
});

test('admin can start and finish a timer on any job', async () => {
  const agent = await admin();
  const job = jobByTitle('Correção de login');

  let res = await agent.post(`/requisicoes/${job.id}/timer/iniciar`);
  assert.equal(res.status, 302);
  assert.equal(jobByTitle('Correção de login').status, 'Em andamento');

  // O relato é registrado em "O que está sendo feito?" antes de concluir.
  await agent.post(`/requisicoes/${job.id}/comentarios`).type('form').send({ body: 'Correção de login aplicada e validada.' });
  res = await agent.post(`/requisicoes/${job.id}/timer/concluir`).type('form').send({});
  assert.equal(res.status, 302);
  assert.equal(jobByTitle('Correção de login').status, 'Em processo');

  const entry = db()
    .prepare('SELECT * FROM time_entries WHERE request_id = ?')
    .get(job.id);
  assert.equal(entry.status, 'finished');
});

test('approving an Em processo job keeps the admin-to-client handoff working', async () => {
  const agent = await admin();
  let job = jobByTitle('Ajuste no layout do portal');
  // O teste anterior mexeu no timer deste job: registra o relato e conclui o
  // timer do admin; o job segue (ou volta) para a revisão em Em processo.
  await agent.post(`/requisicoes/${job.id}/comentarios`).type('form').send({ body: 'Ajustes finais aplicados.' });
  await agent.post(`/requisicoes/${job.id}/timer/iniciar`);
  assert.equal((await agent.post(`/requisicoes/${job.id}/timer/concluir`).type('form').send({})).status, 302);
  job = jobByTitle('Ajuste no layout do portal');
  assert.equal(job.status, 'Em processo');

  const page = await agent.get(`/requisicoes/${job.id}`);
  assert.match(page.text, /Aprovar e enviar ao cliente/);

  const res = await agent.post(`/requisicoes/${job.id}/aprovar`);
  assert.equal(res.status, 302);
  assert.equal(jobByTitle('Ajuste no layout do portal').status, 'Aprovação');
});

test('unknown timer actions return 404 instead of crashing', async () => {
  const agent = await user();
  const res = await agent.post('/requisicoes/999999/timer/pausar');
  assert.equal(res.status, 404);
});
