const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { approvalStrings } = require('../src/i18n');

let env;
before(() => { env = makeApp(); });
after(() => { env.cleanup(); });
const db = () => env.app.locals.db;

function jobInApproval(title) {
  const id = Number(
    db().prepare(
      `INSERT INTO requests (client_id, title, description, status, priority, created_by, approval_token, admin_approved_at, due_date)
       VALUES (1, ?, 'Relatório escrito em português pela equipe.', 'Aprovação', 'Alta', 1, ?, '2026-11-18 10:00:00', '2026-11-22')`,
    ).run(title, `tok${title.replace(/\W/g, '')}`).lastInsertRowid,
  );
  db().prepare("INSERT INTO comments (request_id, user_id, body) VALUES (?, 1, 'Comentário em português da equipe')").run(id);
  return db().prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

test('link em inglês: interface em inglês, conteúdo no idioma original', async () => {
  const job = jobInApproval('Campanha EN');
  const res = await request(env.app).get(`/aprovacao/${job.approval_token}?lang=en`);
  assert.equal(res.status, 200);
  assert.match(res.text, /<html lang="en"/);
  for (const text of ['Approval link', 'Approve this job?', 'Your decision', 'Awaiting approval', 'High', 'Report of the work done', 'Timeline', 'Reject job', 'Nov 22, 2026', 'Dark theme']) {
    assert.ok(res.text.includes(text), `faltou "${text}"`);
  }
  // Conteúdo escrito pela equipe continua em português.
  assert.match(res.text, /Relatório escrito em português pela equipe\./);
  assert.match(res.text, /Comentário em português da equipe/);
  // Nenhum rótulo da interface em português.
  for (const text of ['Link de aprovação', 'Aprovar este job?', 'Sua decisão', 'Linha do tempo', 'Rejeitar job', 'Tema escuro']) {
    assert.ok(!res.text.includes(text), `sobrou "${text}"`);
  }
  // Os formulários mantêm o idioma.
  assert.match(res.text, new RegExp(`action="/aprovacao/${job.approval_token}/aprovar\\?lang=en"`));
  assert.match(res.text, new RegExp(`action="/aprovacao/${job.approval_token}/rejeitar\\?lang=en"`));
});

test('link padrão continua em português', async () => {
  const job = jobInApproval('Campanha PT');
  const res = await request(env.app).get(`/aprovacao/${job.approval_token}`);
  assert.match(res.text, /<html lang="pt-BR"/);
  assert.match(res.text, /Aprovar este job\?/);
  assert.match(res.text, /22\/11\/2026/);
  // Idioma desconhecido cai no português.
  assert.match((await request(env.app).get(`/aprovacao/${job.approval_token}?lang=xx`)).text, /Aprovar este job\?/);
});

test('rejeição em inglês: erro e resultado em inglês, motivo guardado como escrito', async () => {
  const job = jobInApproval('Rejeita EN');
  const empty = await request(env.app).post(`/aprovacao/${job.approval_token}/rejeitar?lang=en`).type('form').send({ reason: ' ' });
  assert.equal(empty.status, 400);
  assert.match(empty.text, /Please tell us why you are rejecting it\./);

  const res = await request(env.app).post(`/aprovacao/${job.approval_token}/rejeitar?lang=en`).type('form').send({ reason: 'Trocar a cor do logo' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Job rejected/);
  assert.match(res.text, /Trocar a cor do logo/);
  assert.equal(db().prepare('SELECT client_rejection_reason FROM requests WHERE id = ?').get(job.id).client_rejection_reason, 'Trocar a cor do logo');
});

test('aprovação em inglês e link inválido em inglês', async () => {
  const job = jobInApproval('Aprova EN');
  const res = await request(env.app).post(`/aprovacao/${job.approval_token}/aprovar?lang=en`).type('form').send({});
  assert.equal(res.status, 200);
  assert.match(res.text, /Job approved/);
  assert.match(res.text, /Approved and completed/);
  assert.equal((await request(env.app).get('/aprovacao/naoexiste?lang=en')).text, 'Invalid approval link.');
});

test('página do job mostra os links em português e em inglês', async () => {
  const job = jobInApproval('Dois links');
  const agent = request.agent(env.app);
  await agent.post('/login').type('form').send({ email: 'admin@empresa.local', password: 'Admin@123' });
  const page = await agent.get(`/requisicoes/${job.id}`);
  assert.match(page.text, /Link de aprovação em português/);
  assert.match(page.text, /Link de aprovação em inglês/);
  assert.match(page.text, new RegExp(`/aprovacao/${job.approval_token}\\?lang=en`));
});

test('todo texto em português tem tradução para o inglês', () => {
  const pt = approvalStrings('pt');
  const en = approvalStrings('en');
  for (const key of Object.keys(pt)) assert.ok(key in en, `faltou a chave ${key} em inglês`);
  for (const status of ['Novo', 'Em andamento', 'Em processo', 'Aprovação', 'Aprovado', 'Rejeitado']) {
    assert.notEqual(en.statusName(status), status);
  }
  assert.equal(en.fmtDateTime('2026-11-19 08:08:58'), 'Nov 19, 2026 at 08:08');
});
