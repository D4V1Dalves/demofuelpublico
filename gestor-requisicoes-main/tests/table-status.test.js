const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

const root = path.join(__dirname, '..');
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

test('admin edits the status straight from the main table', async () => {
  const agent = await admin();
  const res = await agent.get('/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /data-status-select/);
  assert.match(res.text, /class="status-select status-/);
  assert.match(res.text, /data-request-id="\d+"/);
  for (const status of ['Novo', 'Em andamento', 'Em processo', 'Aprovação', 'Aprovado', 'Rejeitado']) {
    assert.match(res.text, new RegExp(`<option value="${status}"`));
  }
});

test('a regular user sees the status pill instead of the editor', async () => {
  const agent = await user();
  const res = await agent.get('/dashboard');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /data-status-select/);
  assert.match(res.text, /status-pill/);
});

test('changing the status through the endpoint regroups the job', async () => {
  const agent = await admin();
  const db = env.app.locals.db;
  const job = db
    .prepare("SELECT * FROM requests WHERE status = 'Novo' AND title <> 'Ajuste no layout do portal' LIMIT 1")
    .get();
  assert.ok(job, 'a Novo job is required for this test');

  const res = await agent
    .post(`/requisicoes/${job.id}/status`)
    .send({ status: 'Em andamento' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, status: 'Em andamento' });

  const updated = db.prepare('SELECT status FROM requests WHERE id = ?').get(job.id);
  assert.equal(updated.status, 'Em andamento');

  const dashboard = await agent.get('/dashboard');
  const group = new RegExp(
    `data-status="Em andamento"[^>]*>[\\s\\S]*?data-request-id="${job.id}"`,
  );
  assert.match(dashboard.text, group);
});

test('the job rows carry a discreet stage tint while the group header stays compact', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.item-row td\s*\{[^}]*background:\s*var\(--group-row-tint\)/s);
  assert.match(css, /\.group-head td\s*\{[^}]*background:\s*var\(--surface-2\)/s);
  assert.match(css, /\.group-inner\s*\{[^}]*padding:\s*5px 10px/s);
  const tints = {
    Novo: [87, 155, 252],
    'Em andamento': [162, 93, 220],
    'Em processo': [139, 147, 166],
    Aprovação: [253, 171, 61],
    Aprovado: [0, 200, 117],
    Rejeitado: [250, 0, 2],
  };
  for (const [status, rgb] of Object.entries(tints)) {
    assert.match(
      css,
      new RegExp(
        `tbody\\.group\\[data-status="${status}"\\]\\s*\\{[^}]*--group-row-tint:\\s*rgba\\(${rgb.join(', ')},\\s*\\.0[6-8]\\)`,
        's',
      ),
      `missing discreet row tint for ${status}`,
    );
  }
  assert.match(css, /\.status-select\s*\{/);
});

test('the new logo and icon are shipped with the app', () => {
  const svgPath = path.join(root, 'public', 'logo-fuel.svg');
  assert.ok(fs.existsSync(svgPath), 'public/logo-fuel.svg must exist');
  const svg = fs.readFileSync(svgPath, 'utf8');
  assert.match(svg, /viewBox="0 0 615 280\.499991"/);
  assert.match(svg, /#fa0002/);

  const top = fs.readFileSync(path.join(root, 'views', 'partials', 'top.ejs'), 'utf8');
  assert.match(top, /class="brand-logo"/);
  assert.match(top, /src="\/static\/logo-fuel\.svg"/);
  assert.ok(fs.existsSync(path.join(root, 'public', 'favicon.png')));
});
