const { computeNextRun, runDueRules, runRuleNow } = require('./scheduler-core');

const SCHEDULER_INTERVAL_MS = 60 * 1000;

function startScheduler(db, intervalMs = SCHEDULER_INTERVAL_MS) {
  const tick = () => {
    try {
      runDueRules(db, new Date());
    } catch (error) {
      console.error('Falha ao executar agendamentos:', error.message);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { computeNextRun, runDueRules, runRuleNow, startScheduler };
