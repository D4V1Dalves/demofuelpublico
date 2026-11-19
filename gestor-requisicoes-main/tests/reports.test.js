const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { buildReport } = require('../src/reports');

let env;
before(() => {
  env = makeApp();
  // Relatórios são testados sobre uma coorte conhecida: removemos os jobs do seed,
  // que usam a data corrente e entrariam no intervalo de novembro de 2026.
  env.app.locals.db.prepare('DELETE FROM requests').run();
});
after(() => { env.cleanup(); });

async function login(role = 'admin') {
  const agent = request.agent(env.app);
  const credentials = role === 'admin'
    ? { email: 'admin@empresa.local', password: 'Admin@123' }
    : { email: 'usuario@empresa.local', password: 'Usuario@123' };
  assert.equal((await agent.post('/login').type('form').send(credentials)).status, 302);
  return agent;
}

function addJob(db, { createdAt, status = 'Novo', completedAt = null, clientId = 1, title = 'Job' }) {
  const info = db.prepare(`
    INSERT INTO requests (client_id, title, description, status, priority, created_by, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, 'Média', 1, ?, ?, ?)
  `).run(clientId, title, 'Descrição', status, createdAt, createdAt, completedAt);
  return Number(info.lastInsertRowid);
}

test('buildReport separa abertos, concluídos e rejeitados no período', () => {
  const db = env.app.locals.db;
  addJob(db, { createdAt: '2026-11-05 10:00:00', title: 'Aberto' });
  addJob(db, { createdAt: '2026-11-10 10:00:00', status: 'Aprovado', completedAt: '2026-11-12 10:00:00', title: 'Fechado' });
  addJob(db, { createdAt: '2026-11-15 10:00:00', status: 'Rejeitado', title: 'Rejeitado' });
  addJob(db, { createdAt: '2026-10-01 10:00:00', title: 'Fora' });
  addJob(db, { createdAt: '2026-10-20 10:00:00', status: 'Aprovado', completedAt: '2026-11-16 10:00:00', title: 'Concluído fora' });

  const report = buildReport(db, { granularidade: 'mes', de: '2026-11-01', ate: '2026-11-30' });
  assert.equal(report.totals.total, 3);
  assert.equal(report.totals.abertos, 1);
  assert.equal(report.totals.concluidos, 1);
  assert.equal(report.totals.rejeitados, 1);
  assert.equal(report.pie.length, 3);
  assert.deepEqual(report.pie.map((s) => s.key), ['abertos', 'concluidos', 'rejeitados']);
  assert.ok(report.pie.every((s) => s.path.startsWith('M')));

  assert.equal(report.buckets.length, 1);
  assert.equal(report.buckets[0].key, '2026-11');
  assert.equal(report.buckets[0].criados, 3);
  assert.equal(report.buckets[0].concluidos, 2);
  assert.equal(report.buckets[0].abertos, 1);
  assert.equal(report.buckets[0].rejeitados, 1);
});

test('buildReport agrupa por dia, semana, mês e ano', () => {
  const db = env.app.locals.db;
  const scopes = [
    ['dia', '2026-11-05'],
    ['semana', /^\d{4}-W\d{2}$/],
    ['mes', '2026-11'],
    ['ano', '2026'],
  ];
  for (const [granularidade, expected] of scopes) {
    const report = buildReport(db, { granularidade, de: '2026-11-01', ate: '2026-11-30' });
    assert.ok(report.buckets.length > 0, `sem buckets para ${granularidade}`);
    const key = report.buckets[0].key;
    if (expected instanceof RegExp) assert.match(key, expected);
    else assert.equal(key, expected);
    assert.ok(report.buckets[0].label);
  }
});

test('buildReport aplica filtro de cliente e rejeita intervalo invertido', () => {
  const db = env.app.locals.db;
  const clientId = Number(db.prepare('SELECT id FROM clients ORDER BY id LIMIT 1 OFFSET 1').get().id);
  addJob(db, { createdAt: '2026-11-20 10:00:00', clientId, title: 'Outro cliente' });

  const all = buildReport(db, { granularidade: 'mes', de: '2026-11-01', ate: '2026-11-30' });
  const filtered = buildReport(db, { granularidade: 'mes', de: '2026-11-01', ate: '2026-11-30', cliente: clientId });
  assert.ok(filtered.totals.total < all.totals.total);
  assert.equal(filtered.totals.total, 1);
  assert.throws(() => buildReport(db, { granularidade: 'mes', de: '2026-12-01', ate: '2026-11-01' }), /intervalo/i);
});

