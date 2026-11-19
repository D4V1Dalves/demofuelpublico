const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { buildReport } = require('../src/reports');
const { runDueRules } = require('../src/scheduler');
const { startTimer, pauseTimer, getTimer } = require('../src/timer');

let env;
before(() => { env = makeApp(); });
after(() => { env.cleanup(); });

const db = () => env.app.locals.db;

async function admin() {
  const agent = request.agent(env.app);
  const res = await agent.post('/login').type('form').send({ email: 'admin@empresa.local', password: 'Admin@123' });
  assert.equal(res.status, 302);
  return agent;
}

function addJob({ title, status = 'Novo', createdAt = '2026-11-01 10:00:00', clientId = 1 }) {
  return Number(db().prepare(`
    INSERT INTO requests (client_id, title, description, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'Descrição', ?, 'Média', 1, ?, ?)
  `).run(clientId, title, status, createdAt, createdAt).lastInsertRowid);
}

function addRule(clientId, overrides = {}) {
  const r = { name: 'Regra', title: 'Job automático', next_run_at: '2026-11-17 09:30:00', ...overrides };
  return Number(db().prepare(`
    INSERT INTO recurring_rules (name, client_id, title, description, priority, due_days,
      interval_value, interval_unit, start_time, active, next_run_at, created_by)
    VALUES (?, ?, ?, '', 'Média', 1, 1, 'dia', '09:30', 1, ?, 1)
  `).run(r.name, clientId, r.title, r.next_run_at).lastInsertRowid);
}

