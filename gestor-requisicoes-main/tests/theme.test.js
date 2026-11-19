const fs = require('node:fs');
const path = require('node:path');
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

async function loginAdmin() {
  const agent = request.agent(env.app);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });
  assert.equal(res.status, 302);
  return agent;
}

test('login page is branded as Fuel Jobs', async () => {
  const res = await request(env.app).get('/login');
  assert.equal(res.status, 200);
  assert.match(res.text, /Fuel Jobs/);
});

test('dashboard is branded and uses the board-page layout', async () => {
  const agent = await loginAdmin();
  const res = await agent.get('/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /<body class="board-page">/);
  assert.match(res.text, /class="brand-logo"[^>]*src="\/static\/logo-fuel\.svg"/);
  assert.match(res.text, /alt="Fuel Jobs"/);
  assert.match(res.text, /<h1>Fuel Jobs<\/h1>/);
});

test('dashboard renders the six status columns', async () => {
  const agent = await loginAdmin();
  const res = await agent.get('/dashboard');
  for (const column of ['Novo', 'Em andamento', 'Em processo', 'Aprovação', 'Rejeitado', 'Aprovado']) {
    assert.match(res.text, new RegExp(column), `missing column ${column}`);
  }
});

test('theme switch rises a wave in the color of the chosen theme', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  assert.doesNotMatch(css, /\.theme-wash/);
  assert.match(css, /@keyframes theme-wave-rise/);
  assert.match(css, /@keyframes theme-wave-flow/);
  // A onda tem a cor de fundo do tema de destino.
  assert.match(css, /\.theme-wave\.is-to-dark\s*\{[^}]*--wave-color:\s*#05070b/s);
  assert.match(css, /\.theme-wave\.is-to-light\s*\{[^}]*--wave-color:\s*#f6f7fb/s);
  assert.match(css, /mask:\s*url\("data:image\/svg\+xml/);

  assert.match(app, /switchTheme/);
  assert.match(app, /theme-wave is-to-\$\{next\}/);
  assert.match(app, /prefers-reduced-motion/);
  assert.match(app, /data-theme-choice/);
});

test('stylesheet uses the Monday-style palette and a viewport-height board', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /--canvas:\s*#f6f7fb/i);
  assert.match(css, /--accent:\s*#fa0002/i);
  assert.match(css, /--ink:\s*#323338/i);
  assert.match(css, /--brand:\s*#fa0002/i);
  assert.match(css, /body\.board-page\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /height:\s*100vh/);
});

test('stylesheet ships a dark theme and no legacy blue accent', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /html\[data-theme="dark"\]\s*\{/);
  assert.match(css, /--accent:\s*#fa0002/i);
  assert.doesNotMatch(css, /#0073ea/i);
  assert.doesNotMatch(css, /rgba\(0,\s*115,\s*234/i);
});

test('pages default to the dark theme, expose a toggle and apply it before paint', async () => {
  const agent = await loginAdmin();
  const res = await agent.get('/dashboard');
  assert.match(res.text, /<html lang="pt-BR" data-theme="dark">/);
  assert.match(res.text, /fuel-theme/);
  assert.match(res.text, /Novo job/);
  // O tema é escolhido em Configurações > Aparência.
  assert.match(res.text, /href="\/configuracoes"/);
  const settings = await agent.get('/configuracoes');
  assert.equal(settings.status, 200);
  assert.match(settings.text, /data-theme-choice="dark"/);
  assert.match(settings.text, /data-theme-choice="light"/);
});

test('sidebar lists clients and a new job can register a client inline', async () => {
  const agent = await loginAdmin();
  const created = await agent.post('/requisicoes').type('form').send({
    title: 'Job sidebar client',
    new_client_name: 'Cliente Sidebar QA',
    status: 'Novo',
    priority: 'Média',
  });
  assert.equal(created.status, 302);

  const dashboard = await agent.get('/dashboard');
  assert.match(dashboard.text, /Cliente Sidebar QA/);
  assert.match(dashboard.text, /side-client/);

  const db = env.app.locals.db;
  const client = db.prepare('SELECT * FROM clients WHERE name = ?').get('Cliente Sidebar QA');
  assert.ok(client, 'client should exist');
  const job = db.prepare('SELECT * FROM requests WHERE title = ?').get('Job sidebar client');
  assert.ok(job, 'job should exist');
  assert.equal(job.client_id, client.id);
});

