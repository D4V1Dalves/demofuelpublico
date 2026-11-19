const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

let env;
before(() => {
  env = makeApp();
});
after(() => {
  env.cleanup();
});

async function login(role = 'admin') {
  const agent = request.agent(env.app);
  const credentials =
    role === 'admin'
      ? { email: 'admin@empresa.local', password: 'Admin@123' }
      : { email: 'usuario@empresa.local', password: 'Usuario@123' };
  assert.equal((await agent.post('/login').type('form').send(credentials)).status, 302);
  return agent;
}

test('board.js move o card no DOM sem recarregar a página', () => {
  const board = read('public/board.js');
  assert.doesNotMatch(board, /location\.reload/);
  assert.match(board, /\/dashboard\/stats/);
  assert.match(board, /appendChild|insertAdjacentElement/);
  assert.match(board, /kpi-number/);
  assert.match(board, /\.count/);
});

test('board.js preserva o filtro Meu trabalho ao atualizar os KPIs', () => {
  const board = read('public/board.js');
  assert.match(board, /URLSearchParams\(window\.location\.search\)/);
  assert.match(board, /mine \? '\?mine=1' : ''/);
});

test('GET /dashboard/stats exige login e devolve os números globais', async () => {
  assert.equal((await request(env.app).get('/dashboard/stats')).status, 302);
  const admin = await login();
  const res = await admin.get('/dashboard/stats');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { total: 8, abertas: 6, concluidas: 1, atrasadas: 1 });
});

test('GET /dashboard/stats?mine=1 devolve apenas os jobs do usuário logado', async () => {
  const agent = await login('user');
  const me = env.app.locals.db
    .prepare("SELECT id FROM users WHERE email = 'usuario@empresa.local'")
    .get();
  const row = env.app.locals.db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status NOT IN ('Aprovado','Rejeitado') THEN 1 ELSE 0 END) AS abertas,
              SUM(CASE WHEN status = 'Aprovado' THEN 1 ELSE 0 END) AS concluidas,
              SUM(CASE WHEN status NOT IN ('Aprovado','Rejeitado') AND due_date IS NOT NULL
                       AND due_date < date('now','localtime') THEN 1 ELSE 0 END) AS atrasadas
       FROM requests WHERE responsible_id = ?`,
    )
    .get(me.id);

  const res = await agent.get('/dashboard/stats?mine=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    total: Number(row.total || 0),
    abertas: Number(row.abertas || 0),
    concluidas: Number(row.concluidas || 0),
    atrasadas: Number(row.atrasadas || 0),
  });

  const global = await agent.get('/dashboard/stats');
  assert.ok(global.body.total > res.body.total, 'o escopo "meu" deve ser menor que o global');
});

test('shell separa navegação, busca e ações do usuário', () => {
  const top = read('views/partials/top.ejs');
  assert.match(top, /class="app-shell"/);
  assert.match(top, /class="sidebar"/);
  const nav = /<nav class="side-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(top);
  assert.ok(nav, 'o shell precisa de um <nav> lateral');
  assert.doesNotMatch(nav[1], /Sair/);
  assert.match(nav[1], /href="\/clientes"/);
  assert.match(top, /class="bar-actions"[\s\S]*type="submit">Sair/);

  const css = read('public/styles.css');
  assert.match(css, /\.app-shell\s*\{[^}]*grid-template-columns:\s*244px minmax\(0, 1fr\)/s);
  assert.match(css, /\.sidebar\s*\{[^}]*background:\s*var\(--sidebar\)/s);
  assert.match(css, /\.bar-actions\s*\{[^}]*margin-left:\s*auto/s);
});

test('KPIs têm cores próprias e acento lateral', async () => {
  const dashboard = read('views/dashboard.ejs');
  for (const name of ['kpi-total', 'kpi-open', 'kpi-late', 'kpi-done']) {
    assert.match(dashboard, new RegExp(name));
  }
  const css = read('public/styles.css');
  assert.match(css, /\.kpi\s*\{[^}]*border-radius:\s*var\(--radius\)/s);
  assert.match(css, /\.kpi::after\s*\{[^}]*background:\s*var\(--kpi-accent\)/s);
  for (const name of ['kpi-total', 'kpi-open', 'kpi-late', 'kpi-done']) {
    assert.match(css, new RegExp(`\\.${name}\\s*\\{[^}]*--kpi-accent:`, 's'));
  }
});

test('cada coluna do quadro tem um acento distinto', () => {
  const css = read('public/styles.css');
  const expected = {
    Novo: '--stage-accent:',
    'Em andamento': '--stage-accent:',
    'Em processo': '--stage-accent:',
    Aprovação: '--stage-accent:',
    Rejeitado: '--stage-accent:',
    Aprovado: '--stage-accent:',
  };
  const colors = new Set();
  for (const status of Object.keys(expected)) {
    const pattern = new RegExp(
      `\\.column\\[data-status="${status}"\\]\\s*\\{[^}]*--stage-accent:\\s*([^;]+);`,
      's',
    );
    const match = pattern.exec(css);
    assert.ok(match, `sem acento para ${status}`);
    colors.add(match[1].trim());
  }
  assert.equal(colors.size, 6, 'as seis colunas precisam de cores diferentes');
  assert.match(css, /\.column-head\s*\{[^}]*border-top:\s*3px solid var\(--stage-accent\)/s);
});

test('animação e fundo foram suavizados mantendo os hooks de design', () => {
  const css = read('public/styles.css');
  assert.match(css, /animation:\s*fuel-in\s*\.3s/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /radial-gradient/);
  assert.match(css, /data:image\/svg\+xml/);
  assert.match(css, /backdrop-filter/);
});
