const fs = require('node:fs');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { toMysql } = require('../src/sql-dialect');
const { useMysql, mysqlConfigFromEnv } = require('../src/db');

const ENV_KEYS = [
  'DB_DRIVER',
  'DB_HOST',
  'MYSQL_HOST',
  'DB_PORT',
  'MYSQL_PORT',
  'DB_USER',
  'MYSQL_USER',
  'DB_PASSWORD',
  'MYSQL_PASSWORD',
  'DB_NAME',
  'MYSQL_DATABASE',
  'DB_SOCKET',
  'MYSQL_SOCKET',
];

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

// Os testes de configuração partem de um ambiente sem nenhuma variável DB_*
// (mesmo quando a suíte roda contra um MySQL real com TEST_MYSQL=1).
function resetEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test('dialect rewrites SQLite datetime and date helpers to MySQL functions', () => {
  assert.equal(
    toMysql("INSERT INTO t (created_at) VALUES (datetime('now','localtime'))"),
    'INSERT INTO t (created_at) VALUES (NOW())',
  );
  assert.equal(
    toMysql("SELECT date('now','localtime') AS today"),
    'SELECT CURDATE() AS today',
  );
  assert.equal(
    toMysql("UPDATE t SET updated_at = datetime('now', 'localtime') WHERE id = ?"),
    'UPDATE t SET updated_at = NOW() WHERE id = ?',
  );
});

test('dialect drops SQLite-only collations and insert modifiers', () => {
  assert.equal(
    toMysql('SELECT * FROM clients ORDER BY name COLLATE NOCASE'),
    'SELECT * FROM clients ORDER BY name',
  );
  assert.equal(
    toMysql('INSERT OR IGNORE INTO sessions (token_hash) VALUES (?)'),
    'INSERT IGNORE INTO sessions (token_hash) VALUES (?)',
  );
  assert.equal(
    toMysql('INSERT OR REPLACE INTO sessions (token_hash) VALUES (?)'),
    'REPLACE INTO sessions (token_hash) VALUES (?)',
  );
});

test('dialect leaves portable SQL and placeholders untouched', () => {
  const sql = 'SELECT r.*, c.name AS client_name FROM requests r JOIN clients c ON c.id = r.client_id WHERE r.status = ?';
  assert.equal(toMysql(sql), sql);
});

test('MySQL schema file covers every table used by the app', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'mysql-schema.sql'),
    'utf8',
  );

  for (const table of [
    'users',
    'sessions',
    'clients',
    'requests',
    'recurring_rules',
    'comments',
    'attachments',
    'time_entries',
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), `missing ${table}`);
  }

  assert.match(schema, /avatar VARCHAR\(255\) NULL/);
  assert.match(schema, /ENGINE=InnoDB/);
  assert.match(schema, /utf8mb4/);
  assert.match(schema, /SET NAMES utf8mb4/);
  assert.match(schema, /uq_users_email/);
  assert.match(schema, /chk_requests_status/);
});

test('driver selection honours explicit options, DB_DRIVER and DB_HOST', () => {
  resetEnv();
  assert.equal(useMysql({ driver: 'mysql' }), true);
  assert.equal(useMysql({ driver: 'sqlite' }), false);
  assert.equal(useMysql(), false);

  process.env.DB_DRIVER = 'mysql';
  assert.equal(useMysql(), true);

  process.env.DB_DRIVER = 'mariadb';
  assert.equal(useMysql(), true);

  process.env.DB_DRIVER = 'sqlite';
  assert.equal(useMysql(), false);

  delete process.env.DB_DRIVER;
  process.env.DB_HOST = 'localhost';
  assert.equal(useMysql(), true);

  process.env.DB_HOST = '';
  process.env.MYSQL_HOST = 'db.example.com';
  assert.equal(useMysql(), true);

  // Uma opção explícita sempre vence as variáveis de ambiente.
  assert.equal(useMysql({ driver: 'sqlite' }), false);
});

test('MySQL config reads DB_* variables and applies defaults', () => {
  resetEnv();
  process.env.DB_HOST = 'mysql.hostinger.com';
  process.env.DB_PORT = '3307';
  process.env.DB_USER = 'fuel_user';
  process.env.DB_PASSWORD = 'segredo';
  process.env.DB_NAME = 'fuel_jobs_db';

  assert.deepEqual(
    {
      host: mysqlConfigFromEnv().host,
      port: mysqlConfigFromEnv().port,
      user: mysqlConfigFromEnv().user,
      password: mysqlConfigFromEnv().password,
      database: mysqlConfigFromEnv().database,
    },
    {
      host: 'mysql.hostinger.com',
      port: 3307,
      user: 'fuel_user',
      password: 'segredo',
      database: 'fuel_jobs_db',
    },
  );

  resetEnv();
  const defaults = mysqlConfigFromEnv();
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 3306);
  assert.equal(defaults.user, 'root');
  assert.equal(defaults.database, 'fuel_jobs');
});
