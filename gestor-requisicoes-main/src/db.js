const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, randomToken } = require('./security');
const { createMysqlDb } = require('./mysql-db');

const MYSQL_SCHEMA_PATH = path.join(__dirname, '..', 'database', 'mysql-schema.sql');

function useMysql(options = {}) {
  if (options.driver === 'mysql') return true;
  if (options.driver === 'sqlite') return false;
  const driver = String(process.env.DB_DRIVER || '').toLowerCase();
  if (driver === 'mysql' || driver === 'mariadb') return true;
  // Socket do cPanel (localhost sem TCP) também indica MySQL.
  return Boolean(
    process.env.DB_HOST || process.env.MYSQL_HOST || process.env.DB_SOCKET || process.env.MYSQL_SOCKET,
  );
}

// Em produção o app nunca cai silenciosamente no SQLite: um arquivo dentro da
// pasta do app seria apagado na próxima atualização, levando todos os jobs.
// ALLOW_SQLITE=1 libera de propósito (ex.: piloto num servidor próprio).
function assertProductionDatabase(env = process.env) {
  if (env.NODE_ENV !== 'production' || env.ALLOW_SQLITE === '1') return;
  const driver = String(env.DB_DRIVER || '').toLowerCase();
  if (driver === 'sqlite') {
    throw new Error('DB_DRIVER=sqlite em produção. Configure o MySQL ou defina ALLOW_SQLITE=1 de propósito.');
  }
  const mysql =
    driver === 'mysql' || driver === 'mariadb' || env.DB_HOST || env.MYSQL_HOST || env.DB_SOCKET || env.MYSQL_SOCKET;
  if (!mysql) {
    throw new Error(
      'Banco não configurado: em produção defina DB_HOST (ou DB_SOCKET), DB_NAME, DB_USER e DB_PASSWORD. ' +
        'Sem isso o app gravaria num arquivo dentro da pasta do app, apagado na próxima atualização.',
    );
  }
}

function mysqlConfigFromEnv(options = {}) {
  return {
    host: options.host || process.env.DB_HOST || process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(options.port || process.env.DB_PORT || process.env.MYSQL_PORT || 3306),
    user: options.user || process.env.DB_USER || process.env.MYSQL_USER || 'root',
    password:
      options.password !== undefined
        ? options.password
        : process.env.DB_PASSWORD !== undefined
          ? process.env.DB_PASSWORD
          : process.env.MYSQL_PASSWORD || '',
    database: options.database || process.env.DB_NAME || process.env.MYSQL_DATABASE || 'fuel_jobs',
    socketPath: options.socketPath || process.env.DB_SOCKET || process.env.MYSQL_SOCKET || undefined,
    connectTimeoutMs: Number(options.connectTimeoutMs || process.env.DB_CONNECT_TIMEOUT_MS || 15000),
    // Enquanto uma consulta MySQL roda, o processo inteiro espera (ponte síncrona).
    // 15 s limita quanto tempo uma consulta lenta segura os outros usuários.
    queryTimeoutMs: Number(options.queryTimeoutMs || process.env.DB_QUERY_TIMEOUT_MS || 15000),
  };
}

function ensureMysqlColumn(db, table, name, definition) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    )
    .get(table, name);
  if (Number(row && row.n)) return;
  try {
    db.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`);
  } catch (error) {
    // Outro processo subindo ao mesmo tempo já criou a coluna.
    if (error.code !== 'ER_DUP_FIELDNAME') throw error;
  }
}

function ensureMysqlIndex(db, table, name, definition) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    )
    .get(table, name);
  if (Number(row && row.n)) return;
  try {
    db.exec(`ALTER TABLE \`${table}\` ADD ${definition}`);
  } catch (error) {
    // Outro processo subindo ao mesmo tempo já criou o índice.
    if (error.code !== 'ER_DUP_KEYNAME') throw error;
  }
}