test('arrastar um job de Em processo para Aprovação abre um ciclo novo com novo link', async () => {
  const id = addJob({ title: 'Revisado', status: 'Em processo' });
  db().prepare(`UPDATE requests SET client_rejected_at = datetime('now'), client_rejection_reason = 'Não gostei',
    approval_token = 'tokenantigo' WHERE id = ?`).run(id);

  const res = await (await admin()).post(`/requisicoes/${id}/status`).send({ status: 'Aprovação' });
  assert.equal(res.status, 200);

  const job = db().prepare('SELECT * FROM requests WHERE id = ?').get(id);
  assert.equal(job.status, 'Aprovação');
  assert.equal(job.client_rejection_reason, null);
  assert.equal(job.client_rejected_at, null);
  assert.ok(job.admin_approved_at);
  assert.ok(job.approval_token && job.approval_token !== 'tokenantigo');

  const page = await request(env.app).get(`/aprovacao/${job.approval_token}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Não gostei/);
});

test('só Em processo pode ir para Aprovação (quadro, edição e botão Aprovar)', async () => {
  const agent = await admin();
  for (const status of ['Novo', 'Em andamento', 'Rejeitado', 'Aprovado']) {
    const id = addJob({ title: `Bloqueado ${status}`, status });
    const moved = await agent.post(`/requisicoes/${id}/status`).send({ status: 'Aprovação' });
    assert.equal(moved.status, 400, status);
    assert.equal((await agent.post(`/requisicoes/${id}/aprovar`)).status, 400, status);
    const job = db().prepare('SELECT status, approval_token, admin_approved_at FROM requests WHERE id = ?').get(id);
    assert.equal(job.status, status);
    assert.equal(job.approval_token, null);
    assert.equal(job.admin_approved_at, null);
  }
});

test('editar um job de Em processo para Aprovação gera o link do cliente', async () => {
  const id = addJob({ title: 'Edição para aprovação', status: 'Em processo' });
  const res = await (await admin()).post(`/requisicoes/${id}/editar`).type('form').send({
    client_id: '1', new_client_name: '', title: 'Edição para aprovação', description: 'Descrição',
    status: 'Aprovação', priority: 'Média', responsible_id: '', due_date: '', dropbox_url: '',
  });
  assert.equal(res.status, 302);
  const job = db().prepare('SELECT status, approval_token, admin_approved_at FROM requests WHERE id = ?').get(id);
  assert.equal(job.status, 'Aprovação');
  assert.ok(job.approval_token);
  assert.ok(job.admin_approved_at);
});

test('arrastar para Em processo sem relato do ciclo é recusado', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Arrastar sem relato', status: 'Em andamento' });
  const res = await agent.post(`/requisicoes/${id}/status`).send({ status: 'Em processo' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /É obrigatório preencher o campo/);
});

test('excluir cliente com agendamento mostra aviso em vez de erro 500', async () => {
  const clientId = Number(db().prepare("INSERT INTO clients (name) VALUES ('Cliente com regra')").run().lastInsertRowid);
  addRule(clientId, { next_run_at: '2099-01-01 09:30:00' });

  const res = await (await admin()).post(`/clientes/${clientId}/excluir`);
  assert.notEqual(res.status, 500);
  assert.match(res.text, /agendamento\(s\) vinculados/);
  assert.ok(db().prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId));
});

test('editar job com novo cliente cria e vincula o cliente', async () => {
  const id = addJob({ title: 'Editar cliente' });
  const res = await (await admin()).post(`/requisicoes/${id}/editar`).type('form').send({
    client_id: '', new_client_name: 'Cliente criado na edição', title: 'Editar cliente',
    description: 'Descrição', status: 'Novo', priority: 'Média', responsible_id: '', due_date: '', dropbox_url: '',
  });
  assert.equal(res.status, 302);
  const client = db().prepare("SELECT id FROM clients WHERE name = 'Cliente criado na edição'").get();
  assert.ok(client);
  assert.equal(db().prepare('SELECT client_id FROM requests WHERE id = ?').get(id).client_id, client.id);
});

test('reiniciar um timer finalizado mantém as horas já registradas', () => {
  const id = addJob({ title: 'Timer reaberto' });
  startTimer(db(), id, 1, new Date(2026, 10, 17, 9, 0, 0));
  pauseTimer(db(), id, 1, new Date(2026, 10, 17, 12, 0, 0));
  db().prepare("UPDATE time_entries SET status = 'finished' WHERE request_id = ?").run(id);

  startTimer(db(), id, 1, new Date(2026, 10, 18, 9, 0, 0));
  const timer = getTimer(db(), id, 1);
  assert.equal(timer.status, 'running');
  assert.equal(Number(timer.accumulated_seconds), 3 * 3600);
});

test('relatório diário de 30 dias inclui os dias mais recentes', () => {
  for (let day = 1; day <= 30; day += 1) {
    addJob({ title: `Diário ${day}`, createdAt: `2026-09-${String(day).padStart(2, '0')} 10:00:00`, clientId: 1 });
  }
  const report = buildReport(db(), { de: '2026-09-01', ate: '2026-09-30', granularidade: 'dia' });
  assert.equal(report.truncated, false);
  assert.ok(report.buckets.some((b) => b.key.includes('2026-09-30')));

  const longo = buildReport(db(), { de: '2026-08-01', ate: '2026-09-30', granularidade: 'dia' });
  if (longo.truncated) assert.ok(longo.buckets.at(-1).key.includes('2026-09-30'));
});

test('agendador tenta de novo antes de pular a ocorrência que falhou', () => {
  // A regra "Quebrada" falha ao gravar o job (simula um erro do banco).
  const real = db();
  const broken = addRule(1, { name: 'Quebrada', title: 'Nunca criado' });
  addRule(1, { name: 'Saudável', title: 'Criado mesmo assim' });
  const conn = {
    exec: (sql) => real.exec(sql),
    prepare: (sql) => {
      const stmt = real.prepare(sql);
      if (!/INSERT INTO requests/.test(sql)) return stmt;
      return {
        run: (...args) => {
          if (args.includes(broken)) throw new Error('falha simulada do banco');
          return stmt.run(...args);
        },
      };
    },
  };

  const events = [];
  const onError = (rule, _error, info) => events.push({ id: rule.id, ...info });
  const tick = (minute) => runDueRules(conn, new Date(2026, 10, 17, 10, minute, 0), { onError });
  const nextRun = () => conn.prepare('SELECT next_run_at FROM recurring_rules WHERE id = ?').get(broken).next_run_at;

  // As outras regras rodam normalmente.
  assert.ok(tick(0) >= 1);
  assert.ok(conn.prepare("SELECT 1 FROM requests WHERE title = 'Criado mesmo assim'").get());
  // 1ª e 2ª falhas: continua vencida para nova tentativa (erro passageiro não perde o job).
  assert.equal(nextRun(), '2026-11-17 09:30:00');
  tick(1);
  assert.equal(nextRun(), '2026-11-17 09:30:00');
  // 3ª falha: a ocorrência é pulada e a regra não repete o erro.
  tick(2);
  assert.ok(nextRun() > '2026-11-17 10:02:00', nextRun());
  assert.deepEqual(events.map((e) => [e.id, e.attempts, e.skipped]), [[broken, 1, false], [broken, 2, false], [broken, 3, true]]);
  events.length = 0;
  tick(3);
  assert.deepEqual(events, []);
});

test('concluir com relato já registrado não cobra de novo', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Com relato' });
  await agent.post(`/requisicoes/${id}/timer/iniciar`);
  await agent.post(`/requisicoes/${id}/comentarios`).type('form').send({ body: 'Montando o layout' });

  const res = await agent.post(`/requisicoes/${id}/timer/concluir`).type('form').send({});
  assert.equal(res.status, 302);
  assert.equal(db().prepare('SELECT status FROM requests WHERE id = ?').get(id).status, 'Em processo');
});

test('sem relato, o botão de concluir só avisa (sem caixa de texto)', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Sem relato' });
  await agent.post(`/requisicoes/${id}/timer/iniciar`);

  const page = await agent.get(`/requisicoes/${id}`);
  assert.match(page.text, /data-conclude-blocked/);
  assert.match(page.text, /id="conclude-required" hidden/);
  assert.doesNotMatch(page.text, /conclude-dialog|name="comment"/);

  const res = await agent.post(`/requisicoes/${id}/timer/concluir`).type('form').send({});
  assert.equal(res.status, 400);
  assert.match(res.text, /É obrigatório preencher o campo/);
});

test('retrabalho exige relato novo: comentário de ciclo anterior não vale', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Retrabalho' });
  // Comentário antigo, de antes do ciclo atual.
  db().prepare("INSERT INTO comments (request_id, user_id, body, created_at) VALUES (?, 1, 'Ciclo 1', '2020-01-01 10:00:00')").run(id);

  await agent.post(`/requisicoes/${id}/timer/iniciar`);
  assert.equal(db().prepare('SELECT status FROM requests WHERE id = ?').get(id).status, 'Em andamento');
  assert.ok(db().prepare('SELECT cycle_started_at FROM requests WHERE id = ?').get(id).cycle_started_at);

  let res = await agent.post(`/requisicoes/${id}/timer/concluir`).type('form').send({});
  assert.equal(res.status, 400);
  assert.deepEqual((await agent.get(`/requisicoes/${id}/relato`)).body, { hasProgressNote: false });

  await agent.post(`/requisicoes/${id}/comentarios`).type('form').send({ body: 'Ajustes do ciclo 2' });
  assert.deepEqual((await agent.get(`/requisicoes/${id}/relato`)).body, { hasProgressNote: true });
  res = await agent.post(`/requisicoes/${id}/timer/concluir`).type('form').send({});
  assert.equal(res.status, 302);
  assert.equal(db().prepare('SELECT status FROM requests WHERE id = ?').get(id).status, 'Em processo');
});

test('aviso de relato obrigatório não aparece duplicado após recusa do servidor', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Aviso único' });
  await agent.post(`/requisicoes/${id}/timer/iniciar`);
  const res = await agent.post(`/requisicoes/${id}/timer/concluir`).type('form').send({});
  assert.equal(res.status, 400);
  assert.equal(res.text.match(/É obrigatório preencher o campo/g).length, 1);
});

test('datas aparecem no formato brasileiro', () => {
  const { fmtDate, fmtDateTime } = require('../src/format');
  assert.equal(fmtDate('2026-11-22'), '22/11/2026');
  assert.equal(fmtDate(null, 'Sem prazo'), 'Sem prazo');
  assert.equal(fmtDateTime('2026-11-19 08:08:58'), '19/11/2026 às 08:08');
  assert.equal(fmtDateTime('2026-11-19'), '19/11/2026');
  assert.equal(fmtDateTime(''), '—');
});

test('rejeitado não volta direto para Em processo (nem pelo quadro nem pela edição)', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Rejeitado direto', status: 'Rejeitado' });
  db().prepare("UPDATE requests SET admin_approved_at = datetime('now'), client_rejected_at = datetime('now'), cycle_started_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  db().prepare("INSERT INTO comments (request_id, user_id, body, created_at) VALUES (?, 1, 'Relato antigo', '2020-01-02 00:00:00')").run(id);

  const moved = await agent.post(`/requisicoes/${id}/status`).send({ status: 'Em processo' });
  assert.equal(moved.status, 400);

  // Pela edição, escolher Em andamento (como a tela orienta) abre um ciclo novo.
  const res = await agent.post(`/requisicoes/${id}/editar`).type('form').send({
    client_id: '1', new_client_name: '', title: 'Rejeitado direto', description: 'Descrição',
    status: 'Em andamento', priority: 'Média', responsible_id: '', due_date: '', dropbox_url: '',
  });
  assert.equal(res.status, 302);
  const job = db().prepare('SELECT * FROM requests WHERE id = ?').get(id);
  assert.equal(job.status, 'Em andamento');
  assert.equal(job.admin_approved_at, null);
  assert.equal(job.approval_token, null);
  assert.ok(job.cycle_started_at > '2020-01-01 00:00:00');
  // O relato antigo não vale para o ciclo novo.
  assert.equal((await agent.post(`/requisicoes/${id}/status`).send({ status: 'Em processo' })).status, 400);
});

test('briefing num job Novo não conta como relato', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Com briefing' });
  db().prepare("INSERT INTO comments (request_id, user_id, body) VALUES (?, 1, 'Briefing do cliente')").run(id);
  const moved = await agent.post(`/requisicoes/${id}/status`).send({ status: 'Em processo' });
  assert.equal(moved.status, 400);
});

test('retomar o timer de um job rejeitado volta para Em andamento com ciclo novo', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Retomar rejeitado', status: 'Rejeitado' });
  db().prepare("UPDATE requests SET admin_approved_at = datetime('now'), client_rejected_at = datetime('now'), client_rejection_reason = 'x', cycle_started_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  db().prepare("INSERT INTO comments (request_id, user_id, body, created_at) VALUES (?, 1, 'Antigo', '2020-01-02 00:00:00')").run(id);

  await agent.post(`/requisicoes/${id}/timer/iniciar`);
  const job = db().prepare('SELECT * FROM requests WHERE id = ?').get(id);
  assert.equal(job.status, 'Em andamento');
  assert.equal(job.admin_approved_at, null);
  // O pedido do cliente continua visível para a equipe durante o retrabalho.
  assert.equal(job.client_rejection_reason, 'x');
  assert.match((await agent.get(`/requisicoes/${id}`)).text, /Ajustes pedidos pelo cliente: x/);
  assert.equal((await agent.post(`/requisicoes/${id}/timer/concluir`).type('form').send({})).status, 400);
});

test('rota de relato respeita a permissão do timer e Aprovar não regenera link em Aprovação', async () => {
  const user = request.agent(env.app);
  await user.post('/login').type('form').send({ email: 'usuario@empresa.local', password: 'Usuario@123' });
  const adminId = db().prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
  const id = addJob({ title: 'De outra pessoa' });
  db().prepare('UPDATE requests SET responsible_id = ? WHERE id = ?').run(adminId, id);
  assert.equal((await user.get(`/requisicoes/${id}/relato`)).status, 403);

  const agent = await admin();
  const inApproval = addJob({ title: 'Já em aprovação', status: 'Aprovação' });
  db().prepare("UPDATE requests SET approval_token = 'tokenenviado' WHERE id = ?").run(inApproval);
  assert.equal((await agent.post(`/requisicoes/${inApproval}/aprovar`)).status, 400);
  assert.equal(db().prepare('SELECT approval_token FROM requests WHERE id = ?').get(inApproval).approval_token, 'tokenenviado');
});

test('editar um job rejeitado sem mudar a etapa é permitido', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Rejeitado título', status: 'Rejeitado' });
  db().prepare("UPDATE requests SET admin_approved_at = datetime('now'), client_rejected_at = datetime('now'), client_rejection_reason = 'Cores' WHERE id = ?").run(id);
  const res = await agent.post(`/requisicoes/${id}/editar`).type('form').send({
    client_id: '1', new_client_name: '', title: 'Rejeitado título corrigido', description: 'Descrição',
    status: 'Rejeitado', priority: 'Média', responsible_id: '', due_date: '', dropbox_url: '',
  });
  assert.equal(res.status, 302);
  const job = db().prepare('SELECT * FROM requests WHERE id = ?').get(id);
  assert.equal(job.title, 'Rejeitado título corrigido');
  assert.equal(job.status, 'Rejeitado');
  assert.equal(job.client_rejection_reason, 'Cores');
});

test('timer num job em revisão só registra tempo (não reabre o ciclo)', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Em revisão', status: 'Em processo' });
  db().prepare("UPDATE requests SET cycle_started_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  await agent.post(`/requisicoes/${id}/timer/iniciar`);
  const job = db().prepare('SELECT status, cycle_started_at FROM requests WHERE id = ?').get(id);
  assert.equal(job.status, 'Em processo');
  assert.equal(job.cycle_started_at, '2020-01-01 00:00:00');
});

test('soltar o card na própria coluna não apaga a rejeição', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Solto na coluna', status: 'Rejeitado' });
  db().prepare("UPDATE requests SET client_rejected_at = datetime('now'), client_rejection_reason = 'Trocar logo' WHERE id = ?").run(id);
  const res = await agent.post(`/requisicoes/${id}/status`).send({ status: 'Rejeitado' });
  assert.equal(res.status, 200);
  const job = db().prepare('SELECT client_rejection_reason, client_rejected_at FROM requests WHERE id = ?').get(id);
  assert.equal(job.client_rejection_reason, 'Trocar logo');
  assert.ok(job.client_rejected_at);
});

test('voltar para Novo encerra o ciclo: comentários antigos não valem como relato', async () => {
  const agent = await admin();
  const id = addJob({ title: 'Volta para Novo', status: 'Em andamento' });
  db().prepare("UPDATE requests SET cycle_started_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  db().prepare("INSERT INTO comments (request_id, user_id, body) VALUES (?, 1, 'Relato')").run(id);
  assert.equal((await agent.post(`/requisicoes/${id}/status`).send({ status: 'Novo' })).status, 200);
  assert.equal(db().prepare('SELECT cycle_started_at FROM requests WHERE id = ?').get(id).cycle_started_at, null);
  assert.equal((await agent.post(`/requisicoes/${id}/status`).send({ status: 'Em processo' })).status, 400);
});

test('limite por IP: quem já entrou continua entrando, e isso não libera o IP', async () => {
  const fresh = makeApp();
  try {
    const agent = request.agent(fresh.app);
    const login = (email, password) => agent.post('/login').type('form').send({ email, password });
    // Usuário comum entra uma vez (fica "conhecido" neste IP).
    assert.equal((await login('usuario@empresa.local', 'Usuario@123')).status, 302);
    for (let i = 0; i < 60; i += 1) await login(`z${i}@teste.local`, 'errada');
    // Uma conta que nunca entrou deste IP está barrada...
    assert.equal((await login('admin@empresa.local', 'Admin@123')).status, 429);
    // ...quem já entrou daqui continua entrando...
    assert.equal((await login('usuario@empresa.local', 'Usuario@123')).status, 302);
    // ...e isso não zera o contador do IP.
    assert.equal((await login('admin@empresa.local', 'Admin@123')).status, 429);
  } finally {
    fresh.cleanup();
  }
});
