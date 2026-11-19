const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

let env;
let requestId;

before(() => {
  env = makeApp();
  requestId = env.app.locals.db.prepare('SELECT id FROM requests LIMIT 1').get().id;
});

after(() => {
  env.cleanup();
});

async function loginRegularUser() {
  const agent = request.agent(env.app);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'usuario@empresa.local', password: 'Usuario@123' });
  assert.equal(res.status, 302);
  return agent;
}

test('anonymous user cannot post a comment', async () => {
  const res = await request(env.app)
    .post(`/requisicoes/${requestId}/comentarios`)
    .type('form')
    .send({ body: 'Comentário anônimo' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
  assert.equal(
    env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE body = ?').get('Comentário anônimo').n,
    0,
  );
});

test('regular user posts a comment that appears on the detail page', async () => {
  const agent = await loginRegularUser();
  const res = await agent
    .post(`/requisicoes/${requestId}/comentarios`)
    .type('form')
    .send({ body: 'Validado com o cliente.' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/requisicoes/${requestId}`);

  const row = env.app.locals.db
    .prepare('SELECT * FROM comments WHERE body = ?')
    .get('Validado com o cliente.');
  assert.ok(row, 'comment should be persisted');
  assert.equal(row.request_id, requestId);

  const page = await agent.get(`/requisicoes/${requestId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Validado com o cliente\./);
  assert.match(page.text, /Maria Atendimento/);
});

test('empty comments are rejected with 400', async () => {
  const agent = await loginRegularUser();
  const res = await agent
    .post(`/requisicoes/${requestId}/comentarios`)
    .type('form')
    .send({ body: '   ' });
  assert.equal(res.status, 400);
  assert.match(res.text, /comentário/i);
});

test('comments above the TEXT limit are rejected with 400', async () => {
  const agent = await loginRegularUser();
  const before = env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
  const res = await agent
    .post(`/requisicoes/${requestId}/comentarios`)
    .type('form')
    .send({ body: 'x'.repeat(20001) });

  assert.equal(res.status, 400);
  assert.match(res.text, /no máximo 20000 caracteres/);
  assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, before);
});

test('commenting on a nonexistent request returns 404', async () => {
  const agent = await loginRegularUser();
  const res = await agent
    .post('/requisicoes/999999/comentarios')
    .type('form')
    .send({ body: 'Teste' });
  assert.equal(res.status, 404);
});

async function loginAdmin() {
  const agent = request.agent(env.app);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });
  assert.equal(res.status, 302);
  return agent;
}

const jobByTitle = (title) =>
  env.app.locals.db.prepare('SELECT * FROM requests WHERE title = ?').get(title);

async function createComment(agent, requestIdToUse, body) {
  const res = await agent
    .post(`/requisicoes/${requestIdToUse}/comentarios`)
    .type('form')
    .send({ body });
  assert.equal(res.status, 302);
  return env.app.locals.db
    .prepare('SELECT * FROM comments WHERE request_id = ? AND body = ?')
    .get(requestIdToUse, body);
}

test('admin edita comentário enquanto o job está em Em processo', async () => {
  const agent = await loginAdmin();
  const job = jobByTitle('Novo campo no cadastro');
  assert.equal(job.status, 'Em processo');

  const comment = await createComment(agent, job.id, 'Texto original da equipe.');
  const res = await agent
    .post(`/requisicoes/${job.id}/comentarios/${comment.id}/editar`)
    .type('form')
    .send({ body: 'Texto revisado pelo administrador.' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/requisicoes/${job.id}`);
  const updated = env.app.locals.db.prepare('SELECT * FROM comments WHERE id = ?').get(comment.id);
  assert.equal(updated.body, 'Texto revisado pelo administrador.');
  assert.ok(updated.edited_at, 'edited_at should be recorded');
});

test('usuário comum não edita comentários', async () => {
  const admin = await loginAdmin();
  const job = jobByTitle('Novo campo no cadastro');
  const comment = env.app.locals.db
    .prepare("SELECT * FROM comments WHERE request_id = ? AND body = 'Texto revisado pelo administrador.'")
    .get(job.id);

  const agent = await loginRegularUser();
  const res = await agent
    .post(`/requisicoes/${job.id}/comentarios/${comment.id}/editar`)
    .type('form')
    .send({ body: 'Tentativa indevida.' });

  assert.equal(res.status, 403);
  const unchanged = env.app.locals.db.prepare('SELECT * FROM comments WHERE id = ?').get(comment.id);
  assert.equal(unchanged.body, 'Texto revisado pelo administrador.');
  assert.ok(admin, 'admin agent exists');
});

test('comentário fica bloqueado fora de Em processo e volta a ser editável se o status recuar', async () => {
  const agent = await loginAdmin();
  const job = jobByTitle('Novo campo no cadastro');
  const comment = env.app.locals.db
    .prepare("SELECT * FROM comments WHERE request_id = ? ORDER BY id DESC LIMIT 1")
    .get(job.id);
  const original = comment.body;

  let res = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Aprovação' });
  assert.equal(res.status, 200);

  res = await agent
    .post(`/requisicoes/${job.id}/comentarios/${comment.id}/editar`)
    .type('form')
    .send({ body: 'Edição bloqueada.' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Em processo/);
  assert.equal(
    env.app.locals.db.prepare('SELECT body FROM comments WHERE id = ?').get(comment.id).body,
    original,
  );

  res = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Em processo' });
  assert.equal(res.status, 200);

  res = await agent
    .post(`/requisicoes/${job.id}/comentarios/${comment.id}/editar`)
    .type('form')
    .send({ body: 'Edição liberada novamente.' });
  assert.equal(res.status, 302);
  assert.equal(
    env.app.locals.db.prepare('SELECT body FROM comments WHERE id = ?').get(comment.id).body,
    'Edição liberada novamente.',
  );
});

test('comentário de job Aprovado não pode ser alterado nem pelo admin', async () => {
  const agent = await loginAdmin();
  const job = jobByTitle('Migração de dados');
  assert.equal(job.status, 'Aprovado');
  const comment = env.app.locals.db
    .prepare('SELECT * FROM comments WHERE request_id = ? LIMIT 1')
    .get(job.id);
  assert.ok(comment, 'job aprovado precisa ter um comentário no seed');

  const res = await agent
    .post(`/requisicoes/${job.id}/comentarios/${comment.id}/editar`)
    .type('form')
    .send({ body: 'Tentativa em job aprovado.' });
  assert.equal(res.status, 400);
  assert.equal(
    env.app.locals.db.prepare('SELECT body FROM comments WHERE id = ?').get(comment.id).body,
    comment.body,
  );
});

