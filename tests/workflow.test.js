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

async function login(email, password) {
  const agent = request.agent(env.app);
  const res = await agent.post('/login').type('form').send({ email, password });
  assert.equal(res.status, 302);
  return agent;
}

const admin = () => login('admin@empresa.local', 'Admin@123');
const user = () => login('usuario@empresa.local', 'Usuario@123');
const byTitle = (title) => env.app.locals.db.prepare('SELECT * FROM requests WHERE title = ?').get(title);
const statusOf = (id) => byTitle(id).status;

test('anonymous user cannot change a job status via drag endpoint', async () => {
  const job = byTitle('Ajuste no layout do portal');
  const res = await request(env.app)
    .post(`/requisicoes/${job.id}/status`)
    .send({ status: 'Em andamento' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
  assert.equal(statusOf('Ajuste no layout do portal'), 'Novo');
});

test('regular user cannot change a job status via drag endpoint', async () => {
  const agent = await user();
  const job = byTitle('Ajuste no layout do portal');
  const res = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Em andamento' });

  assert.equal(res.status, 403);
  assert.equal(statusOf('Ajuste no layout do portal'), 'Novo');
});

test('admin drags a job to another column and persists the new status', async () => {
  const agent = await admin();
  const job = byTitle('Ajuste no layout do portal');
  const res = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Em andamento' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, status: 'Em andamento' });
  assert.equal(statusOf('Ajuste no layout do portal'), 'Em andamento');
});

test('admin cannot drag a job to Concluido without both approvals', async () => {
  const agent = await admin();
  const job = byTitle('Ajuste no layout do portal');
  const res = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Aprovado' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /aprovação/i);
  assert.equal(statusOf('Ajuste no layout do portal'), 'Em andamento');
});

test('admin cannot drag a job to Concluido with only the admin approval', async () => {
  const agent = await admin();
  const job = byTitle('Ajuste no layout do portal');
  env.app.locals.db
    .prepare("UPDATE requests SET admin_approved_at = datetime('now') WHERE id = ?")
    .run(job.id);

  const res = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Aprovado' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cliente/i);
  assert.equal(statusOf('Ajuste no layout do portal'), 'Em andamento');
});

test('admin can drag a job to Concluido after both approvals', async () => {
  const agent = await admin();
  const job = byTitle('Ajuste no layout do portal');
  env.app.locals.db
    .prepare("UPDATE requests SET client_approved_at = datetime('now') WHERE id = ?")
    .run(job.id);

  const res = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Aprovado' });
  assert.equal(res.status, 200);
  assert.equal(statusOf('Ajuste no layout do portal'), 'Aprovado');
});

test('admin cannot drag a job into Rejeitado - only the client can reject', async () => {
  const agent = await admin();
  const job = byTitle('Ajuste no layout do portal');
  const res = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Rejeitado' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /cliente/i);
  assert.equal(statusOf('Ajuste no layout do portal'), 'Aprovado');
});

test('invalid status values are rejected', async () => {
  const agent = await admin();
  const job = byTitle('Ajuste no layout do portal');
  const res = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Inventado' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /status/i);
});

test('dragging a nonexistent job returns 404', async () => {
  const agent = await admin();
  const res = await agent.post('/requisicoes/999999/status').send({ status: 'Novo' });
  assert.equal(res.status, 404);
});
