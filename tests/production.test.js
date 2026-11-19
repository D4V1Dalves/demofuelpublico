const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { makeApp } = require('./helpers');

test('banco vazio: tudo leva para a instalação, que cria o primeiro admin uma única vez', async () => {
  const env = makeApp({ seedData: false });
  try {
    const anon = request(env.app);
    const home = await anon.get('/dashboard');
    assert.equal(home.status, 302);
    assert.equal(home.headers.location, '/instalacao');
    assert.equal((await anon.get('/login')).headers.location, '/instalacao');
    assert.equal((await anon.post('/login').type('form').send({ email: 'admin@empresa.local', password: 'Admin@123' })).status, 503);
    assert.match((await anon.get('/instalacao')).text, /Crie a conta do administrador/);

    // Validações.
    const weak = await anon.post('/instalacao').type('form').send({ name: 'Ana', email: 'ana@fuel.com', password: 'curta', confirm_password: 'curta' });
    assert.equal(weak.status, 400);
    const mismatch = await anon.post('/instalacao').type('form').send({ name: 'Ana', email: 'ana@fuel.com', password: 'senha-forte-1', confirm_password: 'outra-senha-1' });
    assert.equal(mismatch.status, 400);

    const agent = request.agent(env.app);
    const created = await agent.post('/instalacao').type('form').send({ name: 'Ana', email: 'Ana@Fuel.com', password: 'senha-forte-1', confirm_password: 'senha-forte-1' });
    assert.equal(created.status, 302);
    assert.equal(created.headers.location, '/dashboard');
    assert.equal((await agent.get('/dashboard')).status, 200);

    const users = env.app.locals.db.prepare('SELECT email, role FROM users').all();
    assert.deepEqual(users.map((u) => ({ ...u })), [{ email: 'ana@fuel.com', role: 'admin' }]);
    // Sem contas nem jobs de exemplo.
    assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);

    // A instalação não pode ser repetida.
    const again = await request(env.app).post('/instalacao').type('form').send({ name: 'X', email: 'x@x.com', password: 'senha-forte-2', confirm_password: 'senha-forte-2' });
    assert.equal(again.status, 302);
    assert.equal(again.headers.location, '/login');
    assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  } finally {
    env.cleanup();
  }
});

test('em produção o padrão é não criar dados de exemplo', () => {
  const { shouldSeed } = require('../src/db');
  assert.equal(shouldSeed({ NODE_ENV: 'production' }), false);
  assert.equal(shouldSeed({ NODE_ENV: 'production', SEED: 'true' }), true);
  assert.equal(shouldSeed({}), true);
  assert.equal(shouldSeed({ SEED: 'false' }), false);
  assert.match(require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /shouldSeed\(process\.env\)/);
});

test('admin desativa, reativa e redefine a senha de usuários com proteções', async () => {
  const env = makeApp();
  try {
    const db = env.app.locals.db;
    const login = async (email, password) => {
      const agent = request.agent(env.app);
      const res = await agent.post('/login').type('form').send({ email, password });
      return { agent, status: res.status };
    };
    const { agent: admin } = await login('admin@empresa.local', 'Admin@123');
    const { agent: userSession } = await login('usuario@empresa.local', 'Usuario@123');
    assert.equal((await userSession.get('/dashboard')).status, 200);
    const userId = db.prepare("SELECT id FROM users WHERE email = 'usuario@empresa.local'").get().id;
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@empresa.local'").get().id;

    // Usuário comum não gerencia ninguém.
    assert.equal((await userSession.post(`/usuarios/${adminId}/desativar`)).status, 403);

    // Desativar encerra a sessão e bloqueia o login.
    assert.equal((await admin.post(`/usuarios/${userId}/desativar`)).status, 302);
    assert.equal((await userSession.get('/dashboard')).status, 302);
    assert.equal((await login('usuario@empresa.local', 'Usuario@123')).status, 401);
    assert.match((await admin.get('/usuarios')).text, /Desativado/);

    // Reativar.
    assert.equal((await admin.post(`/usuarios/${userId}/ativar`)).status, 302);
    assert.equal((await login('usuario@empresa.local', 'Usuario@123')).status, 302);

    // Redefinir senha: a antiga para de funcionar.
    assert.equal((await admin.post(`/usuarios/${userId}/senha`).type('form').send({ password: 'curta' })).status, 400);
    assert.equal((await admin.post(`/usuarios/${userId}/senha`).type('form').send({ password: 'nova-senha-123' })).status, 302);
    assert.equal((await login('usuario@empresa.local', 'Usuario@123')).status, 401);
    assert.equal((await login('usuario@empresa.local', 'nova-senha-123')).status, 302);

    // Proteções: não desativa a si mesmo nem o último admin ativo.
    assert.equal((await admin.post(`/usuarios/${adminId}/desativar`)).status, 400);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
    const { agent: secondAdmin } = await login('usuario@empresa.local', 'nova-senha-123');
    assert.equal((await secondAdmin.post(`/usuarios/${adminId}/desativar`)).status, 302);
    assert.equal((await admin.get('/dashboard')).status, 302, 'sessão do admin desativado foi encerrada');
    db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(userId);
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(adminId);
  } finally {
    env.cleanup();
  }
});

