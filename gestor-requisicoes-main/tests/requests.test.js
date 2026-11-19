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

function validPayload(overrides = {}) {
  return {
    client_id: String(env.app.locals.db.prepare('SELECT id FROM clients LIMIT 1').get().id),
    title: 'Requisição de teste',
    description: 'Descrição detalhada',
    status: 'Novo',
    priority: 'Alta',
    responsible_id: '',
    due_date: '2030-01-15',
    ...overrides,
  };
}

test('regular user cannot open the new request form', async () => {
  const agent = await user();
  const res = await agent.get('/requisicoes/nova');
  assert.equal(res.status, 403);
});

test('admin opening the new request form sees clients and status options', async () => {
  const agent = await admin();
  const res = await agent.get('/requisicoes/nova');
  assert.equal(res.status, 200);
  assert.match(res.text, /Acme Ltda/);
  assert.match(res.text, /Em andamento/);
});

test('admin creates a request and is redirected to the dashboard', async () => {
  const agent = await admin();
  const res = await agent.post('/requisicoes').type('form').send(validPayload({ title: 'Nova integração API' }));

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');

  const row = env.app.locals.db
    .prepare('SELECT * FROM requests WHERE title = ?')
    .get('Nova integração API');
  assert.ok(row, 'request should be persisted');
  assert.equal(row.status, 'Novo');
  assert.equal(row.priority, 'Alta');
  assert.equal(row.due_date, '2030-01-15');
});

test('invalid request data is rejected with 400 and nothing is persisted', async () => {
  const agent = await admin();
  const before = env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  const res = await agent.post('/requisicoes').type('form').send(validPayload({ title: '' }));

  assert.equal(res.status, 400);
  assert.match(res.text, /título/i);
  assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, before);
});

test('limites do schema MySQL e datas impossíveis são rejeitados antes da escrita', async () => {
  const agent = await admin();
  const before = env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;

  const longTitle = await agent
    .post('/requisicoes')
    .type('form')
    .send(validPayload({ title: 'x'.repeat(256) }));
  assert.equal(longTitle.status, 400);
  assert.match(longTitle.text, /no máximo 255 caracteres/);

  const impossibleDate = await agent
    .post('/requisicoes')
    .type('form')
    .send(validPayload({ due_date: '2026-02-31' }));
  assert.equal(impossibleDate.status, 400);
  assert.match(impossibleDate.text, /Data inválida/);

  const longDescription = await agent
    .post('/requisicoes')
    .type('form')
    .send(validPayload({ description: 'x'.repeat(20001) }));
  assert.equal(longDescription.status, 400);
  assert.match(longDescription.text, /no máximo 20000 caracteres/);

  const longUrl = await agent
    .post('/requisicoes')
    .type('form')
    .send(validPayload({ dropbox_url: `https://${'a'.repeat(3000)}.com` }));
  assert.equal(longUrl.status, 400);
  assert.match(longUrl.text, /no máximo 2048 caracteres/);

  const badResponsible = await agent
    .post('/requisicoes')
    .type('form')
    .send(validPayload({ responsible_id: 'abc' }));
  assert.equal(badResponsible.status, 400);
  assert.match(badResponsible.text, /Responsável inválido/);

  assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, before);
});

test('regular user cannot create requests', async () => {
  const agent = await user();
  const res = await agent.post('/requisicoes').type('form').send(validPayload());
  assert.equal(res.status, 403);
});

test('request detail page shows title, client and description', async () => {
  const agent = await user();
  const row = env.app.locals.db.prepare('SELECT id FROM requests WHERE title = ?').get('Nova integração API');
  const res = await agent.get(`/requisicoes/${row.id}`);

  assert.equal(res.status, 200);
  assert.match(res.text, /Nova integração API/);
  assert.match(res.text, /Descrição detalhada/);
  assert.match(res.text, /Acme Ltda|Globex S.A.|Initech/);
});

test('admin edits status, responsible and due date', async () => {
  const agent = await admin();
  const row = env.app.locals.db.prepare('SELECT id FROM requests WHERE title = ?').get('Nova integração API');
  const responsible = env.app.locals.db.prepare("SELECT id FROM users WHERE role = 'user'").get();

  const form = await agent.get(`/requisicoes/${row.id}/editar`);
  assert.equal(form.status, 200);

  // Ir para Em processo exige o relato "O que está sendo feito?".
  const refused = await agent.post(`/requisicoes/${row.id}/editar`).type('form').send(
    validPayload({ status: 'Em processo' }),
  );
  assert.equal(refused.status, 400);
  assert.match(refused.text, /É obrigatório preencher o campo/);
  // O relato precisa ser do ciclo de trabalho atual: primeiro o job entra em Em andamento.
  const started = await agent.post(`/requisicoes/${row.id}/editar`).type('form').send(
    validPayload({ status: 'Em andamento' }),
  );
  assert.equal(started.status, 302);
  await agent.post(`/requisicoes/${row.id}/comentarios`).type('form').send({ body: 'Integração em andamento' });

  const res = await agent.post(`/requisicoes/${row.id}/editar`).type('form').send(
    validPayload({
      status: 'Em processo',
      priority: 'Baixa',
      responsible_id: String(responsible.id),
      due_date: '2031-02-20',
    }),
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/requisicoes/${row.id}`);

  const updated = env.app.locals.db.prepare('SELECT * FROM requests WHERE id = ?').get(row.id);
  assert.equal(updated.status, 'Em processo');
  assert.equal(updated.priority, 'Baixa');
  assert.equal(updated.responsible_id, responsible.id);
  assert.equal(updated.due_date, '2031-02-20');
});

test('editing a client-approved job invalidates approvals and returns it to Em processo', async () => {
  const agent = await admin();
  const created = await agent
    .post('/requisicoes')
    .type('form')
    .send(validPayload({ title: 'Job aprovado para edição' }));
  assert.equal(created.status, 302);

  const row = env.app.locals.db
    .prepare('SELECT id FROM requests WHERE title = ?')
    .get('Job aprovado para edição');
  env.app.locals.db
    .prepare("UPDATE requests SET admin_approved_at = datetime('now'), client_approved_at = datetime('now') WHERE id = ?")
    .run(row.id);

  const res = await agent.post(`/requisicoes/${row.id}/editar`).type('form').send(
    validPayload({ title: 'Job aprovado para edição revisado', status: 'Aprovação' }),
  );
  assert.equal(res.status, 302);

  const updated = env.app.locals.db.prepare('SELECT * FROM requests WHERE id = ?').get(row.id);
  assert.equal(updated.status, 'Em processo');
  assert.equal(updated.admin_approved_at, null);
  assert.equal(updated.client_approved_at, null);
  assert.equal(updated.approval_token, null);
});

test('regular user cannot open the edit form or submit an edit', async () => {
  const agent = await user();
  const row = env.app.locals.db.prepare('SELECT id FROM requests LIMIT 1').get();
  assert.equal((await agent.get(`/requisicoes/${row.id}/editar`)).status, 403);
  assert.equal(
    (await agent.post(`/requisicoes/${row.id}/editar`).type('form').send(validPayload())).status,
    403,
  );
});