test('relatórios é acessível a usuários e exibe pizza, barras e tabela', async () => {
  const user = await login('user');
  const res = await user.get('/relatorios?granularidade=mes&de=2026-11-01&ate=2026-11-30');
  assert.equal(res.status, 200);
  assert.match(res.text, /Relatórios/);
  assert.match(res.text, /<svg/);
  assert.match(res.text, /grafico-pizza/i);
  assert.match(res.text, /grafico-barras/i);
  assert.match(res.text, /<table/);
  assert.match(res.text, /Abertos/);
  assert.match(res.text, /Concluídos/);
  assert.match(res.text, /Rejeitados/);
  assert.match(res.text, /Criados/);
});

test('relatórios exige login e rejeita datas inválidas', async () => {
  assert.equal((await request(env.app).get('/relatorios')).status, 302);
  const admin = await login();
  assert.equal((await admin.get('/relatorios?de=2026-12-01&ate=2026-11-01')).status, 400);
  assert.equal((await admin.get('/relatorios?de=triangular&ate=2026-11-01')).status, 400);
});

test('concluir um job registra completed_at', async () => {
  const db = env.app.locals.db;
  const id = addJob(db, { createdAt: '2026-11-21 10:00:00', title: 'Para concluir' });
  db.prepare("UPDATE requests SET admin_approved_at = datetime('now'), client_approved_at = datetime('now') WHERE id = ?").run(id);
  const admin = await login();
  const res = await admin.post(`/requisicoes/${id}/status`).type('form').send({ status: 'Aprovado' });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT status, completed_at FROM requests WHERE id = ?').get(id);
  assert.equal(row.status, 'Aprovado');
  assert.ok(row.completed_at);
});

test('aprovar mantém o link público, bloqueia nova decisão e rejeitar limpa completed_at', async () => {
  const db = env.app.locals.db;
  const id = addJob(db, { createdAt: '2026-11-22 10:00:00', title: 'Ciclo completo' });
  const token = `token-ciclo-${id}`;
  db.prepare(
    "UPDATE requests SET admin_approved_at = datetime('now'), client_approved_at = datetime('now'), approval_token = ? WHERE id = ?",
  ).run(token, id);
  assert.equal((await request(env.app).get(`/aprovacao/${token}`)).status, 200);

  const admin = await login();
  assert.equal(
    (await admin.post(`/requisicoes/${id}/status`).type('form').send({ status: 'Aprovado' })).status,
    200,
  );
  assert.equal(db.prepare('SELECT approval_token FROM requests WHERE id = ?').get(id).approval_token, token);
  assert.equal((await request(env.app).get(`/aprovacao/${token}`)).status, 200);

  // Decisão já tomada: o link serve apenas para consulta.
  const late = await request(env.app)
    .post(`/aprovacao/${token}/rejeitar`)
    .type('form')
    .send({ reason: 'Revogado após conclusão.' });
  assert.equal(late.status, 200);
  assert.match(late.text, /Aprovado/i);
  const unchanged = db.prepare('SELECT status, completed_at FROM requests WHERE id = ?').get(id);
  assert.equal(unchanged.status, 'Aprovado');
  assert.ok(unchanged.completed_at);

  // Job ainda pendente: rejeitar limpa o completed_at.
  const pendingId = addJob(db, { createdAt: '2026-11-23 10:00:00', title: 'Rejeição limpa conclusão' });
  const pendingToken = `token-rejeicao-${pendingId}`;
  db.prepare(
    "UPDATE requests SET status = 'Aprovação', approval_token = ?, completed_at = datetime('now') WHERE id = ?",
  ).run(pendingToken, pendingId);
  const rejected = await request(env.app)
    .post(`/aprovacao/${pendingToken}/rejeitar`)
    .type('form')
    .send({ reason: 'Revogado.' });
  assert.equal(rejected.status, 200);
  const row = db.prepare('SELECT status, completed_at FROM requests WHERE id = ?').get(pendingId);
  assert.equal(row.status, 'Rejeitado');
  assert.equal(row.completed_at, null);
});

test('navegação mostra Relatórios para todos e Agendamentos só para admin', async () => {
  const userPage = await (await login('user')).get('/dashboard');
  assert.match(userPage.text, /href="\/relatorios"/);
  assert.doesNotMatch(userPage.text, /href="\/agendamentos"/);

  const adminPage = await (await login()).get('/dashboard');
  assert.match(adminPage.text, /href="\/relatorios"/);
  assert.match(adminPage.text, /href="\/agendamentos"/);
});
