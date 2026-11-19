const { applyTimezone, uploadDirWarning } = require('./src/runtime');

// Antes de qualquer data: o fuso define agendamentos, prazos e relatórios.
applyTimezone(process.env);

const path = require('node:path');
const { createApp } = require('./src/app');
const { shouldSeed, assertProductionDatabase } = require('./src/db');
const { startScheduler } = require('./src/scheduler');
const { startAttachmentCleanup } = require('./src/cleanup');

const port = Number(process.env.PORT || 3000);
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const seedData = shouldSeed(process.env);
const retentionDays = process.env.ATTACHMENT_RETENTION_DAYS;

assertProductionDatabase(process.env);
const uploadWarning = uploadDirWarning(uploadDir, __dirname, process.env);
if (uploadWarning) console.warn(uploadWarning);

const app = createApp({ dbPath, uploadDir, seedData });

app.listen(port, () => {
  startScheduler(app.locals.db);
  startAttachmentCleanup(app.locals.db, uploadDir, { days: retentionDays });
  console.log(`Fuel Jobs rodando em http://localhost:${port} (fuso ${process.env.TZ})`);
});
