const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { openDb } = require('../src/db');
const { STATUS } = require('../src/config');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function setup() {
  const env = makeApp();
  const db = env.app.locals.db;
  return { env, db };
}

async function loginAdmin(env) {
  const agent = request.agent(env.app);
  assert.equal(
    (await agent.post('/login').type('form').send({ email: 'admin@empresa.local', password: 'Admin@123' }))
      .status,
    302,
  );
  return agent;
}

test('STATUS usa Aprovado no lugar de Concluído, na ordem pedida', () => {
  assert.deepEqual(STATUS, ['Novo', 'Em andamento', 'Em processo', 'Aprovação', 'Aprovado', 'Rejeitado']);
});

test('migração converte jobs Concluído antigos em Aprovado', { skip: process.env.TEST_MYSQL === '1' && 'migração de arquivo SQLite antigo' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gestor-v6-mig-'));
  const dbPath = path.join(dir, 'app.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec('CREATE TABLE requests (id INTEGER PRIMARY KEY, status TEXT)');
  legacy.prepare("INSERT INTO requests (id, status) VALUES (1, 'Concluído')").run();
  legacy.close();

  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT status FROM requests WHERE id = 1').get().status, 'Aprovado');
  db.close();
  // O arquivo fica no temp do Windows até o processo liberar o handle do SQLite.
});

test('seed usa Aprovado e os KPIs continuam reportando concluidas', async () => {
  const { env, db } = setup();
  try {
    const row = db.prepare("SELECT * FROM requests WHERE title = 'Migração de dados'").get();
    assert.equal(row.status, 'Aprovado');
    assert.ok(row.completed_at);
    const admin = await loginAdmin(env);
    const stats = await admin.get('/dashboard/stats');
    assert.deepEqual(stats.body, { total: 8, abertas: 6, concluidas: 1, atrasadas: 1 });
  } finally {
    env.cleanup();
  }
});

test('link público mostra o relatório completo em tela cheia, sem link de download', async () => {
  const { env, db } = setup();
  try {
    const job = db.prepare("SELECT * FROM requests WHERE title = 'Proposta de campanha'").get();
    assert.equal(job.status, 'Aprovação');
    const attachmentId = Number(
      db
        .prepare(
          `INSERT INTO attachments (request_id, user_id, original_name, stored_name, mime_type, size)
           VALUES (?, 1, 'comprovante.txt', 'v6-comprovante.txt', 'text/plain', 7)`,
        )
        .run(job.id).lastInsertRowid,
    );
    fs.writeFileSync(path.join(env.uploadDir, 'v6-comprovante.txt'), 'conteudo');

    const res = await request(env.app).get(`/aprovacao/${job.approval_token}`);
    assert.equal(res.status, 200);

    // Tela cheia, com o documento do job e o bloco de decisão.
    for (const needle of [
      'approval-screen',
      'approval-layout',
      'approval-aside',
      'approval-decision',
      'Proposta de campanha',
      'Criar linha visual e roteiro para campanha de lançamento.',
      'Relatório do que foi feito',
      'Comentários',
      'Roteiro inicial pronto. Aguardando aprovação do cliente.',
      'Anexos',
      'comprovante.txt',
      'Linha do tempo',
      'Job criado',
      'Aprovação do Admin',
      'Aprovar job',
      'Rejeitar job',
    ]) {
      assert.ok(res.text.includes(needle), `tela de aprovação sem "${needle}"`);
    }

    // Os anexos aparecem inline e não há link de download na interface.
    assert.match(res.text, new RegExp(`/aprovacao/${job.approval_token}/anexo/${attachmentId}/preview`));
    assert.doesNotMatch(res.text, new RegExp(`href="/aprovacao/${job.approval_token}/anexo/${attachmentId}"`));
    assert.ok(!res.text.includes('>Baixar<'));

    // Sem painel interno e sem link de navegação: só o documento e a decisão.
    assert.doesNotMatch(res.text, /class="sidebar"/);
    assert.doesNotMatch(res.text, /class="app-shell"/);
    assert.doesNotMatch(res.text, /<a[^>]+class="approval-brand"/);
    assert.doesNotMatch(res.text, /approval-foot/);
    assert.doesNotMatch(res.text, /href="\/(dashboard|clientes|relatorios|perfil|requisicoes|usuarios|agendamentos|login)(?:[\"/?])/);

    // Jobs já decididos exibem o resultado e o Dropbox quando existir.
    const done = db.prepare("SELECT * FROM requests WHERE title = 'Migração de dados'").get();
    const donePage = await request(env.app).get(`/aprovacao/${done.approval_token}`);
    assert.equal(donePage.status, 200);
    assert.match(donePage.text, /Job aprovado/i);
    assert.doesNotMatch(donePage.text, /Aprovar job/);
    for (const needle of [
      'Dropbox',
      'https://www.dropbox.com/s/exemplo/migracao',
      'Importação validada com sucesso.',
      'Aprovação do Cliente',
    ]) {
      assert.ok(donePage.text.includes(needle), `página aprovada sem "${needle}"`);
    }

    // O endpoint de download continua protegido por token, mas não é exposto.
    const download = await request(env.app).get(
      `/aprovacao/${job.approval_token}/anexo/${attachmentId}`,
    );
    assert.equal(download.status, 200);
    assert.match(download.text, /conteudo/);
    assert.equal((await request(env.app).get(`/aprovacao/invalido/anexo/${attachmentId}`)).status, 404);
    assert.equal(
      (await request(env.app).get(`/aprovacao/${job.approval_token}/anexo/${attachmentId}abc`)).status,
      404,
    );
  } finally {
    env.cleanup();
  }
});

test('cliente aprova: job vai para Aprovado, token continua válido e não reaprová', async () => {
  const { env, db } = setup();
  try {
    const job = db.prepare("SELECT * FROM requests WHERE title = 'Proposta de campanha'").get();
    const res = await request(env.app).post(`/aprovacao/${job.approval_token}/aprovar`).type('form').send({});
    assert.equal(res.status, 200);
    assert.match(res.text, /aprovado/i);

    const approved = db.prepare('SELECT * FROM requests WHERE id = ?').get(job.id);
    assert.equal(approved.status, 'Aprovado');
    assert.ok(approved.client_approved_at);
    assert.ok(approved.completed_at);
    assert.equal(approved.approval_token, job.approval_token);

    const again = await request(env.app).get(`/aprovacao/${job.approval_token}`);
    assert.equal(again.status, 200);
    assert.match(again.text, /Job aprovado/i);
    assert.doesNotMatch(again.text, /Aprovar job/);

    await request(env.app).post(`/aprovacao/${job.approval_token}/aprovar`).type('form').send({});
    await request(env.app)
      .post(`/aprovacao/${job.approval_token}/rejeitar`)
      .type('form')
      .send({ reason: 'tentativa tardia' });
    const unchanged = db.prepare('SELECT * FROM requests WHERE id = ?').get(job.id);
    assert.equal(unchanged.status, 'Aprovado');
    assert.equal(unchanged.client_approved_at, approved.client_approved_at);
    assert.equal(unchanged.client_rejection_reason, null);
  } finally {
    env.cleanup();
  }
});

test('job rejeitado não pode ser aprovado depois pela mesma decisão', async () => {
  const { env, db } = setup();
  try {
    const job = db.prepare("SELECT * FROM requests WHERE title = 'Revisão de contrato'").get();
    const res = await request(env.app).post(`/aprovacao/${job.approval_token}/aprovar`).type('form').send({});
    assert.equal(res.status, 200);
    assert.match(res.text, /rejeitado/i);
    assert.equal(db.prepare('SELECT status FROM requests WHERE id = ?').get(job.id).status, 'Rejeitado');
  } finally {
    env.cleanup();
  }
});

test('Admin só arrasta para Aprovado com as duas aprovações e mantém o token', async () => {
  const { env, db } = setup();
  try {
    const admin = await loginAdmin(env);
    const info = db
      .prepare(
        `INSERT INTO requests (client_id, title, description, status, priority, created_by,
           approval_token, admin_approved_at)
         VALUES (1, 'Sem aprovação do cliente', 'x', 'Em processo', 'Média', 1, ?, datetime('now'))`,
      )
      .run('token-de-teste');
    const id = Number(info.lastInsertRowid);
    assert.equal(
      (await admin.post(`/requisicoes/${id}/status`).send({ status: 'Aprovado' })).status,
      400,
    );

    db.prepare("UPDATE requests SET client_approved_at = datetime('now') WHERE id = ?").run(id);
    const ok = await admin.post(`/requisicoes/${id}/status`).send({ status: 'Aprovado' });
    assert.equal(ok.status, 200);
    const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    assert.equal(updated.status, 'Aprovado');
    assert.ok(updated.completed_at);
    assert.equal(updated.approval_token, 'token-de-teste');
  } finally {
    env.cleanup();
  }
});

test('colunas e KPIs usam as cores da etapa no padrão do board', () => {
  const css = read('public/styles.css');
  const columns = {
    Novo: ['--st-novo', '#579bfc'],
    'Em andamento': ['--st-andamento', '#a25ddc'],
    'Em processo': ['--st-em-processo', '#8b93a6'],
    Aprovação: ['--st-aprovacao', '#fdab3d'],
    Aprovado: ['--st-aprovado', '#00c875'],
    Rejeitado: ['--st-rejeitado', '#fa0002'],
  };
  for (const [status, [token, color]] of Object.entries(columns)) {
    assert.match(
      css,
      new RegExp(
        `\\.column\\[data-status="${status}"\\]\\s*\\{[^}]*--stage-accent:\\s*var\\(${token}\\)\\s*;`,
        's',
      ),
      `cor errada para ${status}`,
    );
    assert.match(css, new RegExp(`${token}:\\s*${color}\\s*;`), `token ${token} com a cor errada`);
  }
  assert.doesNotMatch(css, /data-status="Concluído"/);

  const kpis = {
    'kpi-total': 'var\\(--muted\\)',
    'kpi-open': 'var\\(--st-novo\\)',
    'kpi-late': 'var\\(--st-rejeitado\\)',
    'kpi-done': 'var\\(--st-aprovado\\)',
  };
  for (const [name, color] of Object.entries(kpis)) {
    assert.match(css, new RegExp(`\\.${name}\\s*\\{[^}]*${color}\\s*;`, 's'), `cor errada para ${name}`);
  }
});

test('favicon original está publicado e referenciado em todas as páginas', () => {
  const favicon = path.join(root, 'public', 'favicon.png');
  assert.ok(fs.existsSync(favicon));

  // O PNG quadrado e de alta resolução é o favicon canônico (aba e tela inicial).
  const png = fs.readFileSync(favicon);
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20), 'favicon deve ser quadrado');

  const top = read('views/partials/top.ejs');
  assert.match(top, /rel="icon"[^>]*href="\/static\/favicon\.png"/);
  assert.match(top, /rel="apple-touch-icon"[^>]*href="\/static\/favicon\.png"/);
  assert.doesNotMatch(top, /favicon\.svg|favicon-32\.png|favicon-192\.png|apple-touch-icon\.png/);
});

test('o ícone do favicon é reutilizado no cabeçalho de Fuel Jobs e Meu trabalho', () => {
  const dashboard = read('views/dashboard.ejs');
  assert.match(
    dashboard,
    /<span class="board-badge"[^>]*><img src="\/static\/favicon\.png"/,
    'o badge do board deve usar a imagem do favicon',
  );

  // Os demais ícones da sidebar continuam sendo os glifos originais.
  const top = read('views/partials/top.ejs');
  assert.match(top, /<span class="side-icon"[^>]*>◎<\/span>Meu trabalho/);
  assert.match(top, /<span class="side-icon"[^>]*>▦<\/span>Dashboard/);
});
