/* Smoke test real do caminho MySQL/MariaDB.
   Uso:
     DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=... DB_NAME=fuel_jobs \
       node scripts/smoke-mysql.js
   O banco precisa existir e estar vazio (ou já com o schema). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { runRuleNow } = require('../src/scheduler-core');

const results = [];
function ok(label) {
  results.push(label);
  console.log(`ok - ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuel-mysql-smoke-'));
  const app = createApp({
    dbPath: path.join(dir, 'unused.db'),
    uploadDir: path.join(dir, 'uploads'),
    seedData: true,
    dbOptions: { driver: 'mysql' },
  });
  const db = app.locals.db;
  assert(db.driver === 'mysql', 'o driver ativo deveria ser mysql');

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  const call = async (method, url, form) => {
    const response = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const setCookie = response.headers.getSetCookie
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    const session = setCookie.find((value) => value.startsWith('sid='));
    if (session) cookie = session.split(';')[0];
    return { status: response.status, location: response.headers.get('location'), text: await response.text() };
  };

  const callMultipart = async (url, form) => {
    const response = await fetch(base + url, {
      method: 'POST',
      redirect: 'manual',
      headers: cookie ? { cookie } : {},
      body: form,
    });
    return { status: response.status, location: response.headers.get('location'), text: await response.text() };
  };

  try {
    ok('conexão MySQL e criação do schema');

    const login = await call('POST', '/login', { email: 'admin@empresa.local', password: 'Admin@123' });
    assert(login.status === 302 && login.location === '/dashboard', 'login deveria redirecionar');
    assert(cookie.startsWith('sid='), 'cookie de sessão não foi emitido');
    ok('login e sessão');

    const dashboard = await call('GET', '/dashboard');
    assert(dashboard.status === 200 && /Fuel Jobs/.test(dashboard.text), 'dashboard não renderizou');
    ok('dashboard');

    const users = await call('GET', '/usuarios');
    assert(users.status === 200 && /admin@empresa\.local/.test(users.text), 'lista de usuários falhou');
    ok('lista de usuários');

    const profile = await call('GET', '/perfil');
    assert(profile.status === 200 && /Meu perfil/.test(profile.text), 'perfil não renderizou');
    ok('perfil');

    const rename = await call('POST', '/perfil', { name: 'Smoke Admin' });
    assert(rename.status === 302, 'salvar nome deveria redirecionar');
    const renamed = await call('GET', '/perfil');
    assert(/Smoke Admin/.test(renamed.text), 'nome atualizado não apareceu');
    ok('edição do nome da conta');

    const client = db.prepare('SELECT id FROM clients ORDER BY id LIMIT 1').get();
    assert(client, 'seed não criou clientes');
    const created = await call('POST', '/requisicoes', {
      client_id: client.id,
      title: 'Job smoke MySQL',
      description: 'Criado pelo smoke test.',
      status: 'Novo',
      priority: 'Média',
    });
    assert(created.status === 302, `criação de job falhou (${created.status})`);
    const job = db.prepare('SELECT * FROM requests WHERE title = ?').get('Job smoke MySQL');
    assert(job && job.status === 'Novo', 'job não foi persistido');
    ok('criação de job');

    const detail = await call('GET', `/requisicoes/${job.id}`);
    assert(detail.status === 200 && /Job smoke MySQL/.test(detail.text), 'detalhe do job falhou');
    ok('detalhe do job');

    const comment = await call('POST', `/requisicoes/${job.id}/comentarios`, { body: 'Comentário smoke.' });
    assert(comment.status === 302, 'comentário deveria redirecionar');
    const commentRow = db.prepare('SELECT * FROM comments WHERE request_id = ?').get(job.id);
    assert(commentRow && commentRow.body === 'Comentário smoke.', 'comentário não foi persistido');
    ok('comentário');

    const statusChange = await call('POST', `/requisicoes/${job.id}/status`, { status: 'Em andamento' });
    assert(statusChange.status === 200, `mudança de status falhou (${statusChange.status})`);
    assert(db.prepare('SELECT status FROM requests WHERE id = ?').get(job.id).status === 'Em andamento', 'status não foi atualizado');
    ok('mudança de status (JSON)');

    const timerStart = await call('POST', `/requisicoes/${job.id}/timer/iniciar`);
    assert(timerStart.status === 302, 'iniciar timer falhou');
    assert(db.prepare('SELECT status FROM time_entries WHERE request_id = ?').get(job.id).status === 'running', 'timer não iniciou');
    const timerPause = await call('POST', `/requisicoes/${job.id}/timer/pausar`);
    assert(timerPause.status === 302, 'pausar timer falhou');
    const timerFinish = await call('POST', `/requisicoes/${job.id}/timer/concluir`);
    assert(timerFinish.status === 302, 'concluir timer falhou');
    assert(db.prepare('SELECT status FROM time_entries WHERE request_id = ?').get(job.id).status === 'finished', 'timer não finalizou');
    ok('timer (iniciar/pausar/concluir)');

    const attachmentForm = new FormData();
    attachmentForm.append('file', new Blob([Buffer.from('%PDF-1.4 smoke')], { type: 'application/pdf' }), 'smoke.pdf');
    const attachment = await callMultipart(`/requisicoes/${job.id}/anexos`, attachmentForm);
    assert(attachment.status === 302, 'upload de anexo falhou');
    assert(db.prepare('SELECT * FROM attachments WHERE request_id = ?').get(job.id), 'anexo não foi persistido');
    ok('anexo (multipart)');

    const reports = await call('GET', '/relatorios');
    assert(reports.status === 200, 'relatórios não renderizaram');
    const schedule = await call('GET', '/agendamentos');
    assert(schedule.status === 200, 'agendamentos não renderizaram');
    ok('relatórios e agendamentos');

    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@empresa.local'").get();
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    db.prepare(
      `INSERT INTO recurring_rules (name, client_id, title, description, priority, responsible_id, due_days,
         interval_value, interval_unit, start_time, active, next_run_at, created_by)
       VALUES (?, ?, ?, '', 'Média', NULL, 0, 1, 'dia', '09:00', 1, ?, ?)`,
    ).run('Regra smoke', client.id, 'Job da regra smoke', stamp, admin.id);
    const rule = db.prepare("SELECT id FROM recurring_rules WHERE name = 'Regra smoke'").get();
    assert(runRuleNow(db, rule.id, now) === true, 'execução da regra falhou');
    assert(db.prepare("SELECT * FROM requests WHERE title = 'Job da regra smoke'").get(), 'job da regra não foi criado');
    ok('agendamento recorrente (transação)');

    db.prepare("DELETE FROM requests WHERE title = 'Job da regra smoke'").run();
    db.prepare("DELETE FROM recurring_rules WHERE name = 'Regra smoke'").run();
    db.prepare('DELETE FROM attachments WHERE request_id = ?').run(job.id);
    db.prepare('DELETE FROM time_entries WHERE request_id = ?').run(job.id);
    db.prepare('DELETE FROM comments WHERE request_id = ?').run(job.id);
    db.prepare('DELETE FROM requests WHERE id = ?').run(job.id);
    console.log(`\n${results.length} verificações MySQL passaram.`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FALHOU:', error.message);
  process.exitCode = 1;
});
