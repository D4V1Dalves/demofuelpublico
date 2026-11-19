const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

let env;
before(() => { env = makeApp(); });
after(() => { env.cleanup(); });

async function login(role = 'admin') {
  const agent = request.agent(env.app);
  const credentials = role === 'admin'
    ? { email: 'admin@empresa.local', password: 'Admin@123' }
    : { email: 'usuario@empresa.local', password: 'Usuario@123' };
  const res = await agent.post('/login').type('form').send(credentials);
  assert.equal(res.status, 302);
  return agent;
}

const validRule = {
  name: 'Relatório semanal',
  client_id: '1',
  title: 'Relatório automático',
  description: 'Modelo pronto',
  priority: 'Alta',
  responsible_id: '',
  due_days: '5',
  dropbox_url: '',
  interval_value: '1',
  interval_unit: 'semana',
  start_time: '09:00',
};

test('agendamentos exige login e perfil admin', async () => {
  assert.equal((await request(env.app).get('/agendamentos')).status, 302);
  assert.equal((await (await login('user')).get('/agendamentos')).status, 403);
  assert.equal((await (await login()).get('/agendamentos')).status, 200);
});

test('admin cria uma regra com next_run_at calculado', async () => {
  const agent = await login();
  const res = await agent.post('/agendamentos').type('form').send(validRule);
  assert.equal(res.status, 302);
  const rule = env.app.locals.db.prepare("SELECT * FROM recurring_rules WHERE name = 'Relatório semanal'").get();
  assert.ok(rule);
  assert.equal(rule.interval_unit, 'semana');
  assert.equal(rule.start_time, '09:00');
  assert.match(rule.next_run_at, /^\d{4}-\d{2}-\d{2} 09:00:00$/);
});

test('validação rejeita periodicidade, unidade e horário inválidos', async () => {
  const agent = await login();
  for (const override of [
    { interval_value: '0' },
    { interval_value: '366' },
    { interval_unit: 'ano' },
    { start_time: '25:00' },
    { client_id: '9999' },
    { name: '' },
  ]) {
    const res = await agent.post('/agendamentos').type('form').send({ ...validRule, ...override });
    assert.equal(res.status, 400, `deveria rejeitar ${JSON.stringify(override)}`);
    assert.match(res.text, /obrigat|inválid/i);
  }
});

test('admin alterna, edita e exclui regra; usuário não pode', async () => {
  const admin = await login();
  const user = await login('user');
  const created = await admin.post('/agendamentos').type('form').send({ ...validRule, name: 'Regra manipulate' });
  assert.equal(created.status, 302);
  const rule = env.app.locals.db.prepare("SELECT * FROM recurring_rules WHERE name = 'Regra manipulate'").get();

  assert.equal((await user.post(`/agendamentos/${rule.id}/alternar`).type('form').send({})).status, 403);
  assert.equal((await admin.post(`/agendamentos/${rule.id}/alternar`).type('form').send({})).status, 302);
  assert.equal(env.app.locals.db.prepare('SELECT active FROM recurring_rules WHERE id = ?').get(rule.id).active, 0);

  const edited = await admin.post(`/agendamentos/${rule.id}/editar`).type('form').send({
    ...validRule, name: 'Regra editada', interval_value: '3', interval_unit: 'dia',
  });
  assert.equal(edited.status, 302);
  const updated = env.app.locals.db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(rule.id);
  assert.equal(updated.name, 'Regra editada');
  assert.equal(updated.interval_value, 3);

  assert.equal((await user.post(`/agendamentos/${rule.id}/excluir`).type('form').send({})).status, 403);
  assert.equal((await admin.post(`/agendamentos/${rule.id}/excluir`).type('form').send({})).status, 302);
  assert.equal(env.app.locals.db.prepare('SELECT 1 FROM recurring_rules WHERE id = ?').get(rule.id), undefined);
});

test('executar agora cria um job marcado como gerado pela regra', async () => {
  const admin = await login();
  const res = await admin.post('/agendamentos').type('form').send({ ...validRule, name: 'Regra execução' });
  assert.equal(res.status, 302);
  const rule = env.app.locals.db.prepare("SELECT * FROM recurring_rules WHERE name = 'Regra execução'").get();
  const before = env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;

  assert.equal((await admin.post(`/agendamentos/${rule.id}/executar`).type('form').send({})).status, 302);
  assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, before + 1);
  const job = env.app.locals.db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get();
  assert.equal(job.generated_by_rule_id, rule.id);
  assert.equal(job.status, 'Novo');
  assert.ok(env.app.locals.db.prepare('SELECT last_run_at FROM recurring_rules WHERE id = ?').get(rule.id).last_run_at);
});

test('lista de agendamentos mostra regras e links de gestão', async () => {
  const admin = await login();
  const res = await admin.get('/agendamentos');
  assert.equal(res.status, 200);
  assert.match(res.text, /Agendamentos/);
  assert.match(res.text, /Nova regra/);
  assert.match(res.text, /Regra execução/);
  assert.match(res.text, /Próxima execução/i);
});
