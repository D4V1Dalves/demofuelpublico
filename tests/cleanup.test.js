const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp } = require('./helpers');
const {
  DEFAULT_RETENTION_DAYS,
  retentionDays,
  cleanupAttachments,
} = require('../src/cleanup');
const { toSql } = require('../src/timer');

let env;
let requestId;

let openRequestId;

before(() => {
  env = makeApp();
  const db = env.app.locals.db;
  requestId = db.prepare('SELECT id FROM requests LIMIT 1').get().id;
  // Os testes de remoção usam um job aprovado pelo cliente há 40 dias.
  db.prepare("UPDATE requests SET status = 'Aprovado', completed_at = ? WHERE id = ?").run(
    toSql(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)),
    requestId,
  );
  openRequestId = db.prepare("SELECT id FROM requests WHERE status = 'Em andamento' LIMIT 1").get().id;
});

after(() => {
  env.cleanup();
});

const daysAgo = (days) => toSql(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

function insertAttachment(name, createdAt, jobId = requestId) {
  const db = env.app.locals.db;
  const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const filePath = path.join(env.uploadDir, name);
  fs.writeFileSync(filePath, `conteudo de ${name}`);
  const info = db
    .prepare(
      `INSERT INTO attachments (request_id, user_id, original_name, stored_name, mime_type, size, created_at)
       VALUES (?, ?, ?, ?, 'application/pdf', ?, ?)`,
    )
    .run(jobId, userId, name, name, fs.statSync(filePath).size, createdAt);
  return { id: Number(info.lastInsertRowid), filePath };
}

test('retentionDays falls back to 30 and accepts a positive integer', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 30);
  assert.equal(retentionDays(undefined), 30);
  assert.equal(retentionDays('0'), 30);
  assert.equal(retentionDays('-4'), 30);
  assert.equal(retentionDays('15'), 15);
  assert.equal(retentionDays(45), 45);
});

test('cleanup removes only attachments older than the retention window', () => {
  const oldAttachment = insertAttachment('antigo.pdf', daysAgo(45));
  const freshAttachment = insertAttachment('recente.pdf', daysAgo(2));

  const result = cleanupAttachments(env.app.locals.db, env.uploadDir, { days: 30 });

  assert.equal(result.removed, 1);
  assert.equal(result.files, 1);
  assert.equal(result.days, 30);
  assert.equal(fs.existsSync(oldAttachment.filePath), false, 'old file should be deleted');
  assert.equal(fs.existsSync(freshAttachment.filePath), true, 'fresh file should stay');

  const db = env.app.locals.db;
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id = ?').get(oldAttachment.id).n,
    0,
    'old attachment row should be deleted',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id = ?').get(freshAttachment.id).n,
    1,
    'fresh attachment row should stay',
  );
});

test('cleanup never deletes the job or its history', () => {
  const db = env.app.locals.db;
  const before = db.prepare('SELECT COUNT(*) AS n FROM requests WHERE id = ?').get(requestId).n;
  assert.equal(before, 1);

  cleanupAttachments(db, env.uploadDir, { days: 1 });

  const after = db.prepare('SELECT COUNT(*) AS n FROM requests WHERE id = ?').get(requestId).n;
  assert.equal(after, 1, 'job must be preserved');
});

test('cleanup tolerates a missing file on disk', () => {
  const attachment = insertAttachment('sumiu.pdf', daysAgo(90));
  fs.unlinkSync(attachment.filePath);

  const result = cleanupAttachments(env.app.locals.db, env.uploadDir, { days: 30 });
  assert.equal(result.removed, 1);
  assert.equal(result.files, 0);
  assert.equal(
    env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id = ?').get(attachment.id).n,
    0,
  );
});

test('cleanup nunca apaga anexos de jobs que ainda não foram aprovados', () => {
  const db = env.app.locals.db;
  const old = insertAttachment('entrega-em-andamento.pdf', daysAgo(120), openRequestId);
  const rejectedId = db.prepare("SELECT id FROM requests WHERE status = 'Rejeitado' LIMIT 1").get().id;
  const oldRejected = insertAttachment('entrega-rejeitada.pdf', daysAgo(120), rejectedId);

  cleanupAttachments(db, env.uploadDir, { days: 30 });

  assert.equal(fs.existsSync(old.filePath), true);
  assert.equal(fs.existsSync(oldRejected.filePath), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id IN (?, ?)').get(old.id, oldRejected.id).n, 2);
});

test('cleanup espera o prazo contar a partir da aprovação', () => {
  const db = env.app.locals.db;
  const recentId = db.prepare("SELECT id FROM requests WHERE status = 'Aprovação' LIMIT 1").get().id;
  db.prepare("UPDATE requests SET status = 'Aprovado', completed_at = ? WHERE id = ?").run(daysAgo(5), recentId);
  const att = insertAttachment('aprovado-ontem.pdf', daysAgo(90), recentId);

  cleanupAttachments(db, env.uploadDir, { days: 30 });
  assert.equal(fs.existsSync(att.filePath), true);
});
