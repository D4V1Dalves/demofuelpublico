const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { buildReport } = require('../src/reports');

async function loginAdmin(app, password = 'Admin@123') {
  const agent = request.agent(app);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password });
  assert.equal(res.status, 302);
  return agent;
}

test('token é invalidado quando o Admin devolve o job de Aprovação', async () => {
  const env = makeApp();
  try {
    const db = env.app.locals.db;
    const job = db.prepare("SELECT * FROM requests WHERE title = 'Proposta de campanha'").get();
    assert.equal(job.status, 'Aprovação');
    assert.ok(job.approval_token);

    const admin = await loginAdmin(env.app);
    const moved = await admin.post(`/requisicoes/${job.id}/status`).send({ status: 'Em andamento' });
    assert.equal(moved.status, 200);

    const after = db.prepare('SELECT * FROM requests WHERE id = ?').get(job.id);
    assert.equal(after.status, 'Em andamento');
    assert.equal(after.approval_token, null);
    assert.equal((await request(env.app).get(`/aprovacao/${job.approval_token}`)).status, 404);
    assert.equal(
      (await request(env.app).post(`/aprovacao/${job.approval_token}/aprovar`).type('form').send({}))
        .status,
      404,
    );
  } finally {
    env.cleanup();
  }
});

test('link público não decide um job que não está em Aprovação', async () => {
  const env = makeApp();
  try {
    const db = env.app.locals.db;
    const info = db
      .prepare(
        `INSERT INTO requests (client_id, title, description, status, priority, created_by, approval_token)
         VALUES (1, 'Fora da etapa', 'x', 'Novo', 'Média', 1, 'token-fora-da-etapa')`,
      )
      .run();
    const id = Number(info.lastInsertRowid);

    const res = await request(env.app)
      .post('/aprovacao/token-fora-da-etapa/aprovar')
      .type('form')
      .send({});
    assert.equal(res.status, 409);

    const after = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    assert.equal(after.status, 'Novo');
    assert.equal(after.client_approved_at, null);
    assert.equal(after.completed_at, null);
  } finally {
    env.cleanup();
  }
});

test('reaprovar um job Aprovado limpa completed_at', async () => {
  const env = makeApp();
  try {
    const db = env.app.locals.db;
    const job = db.prepare("SELECT * FROM requests WHERE title = 'Migração de dados'").get();
    assert.equal(job.status, 'Aprovado');
    assert.ok(job.completed_at);

    const admin = await loginAdmin(env.app);
    // Aprovar direto de Aprovado é recusado; o job precisa voltar para Em processo.
    assert.equal((await admin.post(`/requisicoes/${job.id}/aprovar`)).status, 400);
    assert.equal((await admin.post(`/requisicoes/${job.id}/status`).send({ status: 'Em processo' })).status, 200);
    const res = await admin.post(`/requisicoes/${job.id}/aprovar`);
    assert.equal(res.status, 302);

    const after = db.prepare('SELECT * FROM requests WHERE id = ?').get(job.id);
    assert.equal(after.status, 'Aprovação');
    assert.equal(after.completed_at, null);
  } finally {
    env.cleanup();
  }
});

test('concluídos do relatório ignoram completed_at de job que não está Aprovado', async () => {
  const env = makeApp();
  try {
    const db = env.app.locals.db;
    const seedJob = db.prepare("SELECT * FROM requests WHERE title = 'Migração de dados'").get();
    assert.equal(seedJob.status, 'Aprovado');

    // completed_at dentro do período, mas criado fora e com status não final.
    db.prepare(
      `INSERT INTO requests (client_id, title, description, status, priority, created_by,
         created_at, updated_at, completed_at)
       VALUES (1, 'Conclusão fantasma', 'x', 'Novo', 'Média', 1,
         '2026-10-01 10:00:00', '2026-11-10 10:00:00', '2026-11-10 10:00:00')`,
    ).run();

    const report = buildReport(db, { granularidade: 'mes', de: '2026-11-01', ate: '2026-11-30' });
    const inBars = report.buckets.reduce((sum, bucket) => sum + bucket.concluidos, 0);
    assert.equal(report.totals.concluidos, 1);
    assert.equal(inBars, 1, 'barras não podem contar job sem status Aprovado');
  } finally {
    env.cleanup();
  }
});

test('dashboard não quebra com status desconhecido no banco', { skip: process.env.TEST_MYSQL === '1' && 'no MySQL o CHECK de status já impede esse dado' }, async () => {
  const env = makeApp();
  try {
    const db = env.app.locals.db;
    db.prepare("UPDATE requests SET status = 'Fantasma' WHERE id = 1").run();
    const admin = await loginAdmin(env.app);
    const res = await admin.get('/dashboard');
    assert.equal(res.status, 200);
  } finally {
    env.cleanup();
  }
});

test('KPI Abertos exclui jobs rejeitados', async () => {
  const env = makeApp();
  try {
    const admin = await loginAdmin(env.app);
    const res = await admin.get('/dashboard/stats');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { total: 8, abertas: 6, concluidas: 1, atrasadas: 1 });
  } finally {
    env.cleanup();
  }
});

test('KPI Em atraso ignora jobs rejeitados mesmo com prazo vencido', async () => {
  const env = makeApp();
  try {
    const db = env.app.locals.db;
    const client = db.prepare('SELECT id FROM clients LIMIT 1').get();
    const author = db.prepare('SELECT id FROM users LIMIT 1').get();
    db.prepare(
      `INSERT INTO requests (client_id, title, description, status, priority, due_date,
                             created_by, created_at, updated_at)
       VALUES (?, ?, '', 'Rejeitado', 'Média', '2020-01-01', ?,
               datetime('now','localtime'), datetime('now','localtime'))`,
    ).run(client.id, 'Job rejeitado vencido', author.id);

    const admin = await loginAdmin(env.app);
    const res = await admin.get('/dashboard/stats');
    assert.equal(res.status, 200);
    assert.equal(res.body.atrasadas, 1, 'o rejeitado não pode inflar o KPI Em atraso');
  } finally {
    env.cleanup();
  }
});

test('trocar senha invalida sessões antigas e mantém a nova', async () => {
  const env = makeApp();
  try {
    const agent = request.agent(env.app);
    const login = await agent
      .post('/login')
      .type('form')
      .send({ email: 'admin@empresa.local', password: 'Admin@123' });
    assert.equal(login.status, 302);
    const oldCookie = (login.headers['set-cookie'] || [])[0].split(';')[0];

    const change = await agent.post('/perfil/senha').type('form').send({
      current_password: 'Admin@123',
      new_password: 'NovaSenha@123',
      confirm_password: 'NovaSenha@123',
    });
    assert.equal(change.status, 302);

    const stale = await request(env.app).get('/dashboard').set('Cookie', oldCookie);
    assert.equal(stale.status, 302);
    assert.equal(stale.headers.location, '/login');

    const relogin = await request(env.app)
      .post('/login')
      .type('form')
      .send({ email: 'admin@empresa.local', password: 'NovaSenha@123' });
    assert.equal(relogin.status, 302);
  } finally {
    env.cleanup();
  }
});