test('agendador: dois processos lendo a mesma regra criam o job uma vez só', () => {
  const env = makeApp();
  try {
    const db = env.app.locals.db;
    const { runDueRules } = require('../src/scheduler-core');
    db.prepare(
      `INSERT INTO recurring_rules (name, client_id, title, description, priority, due_days, interval_value, interval_unit, start_time, active, next_run_at, created_by)
       VALUES ('Dupla', 1, 'Job único', '', 'Média', 1, 1, 'dia', '09:00', 1, '2026-11-17 09:00:00', 1)`,
    ).run();
    // Os dois "processos" leem a regra antes de qualquer um gravar.
    const stale = db.prepare("SELECT * FROM recurring_rules WHERE name = 'Dupla'").all();
    const staleDb = {
      exec: (sql) => db.exec(sql),
      prepare: (sql) =>
        /SELECT \* FROM recurring_rules WHERE active = 1/.test(sql) ? { all: () => stale } : db.prepare(sql),
    };
    const now = new Date(2026, 10, 17, 10, 0, 0);
    assert.equal(runDueRules(staleDb, now, { onError: () => {} }), 1);
    assert.equal(runDueRules(staleDb, now, { onError: () => {} }), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM requests WHERE title = 'Job único'").get().n, 1);
  } finally {
    env.cleanup();
  }
});

test('em produção o app confia no proxy do cPanel por padrão', () => {
  const saved = { node: process.env.NODE_ENV, trust: process.env.TRUST_PROXY };
  try {
    delete process.env.TRUST_PROXY;
    process.env.NODE_ENV = 'production';
    let env = makeApp();
    assert.equal(env.app.get('trust proxy'), 1);
    env.cleanup();
    process.env.TRUST_PROXY = '0';
    env = makeApp();
    assert.ok(!env.app.get('trust proxy'));
    env.cleanup();
  } finally {
    if (saved.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.node;
    if (saved.trust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved.trust;
  }
});

test('produção: instalação exige o código de INSTALL_TOKEN', async () => {
  const saved = { node: process.env.NODE_ENV, token: process.env.INSTALL_TOKEN };
  process.env.NODE_ENV = 'production';
  delete process.env.INSTALL_TOKEN;
  const env = makeApp({ seedData: false });
  try {
    const form = { name: 'Ana', email: 'ana@fuel.com', password: 'senha-forte-1', confirm_password: 'senha-forte-1' };
    // Sem INSTALL_TOKEN definido: ninguém instala.
    assert.match((await request(env.app).get('/instalacao')).text, /defina a variável <strong>INSTALL_TOKEN<\/strong>/);
    assert.equal((await request(env.app).post('/instalacao').type('form').send(form)).status, 503);

    process.env.INSTALL_TOKEN = 'codigo-secreto-do-dono';
    assert.match((await request(env.app).get('/instalacao')).text, /Código de instalação/);
    const wrong = await request(env.app).post('/instalacao').type('form').send({ ...form, install_token: 'chute' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.text, /Código de instalação incorreto/);
    assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);

    const ok = await request(env.app).post('/instalacao').type('form').send({ ...form, install_token: 'codigo-secreto-do-dono' });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, '/dashboard');
  } finally {
    env.cleanup();
    if (saved.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.node;
    if (saved.token === undefined) delete process.env.INSTALL_TOKEN; else process.env.INSTALL_TOKEN = saved.token;
  }
});

test('produção sem MySQL configurado não sobe (sem cair no SQLite em silêncio)', () => {
  const { assertProductionDatabase, useMysql } = require('../src/db');
  assert.throws(() => assertProductionDatabase({ NODE_ENV: 'production' }), /Banco não configurado/);
  assert.throws(() => assertProductionDatabase({ NODE_ENV: 'production', DB_DRIVER: 'sqlite' }), /ALLOW_SQLITE/);
  assert.doesNotThrow(() => assertProductionDatabase({ NODE_ENV: 'production', DB_SOCKET: '/var/lib/mysql/mysql.sock' }));
  assert.doesNotThrow(() => assertProductionDatabase({ NODE_ENV: 'production', DB_HOST: 'localhost' }));
  assert.doesNotThrow(() => assertProductionDatabase({ NODE_ENV: 'production', ALLOW_SQLITE: '1' }));
  assert.doesNotThrow(() => assertProductionDatabase({}));
  // Socket sozinho já indica MySQL.
  const saved = { host: process.env.DB_HOST, socket: process.env.DB_SOCKET, driver: process.env.DB_DRIVER };
  delete process.env.DB_HOST; delete process.env.DB_DRIVER;
  process.env.DB_SOCKET = '/tmp/mysql.sock';
  try {
    assert.equal(useMysql(), true);
  } finally {
    for (const [k, v] of [['DB_HOST', saved.host], ['DB_SOCKET', saved.socket], ['DB_DRIVER', saved.driver]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('fuso padrão de Brasília e aviso de uploads dentro da pasta do app', () => {
  const { applyTimezone, uploadDirWarning } = require('../src/runtime');
  const env1 = {};
  assert.equal(applyTimezone(env1), 'America/Sao_Paulo');
  assert.equal(applyTimezone({ APP_TIMEZONE: 'Europe/Lisbon' }), 'Europe/Lisbon');
  assert.equal(applyTimezone({ TZ: 'UTC' }), 'UTC');
  const root = '/home/conta/fueljobs';
  assert.match(uploadDirWarning(`${root}/uploads`, root, { NODE_ENV: 'production' }), /dentro da pasta do app/);
  assert.equal(uploadDirWarning('/home/conta/fueljobs-data/uploads', root, { NODE_ENV: 'production' }), null);
  assert.equal(uploadDirWarning(`${root}/uploads`, root, {}), null);
});

test('decisão do cliente: a gravação confere a etapa no próprio banco', async () => {
  const env = makeApp();
  try {
    const db = env.app.locals.db;
    const id = Number(db.prepare(
      "INSERT INTO requests (client_id, title, description, status, priority, created_by, approval_token) VALUES (1, 'Corrida', 'x', 'Aprovação', 'Média', 1, 'tokcorrida')",
    ).run().lastInsertRowid);
    // Simula outro processo decidindo entre a leitura e a gravação: a gravação
    // só acontece se o job ainda estiver em Aprovação e sem decisão.
    const res1 = await request(env.app).post('/aprovacao/tokcorrida/rejeitar').type('form').send({ reason: 'Ajustar' });
    assert.equal(res1.status, 200);
    db.prepare("UPDATE requests SET status = 'Aprovação' WHERE id = ?").run(id); // estado inconsistente forçado
    const res2 = await request(env.app).post('/aprovacao/tokcorrida/aprovar').type('form').send({});
    const job = db.prepare('SELECT status, client_approved_at, client_rejection_reason FROM requests WHERE id = ?').get(id);
    assert.equal(job.client_approved_at, null, 'aprovação não pode gravar por cima de uma rejeição');
    assert.equal(job.client_rejection_reason, 'Ajustar');
    assert.notEqual(res2.text.includes('Job aprovado pelo cliente'), true);
  } finally {
    env.cleanup();
  }
});

test('mensagens de erro em inglês no link em inglês', async () => {
  const env = makeApp();
  try {
    const res = await request(env.app)
      .post('/aprovacao/qualquer/aprovar?lang=en')
      .set('Origin', 'https://outro-site.example')
      .type('form')
      .send({});
    assert.equal(res.status, 403);
    assert.equal(res.text, 'Request origin not allowed.');
    const pt = await request(env.app).post('/aprovacao/qualquer/aprovar').set('Origin', 'https://outro-site.example').type('form').send({});
    assert.equal(pt.text, 'Origem não permitida.');
  } finally {
    env.cleanup();
  }
});
