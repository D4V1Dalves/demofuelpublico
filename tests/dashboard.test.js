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

async function loginAsAdmin() {
  const agent = request.agent(env.app);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });
  assert.equal(res.status, 302);
  return agent;
}

test('anonymous GET /dashboard redirects to /login', async () => {
  const res = await request(env.app).get('/dashboard');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('dashboard shows KPIs and all status columns with seeded requests', async () => {
  const agent = await loginAsAdmin();
  const res = await agent.get('/dashboard');

  assert.equal(res.status, 200);
  assert.match(res.text, /Total de jobs/);
  assert.match(res.text, /Em atraso/);
  for (const column of ['Novo', 'Em andamento', 'Em processo', 'Aprovado']) {
    assert.match(res.text, new RegExp(column), `missing column ${column}`);
  }
  assert.match(res.text, /Correção de login/);
  assert.match(res.text, /Acme Ltda/);
});

test('dashboard is available to a regular user too', async () => {
  const agent = request.agent(env.app);
  await agent
    .post('/login')
    .type('form')
    .send({ email: 'usuario@empresa.local', password: 'Usuario@123' });
  const res = await agent.get('/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /Relatório mensal de vendas/);
});

test('client filter shows only requests from that client', async () => {
  const agent = await loginAsAdmin();
  const client = env.app.locals.db.prepare("SELECT id FROM clients WHERE name = 'Initech'").get();
  const res = await agent.get(`/dashboard?cliente=${client.id}`);

  assert.equal(res.status, 200);
  assert.match(res.text, /Correção de login/);
  assert.match(res.text, /Treinamento da equipe/);
  assert.doesNotMatch(res.text, /Relatório mensal de vendas/);
});

test('search filter matches request titles', async () => {
  const agent = await loginAsAdmin();
  const res = await agent.get('/dashboard?q=migra');

  assert.equal(res.status, 200);
  assert.match(res.text, /Migração de dados/);
  assert.doesNotMatch(res.text, /Correção de login/);
});

test('overdue KPI counts the seeded late request', async () => {
  const agent = await loginAsAdmin();
  const res = await agent.get('/dashboard');
  const overdue = Number(
    env.app.locals.db
      .prepare(
        `SELECT COUNT(*) AS n FROM requests
         WHERE due_date IS NOT NULL AND due_date < date('now','localtime')
           AND status NOT IN ('Aprovado','Rejeitado')`,
      )
      .get().n,
  );
  assert.ok(overdue >= 1);
  assert.match(res.text, new RegExp(`Em atraso[\\s\\S]{0,200}${overdue}`));
});
