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
const byTitle = (title) => db().prepare('SELECT * FROM requests WHERE title = ?').get(title);
const DROPBOX_URL = 'https://www.dropbox.com/s/abc123/briefing?dl=0';

async function login(email, password) {
  const agent = request.agent(env.app);
  const res = await agent.post('/login').type('form').send({ email, password });
  assert.equal(res.status, 302);
  return agent;
}
const admin = () => login('admin@empresa.local', 'Admin@123');
const user = () => login('usuario@empresa.local', 'Usuario@123');

function payload(overrides = {}) {
  return {
    client_id: String(db().prepare('SELECT id FROM clients LIMIT 1').get().id),
    title: 'Job com Dropbox',
    description: 'Briefing no Dropbox',
    status: 'Novo',
    priority: 'Média',
    responsible_id: '',
    due_date: '2030-05-10',
    ...overrides,
  };
}

test('admin creates a job with a Dropbox link', async () => {
  const agent = await admin();
  const res = await agent.post('/requisicoes').type('form').send(payload({ dropbox_url: DROPBOX_URL }));

  assert.equal(res.status, 302);
  assert.equal(byTitle('Job com Dropbox').dropbox_url, DROPBOX_URL);
});

test('a non-http Dropbox URL is rejected with 400', async () => {
  const agent = await admin();
  const before = db().prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  const res = await agent
    .post('/requisicoes')
    .type('form')
    .send(payload({ title: 'Job com link inválido', dropbox_url: 'javascript:alert(1)' }));

  assert.equal(res.status, 400);
  assert.match(res.text, /Dropbox|URL/i);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM requests').get().n, before);
});

test('the Dropbox link is optional and local uploads remain available', async () => {
  const agent = await admin();
  const res = await agent.post('/requisicoes').type('form').send(payload({ title: 'Job sem Dropbox' }));

  assert.equal(res.status, 302);
  const row = byTitle('Job sem Dropbox');
  assert.ok(!row.dropbox_url);
});

test('job detail shows the Dropbox link alongside the attachments section', async () => {
  const agent = await user();
  const job = byTitle('Job com Dropbox');
  const res = await agent.get(`/requisicoes/${job.id}`);

  assert.equal(res.status, 200);
  assert.match(res.text, /www\.dropbox\.com\/s\/abc123\/briefing/);
  assert.match(res.text, /Anexos/);
  assert.match(res.text, /Dropbox/);
});

test('a local attachment still works when the job also has a Dropbox link', async () => {
  const agent = await user();
  const job = byTitle('Job com Dropbox');
  const res = await agent
    .post(`/requisicoes/${job.id}/anexos`)
    .attach('file', Buffer.from('%PDF-1.4 anexo local'), 'anexo.pdf');

  assert.equal(res.status, 302);
  const page = await agent.get(`/requisicoes/${job.id}`);
  assert.match(page.text, /anexo\.pdf/);
  assert.match(page.text, /www\.dropbox\.com/);
});

test('admin can update the Dropbox link when editing a job', async () => {
  const agent = await admin();
  const job = byTitle('Job sem Dropbox');
  const res = await agent.post(`/requisicoes/${job.id}/editar`).type('form').send(
    payload({ title: 'Job sem Dropbox', dropbox_url: 'https://dl.dropboxusercontent.com/s/xyz/plano.xlsx' }),
  );

  assert.equal(res.status, 302);
  assert.equal(byTitle('Job sem Dropbox').dropbox_url, 'https://dl.dropboxusercontent.com/s/xyz/plano.xlsx');
});

test('seeded jobs with a Dropbox link display it', async () => {
  const agent = await user();
  const job = byTitle('Migração de dados');
  const res = await agent.get(`/requisicoes/${job.id}`);

  assert.equal(res.status, 200);
  assert.match(res.text, /www\.dropbox\.com\/s\/exemplo\/migracao/);
});