// `CREATE TABLE IF NOT EXISTS` não altera tabelas já existentes. Esta rotina
// replica no MySQL as colunas/índices adicionados depois da primeira versão do
// schema (o caminho SQLite faz o equivalente com ensureColumn).
function migrateMysql(db) {
  for (const [name, definition] of [
    ['admin_approved_at', 'DATETIME NULL'],
    ['client_approved_at', 'DATETIME NULL'],
    ['client_rejected_at', 'DATETIME NULL'],
    ['client_rejection_reason', 'TEXT NULL'],
    ['approval_token', 'VARCHAR(64) NULL'],
    ['dropbox_url', 'TEXT NULL'],
    ['generated_by_rule_id', 'INT UNSIGNED NULL'],
    ['completed_at', 'DATETIME NULL'],
    ['cycle_started_at', 'DATETIME NULL'],
    ['created_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ]) {
    ensureMysqlColumn(db, 'requests', name, definition);
  }
  for (const [name, definition] of [
    ['description', 'TEXT NULL'],
    ['website', 'TEXT NULL'],
    ['instagram', 'TEXT NULL'],
    ['facebook', 'TEXT NULL'],
    ['whatsapp', 'TEXT NULL'],
    ['linkedin', 'TEXT NULL'],
    ['phone', 'VARCHAR(40) NULL'],
    ['email', 'VARCHAR(190) NULL'],
  ]) {
    ensureMysqlColumn(db, 'clients', name, definition);
  }
  ensureMysqlColumn(db, 'users', 'avatar', 'VARCHAR(255) NULL');
  ensureMysqlColumn(db, 'users', 'active', 'TINYINT(1) NOT NULL DEFAULT 1');
  ensureMysqlColumn(db, 'comments', 'edited_at', 'DATETIME NULL');
  ensureMysqlColumn(db, 'recurring_rules', 'failure_count', 'INT NOT NULL DEFAULT 0');
  migrateMysqlStatusRename(db);
  ensureMysqlIndex(
    db,
    'requests',
    'uq_requests_approval_token',
    'UNIQUE KEY uq_requests_approval_token (approval_token)',
  );
  for (const [table, name, definition] of [
    ['users', 'uq_users_email', 'UNIQUE KEY uq_users_email (email)'],
    ['sessions', 'idx_sessions_user', 'KEY idx_sessions_user (user_id)'],
    ['sessions', 'idx_sessions_expires', 'KEY idx_sessions_expires (expires_at)'],
    ['clients', 'idx_clients_name', 'KEY idx_clients_name (name)'],
    ['requests', 'idx_requests_status', 'KEY idx_requests_status (status)'],
    ['requests', 'idx_requests_client', 'KEY idx_requests_client (client_id)'],
    ['requests', 'idx_requests_responsible', 'KEY idx_requests_responsible (responsible_id)'],
    ['requests', 'idx_requests_due_date', 'KEY idx_requests_due_date (due_date)'],
    ['recurring_rules', 'idx_rules_next_run', 'KEY idx_rules_next_run (active, next_run_at)'],
    ['comments', 'idx_comments_request', 'KEY idx_comments_request (request_id)'],
    ['attachments', 'idx_attachments_request', 'KEY idx_attachments_request (request_id)'],
    ['time_entries', 'idx_time_entries_request', 'KEY idx_time_entries_request (request_id)'],
    [
      'time_entries',
      'uq_time_entries_request_user',
      'UNIQUE KEY uq_time_entries_request_user (request_id, user_id)',
    ],
  ]) {
    ensureMysqlIndex(db, table, name, definition);
  }

  // Normalizações de dados aplicadas em toda inicialização (idempotentes).
  db.exec("UPDATE requests SET status = 'Aprovado' WHERE status = 'Concluído'");
  db.exec(`
    UPDATE requests SET completed_at = COALESCE(updated_at, created_at)
    WHERE status = 'Aprovado' AND completed_at IS NULL
  `);
  // v7.3: jobs que já tinham começado antes do relato por ciclo mantêm os comentários existentes.
  db.exec(`
    UPDATE requests SET cycle_started_at = created_at
    WHERE cycle_started_at IS NULL AND status <> 'Novo'
  `);
}

function openMysqlDb(options) {
  const db = createMysqlDb(mysqlConfigFromEnv(options));
  // skipSetup: só conecta (usado pelo cron, que roda a cada minuto; o schema e
  // as migrações ficam com o app).
  if (options.skipSetup) return db;
  db.exec(fs.readFileSync(MYSQL_SCHEMA_PATH, 'utf8'));
  migrateMysql(db);
  return db;
}

function ensureColumn(db, table, name, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  if (existing.includes(name)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  } catch (error) {
    if (!/duplicate column/i.test(String(error.message))) throw error;
  }
}

// Renomeia a etapa "Aguardando" sem perder dados. O MySQL guarda a lista de
// status em um CHECK, então o constraint antigo precisa sair antes do UPDATE e
// voltar com a lista nova. Tudo é idempotente para rodar a cada boot.
function migrateMysqlStatusRename(db) {
  let clause = null;
  try {
    const row = db
      .prepare(
        `SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_requests_status'`,
      )
      .get();
    clause = row && row.clause;
  } catch {
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM information_schema.table_constraints
           WHERE table_schema = DATABASE() AND table_name = 'requests'
             AND constraint_name = 'chk_requests_status' AND constraint_type = 'CHECK'`,
        )
        .get();
      clause = Number(row && row.n) ? 'Aguardando' : null;
    } catch {
      clause = null;
    }
  }

  const legacy = Boolean(clause && /Aguardando/i.test(String(clause)));
  let dropped = false;
  if (legacy) {
    for (const sql of [
      'ALTER TABLE requests DROP CHECK chk_requests_status',
      'ALTER TABLE requests DROP CONSTRAINT chk_requests_status',
    ]) {
      try {
        db.exec(sql);
        dropped = true;
        break;
      } catch {
        /* tenta a sintaxe da outra família (MySQL vs. MariaDB) */
      }
    }
    // Sem remover o CHECK antigo o UPDATE violaria o constraint e derrubaria o
    // boot. Nesse caso o app sobe com os dados intactos e avisa no log.
    if (!dropped) {
      console.warn(
        '[db] Não foi possível remover chk_requests_status; a renomeação de "Aguardando" ficará pendente.',
      );
      return;
    }
  }

  db.exec("UPDATE requests SET status = 'Em processo' WHERE status = 'Aguardando'");

  if (legacy) {
    try {
      db.exec(
        `ALTER TABLE requests ADD CONSTRAINT chk_requests_status CHECK (
           status IN ('Novo', 'Em andamento', 'Em processo', 'Aprovação', 'Aprovado', 'Rejeitado')
         )`,
      );
    } catch {
      /* o schema atualizado recria o constraint no próximo deploy */
    }
  }
}

function openDb(dbPath, options = {}) {
  if (useMysql(options)) return openMysqlDb(options);

  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.driver = 'sqlite';
  if (options.skipSetup) {
    db.exec('PRAGMA foreign_keys = ON;');
    return db;
  }

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      responsible_id INTEGER REFERENCES users(id),
      due_date TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS recurring_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL,
      responsible_id INTEGER REFERENCES users(id),
      due_days INTEGER NOT NULL DEFAULT 0,
      dropbox_url TEXT,
      interval_value INTEGER NOT NULL,
      interval_unit TEXT NOT NULL CHECK (interval_unit IN ('dia', 'semana', 'mes')),
      start_time TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      edited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('running', 'paused', 'finished')),
      started_at TEXT,
      accumulated_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (request_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_name TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_comments_request ON comments(request_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_request ON attachments(request_id);
    CREATE INDEX IF NOT EXISTS idx_time_entries_request ON time_entries(request_id);
  `);

  for (const [name, definition] of [
    ['admin_approved_at', 'TEXT'],
    ['client_approved_at', 'TEXT'],
    ['client_rejected_at', 'TEXT'],
    ['client_rejection_reason', 'TEXT'],
    ['approval_token', 'TEXT'],
    ['dropbox_url', 'TEXT'],
    ['generated_by_rule_id', 'INTEGER'],
    ['completed_at', 'TEXT'],
    ['cycle_started_at', 'TEXT'],
    ['created_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ]) {
    ensureColumn(db, 'requests', name, definition);
  }
  for (const [name, definition] of [
    ['description', "TEXT NOT NULL DEFAULT ''"],
    ['website', 'TEXT'],
    ['instagram', 'TEXT'],
    ['facebook', 'TEXT'],
    ['whatsapp', 'TEXT'],
    ['linkedin', 'TEXT'],
    ['phone', 'TEXT'],
    ['email', 'TEXT'],
  ]) {
    ensureColumn(db, 'clients', name, definition);
  }
  ensureColumn(db, 'users', 'avatar', 'TEXT');
  ensureColumn(db, 'users', 'active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'comments', 'edited_at', 'TEXT');
  ensureColumn(db, 'recurring_rules', 'failure_count', 'INTEGER NOT NULL DEFAULT 0');
  // v7.2: "Aguardando" passa a se chamar "Em processo".
  db.exec("UPDATE requests SET status = 'Em processo' WHERE status = 'Aguardando'");
  // v6: a etapa final passa a se chamar Aprovado.
  db.exec("UPDATE requests SET status = 'Aprovado' WHERE status = 'Concluído'");
  // Bancos criados antes da v4 não têm completed_at nos jobs já aprovados.
  db.exec(`
    UPDATE requests SET completed_at = COALESCE(updated_at, created_at)
    WHERE status = 'Aprovado' AND completed_at IS NULL;
  `);
  // v7.3: jobs que já tinham começado antes do relato por ciclo mantêm os comentários existentes.
  db.exec(`
    UPDATE requests SET cycle_started_at = created_at
    WHERE cycle_started_at IS NULL AND status <> 'Novo'
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_approval_token
    ON requests(approval_token) WHERE approval_token IS NOT NULL;
  `);

  return db;
}

function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Dois processos subindo juntos com o banco vazio: tudo numa transação e, se o
// outro processo chegou primeiro (e-mail duplicado), este só desiste.
function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;
  db.exec('BEGIN');
  try {
    const created = seedData(db);
    db.exec('COMMIT');
    return created;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transação já encerrada */
    }
    const duplicate = error.code === 'ER_DUP_ENTRY' || /UNIQUE constraint failed/i.test(String(error.message));
    if (duplicate) return false;
    throw error;
  }
}

function seedData(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;

  const addUser = db.prepare(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
  );
  const adminId = Number(
    addUser.run('Administrador', 'admin@empresa.local', hashPassword('Admin@123'), 'admin').lastInsertRowid,
  );
  const userId = Number(
    addUser.run('Maria Atendimento', 'usuario@empresa.local', hashPassword('Usuario@123'), 'user').lastInsertRowid,
  );

  const addClient = db.prepare(`
    INSERT INTO clients (name, description, website, instagram, facebook, whatsapp, linkedin, phone, email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clientSeeds = [
    ['Acme Ltda', 'Indústria de máquinas e equipamentos.', 'https://acme.com.br', 'https://instagram.com/acme', 'https://facebook.com/acme', 'https://wa.me/5511999990001', 'https://linkedin.com/company/acme', '(11) 99999-0001', 'contato@acme.com.br'],
    ['Globex S.A.', 'Rede de lojas de varejo com foco em moda.', 'https://globex.com.br', 'https://instagram.com/globex', 'https://facebook.com/globex', 'https://wa.me/5511999990002', 'https://linkedin.com/company/globex', '(11) 99999-0002', 'contato@globex.com.br'],
    ['Initech', 'Empresa de tecnologia e serviços digitais.', 'https://initech.com.br', 'https://instagram.com/initech', 'https://facebook.com/initech', 'https://wa.me/5511999990003', 'https://linkedin.com/company/initech', '(11) 99999-0003', 'contato@initech.com.br'],
  ];
  const clientIds = clientSeeds.map((client) => Number(addClient.run(...client).lastInsertRowid));

  const pad = (value) => String(value).padStart(2, '0');
  const nowDate = new Date();
  const nowSql =
    `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())} ` +
    `${pad(nowDate.getHours())}:${pad(nowDate.getMinutes())}:${pad(nowDate.getSeconds())}`;
  const completedAt = nowSql;
  const addRequest = db.prepare(`
    INSERT INTO requests (
      client_id, title, description, status, priority, responsible_id, due_date, created_by,
      admin_approved_at, client_approved_at, client_rejected_at, client_rejection_reason,
      approval_token, dropbox_url, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rows = [
    [clientIds[0], 'Ajuste no layout do portal', 'Alinhar banners e cores da marca.', 'Novo', 'Alta', userId, isoDate(3), adminId, null, null, null, null, null, null, null],
    [clientIds[1], 'Relatório mensal de vendas', 'Exportar dados de setembro.', 'Em andamento', 'Média', userId, isoDate(1), adminId, null, null, null, null, null, null, null],
    [clientIds[2], 'Correção de login', 'Falha ao entrar com e-mail corporativo.', 'Em andamento', 'Urgente', adminId, isoDate(-2), adminId, null, null, null, null, null, null, null],
    [clientIds[0], 'Novo campo no cadastro', 'Incluir campo de telefone secundário.', 'Em processo', 'Baixa', userId, isoDate(7), adminId, null, null, null, null, null, null, null],
    [clientIds[1], 'Migração de dados', 'Validar importação legada.', 'Aprovado', 'Alta', adminId, isoDate(-5), adminId, nowSql, nowSql, null, null, randomToken(), 'https://www.dropbox.com/s/exemplo/migracao', completedAt],
    [clientIds[2], 'Treinamento da equipe', 'Agendar sessão de 1h com o time.', 'Novo', 'Média', userId, isoDate(10), adminId, null, null, null, null, null, null, null],
    [clientIds[0], 'Proposta de campanha', 'Criar linha visual e roteiro para campanha de lançamento.', 'Aprovação', 'Alta', userId, isoDate(2), adminId, nowSql, null, null, null, randomToken(), null, null],
    [clientIds[1], 'Revisão de contrato', 'Revisar cláusulas de prazo e pagamento.', 'Rejeitado', 'Média', adminId, isoDate(1), adminId, nowSql, null, nowSql, 'O prazo proposto não atende ao cliente.', randomToken(), null, null],
  ];
  const requestIds = rows.map((row) => Number(addRequest.run(...row).lastInsertRowid));

  const addComment = db.prepare(
    'INSERT INTO comments (request_id, user_id, body) VALUES (?, ?, ?)',
  );
  addComment.run(requestIds[1], userId, 'Já separei os dados, faltou a validação final.');
  addComment.run(requestIds[2], adminId, 'Investigando o problema de autenticação.');
  addComment.run(requestIds[6], adminId, 'Roteiro inicial pronto. Aguardando aprovação do cliente.');
  addComment.run(requestIds[4], userId, 'Importação validada com sucesso.');

  // Jobs de exemplo que já começaram têm um ciclo de trabalho aberto desde a criação.
  db.exec("UPDATE requests SET cycle_started_at = created_at WHERE cycle_started_at IS NULL AND status <> 'Novo'");

  return true;
}

// Dados de exemplo (contas com senha conhecida e jobs fictícios) só fora de
// produção, a menos que SEED diga o contrário. Em produção, o primeiro acesso
// abre a tela de instalação para criar o administrador.
function shouldSeed(env = process.env) {
  if (env.SEED !== undefined) return env.SEED === 'true';
  return env.NODE_ENV !== 'production';
}

module.exports = { openDb, seed, shouldSeed, useMysql, mysqlConfigFromEnv, assertProductionDatabase };
