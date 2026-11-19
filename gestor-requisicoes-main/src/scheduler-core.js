const pad = (value) => String(value).padStart(2, '0');

function formatLocalDateTime(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseStartTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

function addDays(date, days) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date, months) {
  const day = date.getDate();
  const result = new Date(
    date.getFullYear(),
    date.getMonth() + months,
    1,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

function computeNextRun(rule, now = new Date()) {
  const time = parseStartTime(rule.start_time) || { hours: 9, minutes: 0 };
  const interval = Math.max(1, Number(rule.interval_value) || 1);
  const unit = rule.interval_unit;
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    time.hours,
    time.minutes,
    0,
    0,
  );

  let guard = 0;
  while (candidate.getTime() <= now.getTime() && guard < 100000) {
    if (unit === 'dia') {
      candidate.setDate(candidate.getDate() + interval);
    } else if (unit === 'semana') {
      candidate.setDate(candidate.getDate() + interval * 7);
    } else {
      const next = addMonths(candidate, interval);
      candidate.setFullYear(next.getFullYear(), next.getMonth(), next.getDate());
    }
    guard += 1;
  }

  return formatLocalDateTime(candidate);
}

function generateJob(db, rule, now) {
  const nowText = formatLocalDateTime(now);
  const dueDate = rule.due_days > 0 ? formatLocalDate(addDays(now, rule.due_days)) : null;
  db.prepare(
    `INSERT INTO requests (
       client_id, title, description, status, priority, responsible_id, due_date,
       created_by, dropbox_url, generated_by_rule_id, created_at, updated_at
     ) VALUES (?, ?, ?, 'Novo', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rule.client_id,
    rule.title,
    rule.description || '',
    rule.priority,
    rule.responsible_id,
    dueDate,
    rule.created_by,
    rule.dropbox_url || null,
    rule.id,
    nowText,
    nowText,
  );
  db.prepare(
    `UPDATE recurring_rules SET last_run_at = ?, next_run_at = ?,
       updated_at = datetime('now','localtime') WHERE id = ?`,
  ).run(nowText, computeNextRun(rule, now), rule.id);
}

// Uma regra com erro não impede as demais. Falhas passageiras (banco ocupado,
// conexão caída) são tentadas de novo nos próximos ciclos; só depois de
// MAX_RULE_ATTEMPTS falhas seguidas a ocorrência é pulada (next_run_at avança),
// para não repetir o mesmo erro para sempre. O contador fica no banco
// (recurring_rules.failure_count): vale entre reinícios e entre processos.
const MAX_RULE_ATTEMPTS = 3;

function runDueRules(db, now = new Date(), { onError = logRuleError } = {}) {
  const nowText = formatLocalDateTime(now);
  const due = db
    .prepare('SELECT * FROM recurring_rules WHERE active = 1 AND next_run_at <= ? ORDER BY id')
    .all(nowText);

  let created = 0;
  for (const rule of due) {
    db.exec('BEGIN');
    try {
      // Reserva a execução: só quem conseguir avançar next_run_at a partir do
      // valor lido cria o job. Outro processo (ou o cron) que leu a mesma
      // regra encontra o valor já mudado e pula, sem duplicar o job.
      const claim = db
        .prepare(
          `UPDATE recurring_rules SET next_run_at = ? WHERE id = ? AND next_run_at = ? AND active = 1`,
        )
        .run(computeNextRun(rule, now), rule.id, rule.next_run_at);
      if (claim.changes !== 1) {
        db.exec('ROLLBACK');
        continue;
      }
      generateJob(db, rule, now);
      db.exec('COMMIT');
      if (rule.failure_count) {
        db.prepare('UPDATE recurring_rules SET failure_count = 0 WHERE id = ?').run(rule.id);
      }
      created += 1;
    } catch (error) {
      db.exec('ROLLBACK');
      const attempts = Number(rule.failure_count || 0) + 1;
      const skipped = attempts >= MAX_RULE_ATTEMPTS;
      try {
        if (skipped) {
          db.prepare(
            `UPDATE recurring_rules SET next_run_at = ?, failure_count = 0,
               updated_at = datetime('now','localtime') WHERE id = ?`,
          ).run(computeNextRun(rule, now), rule.id);
        } else {
          db.prepare('UPDATE recurring_rules SET failure_count = ? WHERE id = ?').run(attempts, rule.id);
        }
      } catch {
        // Banco indisponível até para registrar a falha: tenta de novo no próximo ciclo.
      }
      onError(rule, error, { attempts, skipped });
    }
  }
  return created;
}

function logRuleError(rule, error, { attempts, skipped } = {}) {
  const outcome = skipped
    ? `ocorrência pulada após ${attempts} tentativas`
    : `tentativa ${attempts} de ${MAX_RULE_ATTEMPTS}, nova tentativa no próximo ciclo`;
  console.error(`Falha ao executar o agendamento #${rule.id} (${rule.name}); ${outcome}:`, error.message);
}

function runRuleNow(db, id, now = new Date()) {
  const rule = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id);
  if (!rule) return false;
  db.exec('BEGIN');
  try {
    generateJob(db, rule, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

module.exports = {
  computeNextRun,
  runDueRules,
  runRuleNow,
  formatLocalDateTime,
  formatLocalDate,
  parseStartTime,
};
