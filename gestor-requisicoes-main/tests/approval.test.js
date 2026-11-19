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

async function login(email, password) {
  const agent = request.agent(env.app);
  const res = await agent.post('/login').type('form').send({ email, password });
  assert.equal(res.status, 302);
  return agent;
}
const admin = () => login('admin@empresa.local', 'Admin@123');
const user = () => login('usuario@empresa.local', 'Usuario@123');

// Só um job com o trabalho concluído pela equipe (Em processo) pode ser aprovado.
const toReview = (title) =>
  db().prepare("UPDATE requests SET status = 'Em processo' WHERE title = ?").run(title);

async function approveAsAdmin(title) {
  const agent = await admin();
  toReview(title);
  const job = byTitle(title);
  const res = await agent.post(`/requisicoes/${job.id}/aprovar`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/requisicoes/${job.id}`);
  return byTitle(title);
}

test('admin sees an Aprovar button on a job in Em processo', async () => {
  const agent = await admin();
  toReview('Ajuste no layout do portal');
  const job = byTitle('Ajuste no layout do portal');
  const res = await agent.get(`/requisicoes/${job.id}`);

  assert.equal(res.status, 200);
  assert.match(res.text, /Aprovar/);
});

test('regular user does not see the Aprovar button', async () => {
  const agent = await user();
  const job = byTitle('Ajuste no layout do portal');
  const res = await agent.get(`/requisicoes/${job.id}`);

  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Aprovar/);
});

test('admin approval records timestamp, creates token and moves job to Aprovação', async () => {
  const updated = await approveAsAdmin('Ajuste no layout do portal');

  assert.ok(updated.admin_approved_at, 'admin approval timestamp should be set');
  assert.equal(updated.status, 'Aprovação');
  assert.match(updated.approval_token, /^[0-9a-f]{64}$/);
});

test('admin detail page exposes the public approval link after approval', async () => {
  const agent = await admin();
  const job = byTitle('Ajuste no layout do portal');
  const res = await agent.get(`/requisicoes/${job.id}`);

  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`/aprovacao/${job.approval_token}`));
  // O link é somente leitura e só existe como cópia: sem âncora navegável.
  assert.match(res.text, /id="approval-link-input"[^>]*readonly/);
  assert.match(res.text, /data-copy-target="#approval-link-input"/);
  assert.match(res.text, /Copiar link/);
  assert.doesNotMatch(res.text, new RegExp(`href="/aprovacao/${job.approval_token}"`));
});

test('tela pública de aprovação é full screen, sem sidebar', async () => {
  const token = byTitle('Ajuste no layout do portal').approval_token;
  const res = await request(env.app).get(`/aprovacao/${token}`);

  assert.equal(res.status, 200);
  assert.match(res.text, /approval-screen/);
  assert.match(res.text, /approval-aside/);
  assert.doesNotMatch(res.text, /class="sidebar"/);
  assert.doesNotMatch(res.text, /class="app-shell"/);
});

test('o link de aprovação abre como documento isolado mesmo numa sessão logada', async () => {
  const agent = await admin();
  const token = byTitle('Ajuste no layout do portal').approval_token;
  const res = await agent.get(`/aprovacao/${token}`);

  assert.equal(res.status, 200);
  // Nem sidebar, nem shell do app: o cliente vê só o documento.
  assert.doesNotMatch(res.text, /class="sidebar"/);
  assert.doesNotMatch(res.text, /class="app-shell"/);
  // A marca é estática e não existe rodapé nem atalho de navegação interna.
  assert.doesNotMatch(res.text, /<a[^>]+class="approval-brand"/);
  assert.doesNotMatch(res.text, /approval-foot/);
  assert.doesNotMatch(
    res.text,
    /href="\/(dashboard|clientes|relatorios|perfil|requisicoes|usuarios|agendamentos|login)(?:[\"/?])/,
  );
});

test('public approval link with an unknown token returns 404', async () => {
  const res = await request(env.app).get('/aprovacao/token-inexistente');
  assert.equal(res.status, 404);
});

test('public approval page shows the job without requiring login', async () => {
  const token = byTitle('Ajuste no layout do portal').approval_token;
  const res = await request(env.app).get(`/aprovacao/${token}`);

  assert.equal(res.status, 200);
  assert.match(res.text, /Ajuste no layout do portal/);
  assert.match(res.text, /Aprovar/);
  assert.match(res.text, /Rejeitar/);
});

test('approval card asks for inline confirmation before submitting', async () => {
  const token = byTitle('Ajuste no layout do portal').approval_token;
  const res = await request(env.app).get(`/aprovacao/${token}`);

  assert.equal(res.status, 200);
  assert.match(res.text, /data-decision-card/);
  assert.match(res.text, /action="\/aprovacao\/[^"]+\/aprovar"[^>]*data-approve-form/);
  assert.match(res.text, /data-approve-start/);
  assert.match(res.text, /data-approve-step="confirm"[^>]*hidden/);
  assert.match(res.text, /data-approve-confirm/);
  assert.match(res.text, /data-approve-cancel/);
  assert.match(res.text, /Confirmar aprovação\?/);
});

test('client approves through the public link', async () => {
  const token = byTitle('Ajuste no layout do portal').approval_token;
  const res = await request(env.app).post(`/aprovacao/${token}/aprovar`);

  assert.equal(res.status, 200);
  assert.match(res.text, /aprovado/i);

  const updated = byTitle('Ajuste no layout do portal');
  assert.ok(updated.client_approved_at, 'client approval timestamp should be set');
  assert.equal(updated.status, 'Aprovado');
});

test('client rejection with a reason moves the job to Rejeitado', async () => {
  await approveAsAdmin('Treinamento da equipe');
  const token = byTitle('Treinamento da equipe').approval_token;

  const res = await request(env.app)
    .post(`/aprovacao/${token}/rejeitar`)
    .type('form')
    .send({ reason: 'O prazo não atende nossa equipe.' });

  assert.equal(res.status, 200);
  const updated = byTitle('Treinamento da equipe');
  assert.equal(updated.status, 'Rejeitado');
  assert.ok(updated.client_rejected_at);
  assert.equal(updated.client_rejection_reason, 'O prazo não atende nossa equipe.');
  assert.equal(updated.client_approved_at, null);
});

test('client rejection without a reason is rejected with 400', async () => {
  const job = byTitle('Revisão de contrato');
  const res = await request(env.app)
    .post(`/aprovacao/${job.approval_token}/rejeitar`)
    .type('form')
    .send({ reason: '   ' });

  assert.equal(res.status, 400);
  assert.match(res.text, /motivo/i);
  assert.equal(byTitle('Revisão de contrato').status, 'Rejeitado');
});

test('após rejeição o job volta para ajustes antes de um novo Aprovar', async () => {
  const agent = await admin();
  const job = byTitle('Treinamento da equipe');
  const res = await agent.get(`/requisicoes/${job.id}`);

  assert.equal(res.status, 200);
  assert.ok(job.client_rejected_at, 'job should be rejected at this point');
  assert.doesNotMatch(res.text, /Aprovar e enviar/);
  assert.match(res.text, /volte o job para Em andamento/);
  // Rejeitado direto para Aprovação não é permitido.
  const moved = await agent.post(`/requisicoes/${job.id}/status`).send({ status: 'Aprovação' });
  assert.equal(moved.status, 400);
});

test('re-approval generates a new token and invalidates the old one', async () => {
  const oldToken = byTitle('Treinamento da equipe').approval_token;
  const updated = await approveAsAdmin('Treinamento da equipe');

  assert.notEqual(updated.approval_token, oldToken);
  assert.equal(updated.status, 'Aprovação');
  assert.equal(updated.client_rejected_at, null);
  assert.equal(updated.client_rejection_reason, null);

  const oldLink = await request(env.app).get(`/aprovacao/${oldToken}`);
  assert.equal(oldLink.status, 404);
  const newLink = await request(env.app).get(`/aprovacao/${updated.approval_token}`);
  assert.equal(newLink.status, 200);
});
