const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../src/app');

// TEST_MYSQL=1 roda a suíte contra um MySQL real (DB_HOST, DB_PORT, DB_USER,
// DB_PASSWORD): cada makeApp() ganha um banco novo, apagado no cleanup.
const useTestMysql = process.env.TEST_MYSQL === '1';
function mysqlAdmin(sql) {
  const script = `
    const mysql = require('mysql2/promise');
    (async () => {
      const c = await mysql.createConnection({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER, password: process.env.DB_PASSWORD,
      });
      await c.query(process.argv[1]);
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });`;
  execFileSync(process.execPath, ['-e', script, sql], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
}

function makeApp(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gestor-test-'));
  const dbPath = path.join(dir, 'app.db');
  const uploadDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  let mysqlDatabase = null;
  if (useTestMysql) {
    mysqlDatabase = `gestor_t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    mysqlAdmin(`CREATE DATABASE \`${mysqlDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }

  const app = createApp({
    dbPath,
    uploadDir,
    seedData: options.seedData !== false,
    dbOptions: mysqlDatabase ? { driver: 'mysql', database: mysqlDatabase } : undefined,
  });

  return {
    app,
    dir,
    dbPath,
    uploadDir,
    cleanup() {
      // Windows cannot delete a directory while SQLite still holds its file open.
      app.locals.db.close();
      if (mysqlDatabase) mysqlAdmin(`DROP DATABASE IF EXISTS \`${mysqlDatabase}\``);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { makeApp };
