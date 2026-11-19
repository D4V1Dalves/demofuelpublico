const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp } = require('./helpers');
const { computeNextRun, runDueRules } = require('../src/scheduler');

let env;
before(() => { env = makeApp(); });
after(() => { env.cleanup(); });

function addRule(db, overrides = {}) {
  const rule = {
    name: 'Regra teste',
    client_id: 1,
    title: 'Job automático',
    description: 'Descrição do modelo',
    priority: 'Média',
    responsible_id: null,
    due_days: 3,
    dropbox_url: null,
    interval_value: 2,
    interval_unit: 'dia',
    start_time: '09:30',
    active: 1,
    next_run_at: '2026-11-17 09:30:00',
    created_by: 1,
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO recurring_rules (
      name, client_id, title, description, priority, responsible_id, due_days, dropbox_url,
      interval_value, interval_unit, start_time, active, next_run_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.name, rule.client_id, rule.title, rule.description, rule.priority, rule.responsible_id,
    rule.due_days, rule.dropbox_url, rule.interval_value, rule.interval_unit, rule.start_time,
    rule.active, rule.next_run_at, rule.created_by,
  );
  return Number(info.lastInsertRowid);
}

test('computeNextRun usa o horário configurado e respeita dia/semana/mês', () => {
  const base = { interval_value: 2, start_time: '09:30' };
  assert.equal(computeNextRun({ ...base, interval_unit: 'dia' }, new Date(2026, 10, 17, 8, 0)), '2026-11-17 09:30:00');
  assert.equal(computeNextRun({ ...base, interval_unit: 'dia' }, new Date(2026, 10, 17, 10, 0)), '2026-11-19 09:30:00');
  assert.equal(computeNextRun({ ...base, interval_unit: 'semana' }, new Date(2026, 10, 17, 10, 0)), '2026-12-01 09:30:00');
  assert.equal(computeNextRun({ ...base, interval_unit: 'mes' }, new Date(2026, 10, 17, 10, 0)), '2027-01-17 09:30:00');
});

test('runDueRules gera um job a partir do modelo e atualiza a regra', () => {
  const db = env.app.locals.db;
  const id = addRule(db);
  const now = new Date(2026, 10, 17, 10, 0, 0);

  const created = runDueRules(db, now);
  assert.equal(created, 1);

  const job = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get();
  assert.equal(job.title, 'Job automático');
  assert.equal(job.description, 'Descrição do modelo');
  assert.equal(job.status, 'Novo');
  assert.equal(job.client_id, 1);
  assert.equal(job.created_by, 1);
  assert.equal(job.generated_by_rule_id, id);
  assert.ok(job.due_date);

  const rule = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id);
  assert.equal(rule.last_run_at, '2026-11-17 10:00:00');
  assert.equal(rule.next_run_at, '2026-11-19 09:30:00');
});

test('runDueRules ignora regras inativas e futuras', () => {
  const db = env.app.locals.db;
  addRule(db, { name: 'Inativa', active: 0 });
  addRule(db, { name: 'Futura', next_run_at: '2099-01-01 09:30:00' });
  const before = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  assert.equal(runDueRules(db, new Date(2026, 10, 17, 10, 0, 0)), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, before);
});

test('runDueRules não faz catch-up em lote', () => {
  const db = env.app.locals.db;
  addRule(db, { name: 'Atrasada', next_run_at: '2020-01-01 09:30:00' });
  assert.equal(runDueRules(db, new Date(2026, 10, 17, 10, 0, 0)), 1);
  const rule = db.prepare("SELECT * FROM recurring_rules WHERE name = 'Atrasada'").get();
  assert.equal(rule.next_run_at, '2026-11-19 09:30:00');
});
