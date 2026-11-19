const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

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

const asAdmin = () => login('admin@empresa.local', 'Admin@123');
const asUser = () => login('usuario@empresa.local', 'Usuario@123');

test('admin dashboard renders the workspace shell with the admin section', async () => {
  const res = await (await asAdmin()).get('/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /class="app-shell"/);
  assert.match(res.text, /class="sidebar"/);
  assert.match(res.text, /href="\/agendamentos"/);
  assert.match(res.text, /href="\/configuracoes"/);
  assert.match(res.text, /Administrador/);
  // Usuários passou para Configurações; Clientes fica em Administração.
  const nav = res.text.slice(res.text.indexOf('Administração'));
  assert.match(nav, /href="\/clientes"/);
});

test('regular user dashboard hides the admin section and shows the user role', async () => {
  const res = await (await asUser()).get('/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /class="app-shell"/);
  assert.doesNotMatch(res.text, /href="\/usuarios"/);
  assert.doesNotMatch(res.text, /href="\/agendamentos"/);
  assert.match(res.text, /Usuário/);
});

test('dashboard renders the Monday-style main table and the kanban view', async () => {
  const res = await (await asAdmin()).get('/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /class="board-table"/);
  assert.match(res.text, /data-view="table"/);
  assert.match(res.text, /data-view="kanban"/);
  assert.match(res.text, /data-view-toggle="table"/);
  assert.match(res.text, /data-view-toggle="kanban"/);
  assert.match(res.text, /status-pill/);
  assert.doesNotMatch(res.text, /Adicionar item/);
  assert.match(res.text, /\+ Novo job/);
});

test('regular user does not get the add-item affordance', async () => {
  const res = await (await asUser()).get('/dashboard');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Adicionar item/);
  assert.doesNotMatch(res.text, /\+ Novo job/);
});

test('login page offers an admin/user role switch but a single real form', async () => {
  const res = await request(env.app).get('/login');
  assert.equal(res.status, 200);
  assert.match(res.text, /action="\/login"/);
  assert.match(res.text, /data-role-tab="admin"/);
  assert.match(res.text, /data-role-tab="user"/);
  assert.doesNotMatch(res.text, /type="password"[^>]*value=/);
});

test('item drawer returns a partial for authenticated users', async () => {
  const agent = await asAdmin();
  const job = env.app.locals.db.prepare('SELECT id, title FROM requests ORDER BY id LIMIT 1').get();
  const res = await agent.get(`/requisicoes/${job.id}/drawer`);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="drawer"/);
  assert.match(res.text, new RegExp(job.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(res.text, /<html/i);
  assert.doesNotMatch(res.text, /class="sidebar"/);
});

test('regular user can read a drawer but anonymous access redirects to login', async () => {
  const job = env.app.locals.db.prepare('SELECT id FROM requests ORDER BY id LIMIT 1').get();
  const anonymous = await request(env.app).get(`/requisicoes/${job.id}/drawer`);
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.location, '/login');

  const res = await (await asUser()).get(`/requisicoes/${job.id}/drawer`);
  assert.equal(res.status, 200);
});

test('new item link can preselect the status of a group', async () => {
  const res = await (await asAdmin()).get('/requisicoes/nova?status=Em%20processo');
  assert.equal(res.status, 200);
  assert.match(res.text, /value="Em processo" selected/);
});

test('my-work view lists only the jobs assigned to the logged user', async () => {
  const res = await (await asUser()).get('/dashboard?mine=1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Meu trabalho/);
  assert.match(res.text, /Ajuste no layout do portal/);
  assert.doesNotMatch(res.text, /Correção de login/);
  assert.doesNotMatch(res.text, /Revisão de contrato/);
});

test('admin my-work view lists only the admin jobs', async () => {
  const res = await (await asAdmin()).get('/dashboard?mine=1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Correção de login/);
  assert.doesNotMatch(res.text, /Ajuste no layout do portal/);
});

test('both roles get the my-work entry in the sidebar', async () => {
  for (const agent of [await asAdmin(), await asUser()]) {
    const res = await agent.get('/dashboard');
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/dashboard\?mine=1"/);
  }
});

test('stylesheet carries the Monday palette and status pill tokens', () => {
  for (const token of ['--canvas:', '--sidebar:', '--accent:', '--st-novo:', '--st-andamento:', '--st-aprovado:', '--st-rejeitado:']) {
    assert.match(css, new RegExp(token.replace(':', '\\s*:')), `missing token ${token}`);
  }
  assert.match(css, /--st-aprovado:\s*#00c875/i);
  assert.match(css, /--st-rejeitado:\s*#fa0002/i);
  assert.match(css, /\.board-table\s*\{/);
  assert.match(css, /\.status-pill\s*\{/);
  assert.match(css, /\.app-shell\s*\{/);
});
