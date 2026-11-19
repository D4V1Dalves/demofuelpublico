const fs = require('node:fs');
const path = require('node:path');
const { DAY_MS, toSql } = require('./timer');

const DEFAULT_RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = DAY_MS;

function retentionDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
}

/**
 * Remove anexos (arquivo + registro) só de jobs JÁ APROVADOS pelo cliente há
 * mais tempo que o limite. Jobs abertos, em revisão, aguardando o cliente ou
 * rejeitados nunca perdem anexos, por mais antigos que sejam.
 * Jobs, comentários e histórico permanecem intactos.
 */
function cleanupAttachments(db, uploadDir, { days = DEFAULT_RETENTION_DAYS, now = new Date() } = {}) {
  const cutoff = toSql(new Date(now.getTime() - retentionDays(days) * DAY_MS));
  const rows = db
    .prepare(
      `SELECT a.id, a.stored_name FROM attachments a
       JOIN requests r ON r.id = a.request_id
       WHERE r.status = 'Aprovado' AND r.completed_at IS NOT NULL
         AND r.completed_at < ? AND a.created_at < ?`,
    )
    .all(cutoff, cutoff);

  const root = path.resolve(uploadDir);
  let removed = 0;
  let files = 0;

  for (const row of rows) {
    const target = path.resolve(root, row.stored_name);
    if (path.dirname(target) === root && fs.existsSync(target)) {
      try {
        fs.unlinkSync(target);
        files += 1;
      } catch {
        // Se o arquivo não puder ser removido, o registro ainda é limpo.
      }
    }
    db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    removed += 1;
  }

  return { removed, files, days: retentionDays(days), cutoff };
}

function startAttachmentCleanup(db, uploadDir, { intervalMs = CLEANUP_INTERVAL_MS, days } = {}) {
  const tick = () => {
    try {
      cleanupAttachments(db, uploadDir, { days });
    } catch (error) {
      console.error('Falha ao limpar anexos antigos:', error.message);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  retentionDays,
  cleanupAttachments,
  startAttachmentCleanup,
};
