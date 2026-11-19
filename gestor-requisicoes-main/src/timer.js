const DAY_MS = 24 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, '0');
}

function toSql(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseSql(value) {
  if (!value) return null;
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function getTimer(db, requestId, userId) {
  return (
    db
      .prepare('SELECT * FROM time_entries WHERE request_id = ? AND user_id = ?')
      .get(requestId, userId) || null
  );
}

function getTimersForRequest(db, requestId) {
  return db
    .prepare(
      `SELECT t.*, u.name AS user_name FROM time_entries t
       JOIN users u ON u.id = t.user_id
       WHERE t.request_id = ? ORDER BY t.id`,
    )
    .all(requestId);
}

function elapsedSeconds(row, now = new Date()) {
  if (!row) return 0;
  let total = Number(row.accumulated_seconds || 0);
  if (row.status === 'running') {
    const started = parseSql(row.started_at);
    if (started) total += Math.max(0, Math.floor((now.getTime() - started) / 1000));
  }
  return total;
}

function totalSeconds(rows, now = new Date()) {
  return rows.reduce((sum, row) => sum + elapsedSeconds(row, now), 0);
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

function startTimer(db, requestId, userId, now = new Date()) {
  const current = getTimer(db, requestId, userId);
  if (current && current.status === 'running') return current;

  if (!current) {
    db.prepare(
      `INSERT INTO time_entries (request_id, user_id, status, started_at, accumulated_seconds, created_at, updated_at)
       VALUES (?, ?, 'running', ?, 0, ?, ?)`,
    ).run(requestId, userId, toSql(now), toSql(now), toSql(now));
    return getTimer(db, requestId, userId);
  }

  // Pausado ou finalizado, o timer retoma de onde parou: reabrir um job para
  // ajustes não pode apagar as horas já registradas nele.
  const accumulated = Number(current.accumulated_seconds || 0);
  db.prepare(
    `UPDATE time_entries SET status = 'running', started_at = ?, accumulated_seconds = ?, updated_at = ?
     WHERE id = ?`,
  ).run(toSql(now), accumulated, toSql(now), current.id);
  return getTimer(db, requestId, userId);
}

function pauseTimer(db, requestId, userId, now = new Date()) {
  const current = getTimer(db, requestId, userId);
  if (!current || current.status !== 'running') return current;

  const started = parseSql(current.started_at);
  const extra = started ? Math.max(0, Math.floor((now.getTime() - started) / 1000)) : 0;
  db.prepare(
    `UPDATE time_entries SET status = 'paused', started_at = NULL,
       accumulated_seconds = accumulated_seconds + ?, updated_at = ? WHERE id = ?`,
  ).run(extra, toSql(now), current.id);
  return getTimer(db, requestId, userId);
}

function finishTimer(db, requestId, userId, now = new Date()) {
  const paused = pauseTimer(db, requestId, userId, now);
  if (!paused) return null;
  db.prepare("UPDATE time_entries SET status = 'finished', updated_at = ? WHERE id = ?").run(
    toSql(now),
    paused.id,
  );
  return getTimer(db, requestId, userId);
}

module.exports = {
  DAY_MS,
  toSql,
  parseSql,
  getTimer,
  getTimersForRequest,
  elapsedSeconds,
  totalSeconds,
  formatDuration,
  startTimer,
  pauseTimer,
  finishTimer,
};
