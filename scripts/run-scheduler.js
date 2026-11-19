/* Executa uma rodada do agendador e da limpeza de anexos e encerra.
   Feito para o cron do cPanel: o Passenger desliga o app quando ninguém
   acessa o site, e os timers internos param junto. Com o cron, os jobs
   agendados saem na hora certa mesmo de madrugada ou no fim de semana.

   Uso (cron a cada minuto, com as mesmas variáveis do app):
     cd /home/conta/fueljobs && /caminho/do/node scripts/run-scheduler.js

   É seguro rodar junto com o app: cada execução é reservada no banco, então
   uma regra nunca gera o mesmo job duas vezes. */
const { applyTimezone } = require('../src/runtime');

applyTimezone(process.env);

const path = require('node:path');
const { openDb, assertProductionDatabase } = require('../src/db');
const { runDueRules } = require('../src/scheduler-core');
const { cleanupAttachments } = require('../src/cleanup');

const root = path.join(__dirname, '..');
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'app.db');
const uploadDir = process.env.UPLOAD_DIR || path.join(root, 'uploads');

function main() {
  assertProductionDatabase(process.env);
  // Só conecta: schema e migrações ficam com o app (o cron roda a cada minuto).
  const db = openDb(dbPath, { skipSetup: true });
  let failed = false;
  try {
    const created = runDueRules(db, new Date(), {
      onError: (rule, error, info) => {
        failed = true;
        console.error(`[agendador] regra #${rule.id} (${rule.name}) falhou (tentativa ${info.attempts}):`, error.message);
      },
    });
    if (created) console.log(`[agendador] ${created} job(s) criado(s).`);
    // A limpeza é diária: roda só na primeira passada de cada hora 3 da manhã.
    const now = new Date();
    if (process.argv.includes('--limpeza') || (now.getHours() === 3 && now.getMinutes() === 0)) {
      const result = cleanupAttachments(db, uploadDir, { days: process.env.ATTACHMENT_RETENTION_DAYS });
      if (result.removed) console.log(`[limpeza] ${result.removed} anexo(s) de jobs aprovados removido(s).`);
    }
  } finally {
    db.close();
  }
  process.exitCode = failed ? 1 : 0;
}

main();
