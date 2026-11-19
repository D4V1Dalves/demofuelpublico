/* Worker que mantém a conexão MySQL e responde de forma síncrona para a
   thread principal (Atomics.wait). O app inteiro usa a API síncrona do
   node:sqlite; este worker preserva essa API quando o banco é MySQL. */
const { parentPort, workerData } = require('node:worker_threads');
const mysql = require('mysql2/promise');

const control = new Int32Array(workerData.control);
const output = new Uint8Array(workerData.output);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let connection = null;

// Transação em andamento (BEGIN ... COMMIT/ROLLBACK). Se a conexão cair no
// meio dela, o MySQL desfaz o que já foi feito; reconectar e seguir gravaria
// só o restante (fora da transação). Por isso a transação fica "quebrada":
// tudo é recusado até o ROLLBACK, e o COMMIT falha.
let inTransaction = false;
let transactionBroken = false;
const TX_BEGIN = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const TX_END = /^\s*(COMMIT|ROLLBACK)\b/i;
const TX_ROLLBACK = /^\s*ROLLBACK\b/i;

// A thread principal fica bloqueada em Atomics.wait e não processa eventos do
// worker. Este port avisa a morte do worker de forma síncrona (receiveMessageOnPort).
const deathPort = workerData.deathPort;
if (deathPort) {
  process.on('exit', () => {
    try {
      deathPort.postMessage('dead');
    } catch {
      /* porta já encerrada */
    }
  });
}

const RETRYABLE = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ER_SERVER_SHUTDOWN',
  'ER_CONNECTION_KILLED',
  'ER_CLIENT_INTERACTION_TIMEOUT',
]);

function isConnectionError(error) {
  if (!error) return false;
  return error.fatal === true || RETRYABLE.has(error.code);
}

function localTimezoneOffset() {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function destroyConnection() {
  const old = connection;
  connection = null;
  if (!old) return;
  try {
    old.destroy();
  } catch {
    /* conexão já encerrada */
  }
}

function serializeError(error) {
  return {
    message: error && error.message ? error.message : String(error),
    code: error && error.code ? error.code : null,
    errno: error && error.errno ? error.errno : null,
    sqlState: error && error.sqlState ? error.sqlState : null,
  };
}

function publish(payload) {
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.length > output.length) {
    const fallback = encoder.encode(
      JSON.stringify({
        ok: false,
        error: { message: 'Resposta do MySQL maior que o buffer de 16 MB.', code: 'RESULT_TOO_LARGE' },
      }),
    );
    output.set(fallback);
    Atomics.store(control, 1, fallback.length);
  } else {
    output.set(bytes);
    Atomics.store(control, 1, bytes.length);
  }
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

async function connect() {
  if (connection) {
    try {
      connection.destroy();
    } catch {
      /* conexão já encerrada */
    }
  }

  const options = {
    host: workerData.host,
    port: workerData.port,
    user: workerData.user,
    password: workerData.password,
    database: workerData.database,
    charset: 'utf8mb4',
    dateStrings: true,
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    connectTimeout: workerData.connectTimeoutMs || 10000,
  };
  if (workerData.socketPath) options.socketPath = workerData.socketPath;

  connection = await mysql.createConnection(options);
  // Sem este listener, um erro assíncrono da conexão (queda, timeout do
  // servidor) viraria exceção não tratada. A conexão é só descartada; a
  // próxima consulta reconecta.
  const current = connection;
  current.on('error', () => {
    if (connection !== current) return;
    connection = null;
    if (inTransaction) transactionBroken = true;
  });
  // Mantém NOW()/CURRENT_TIMESTAMP alinhados aos timestamps locais gravados
  // pelo Node (timer, seed e rotas), evitando relatórios deslocados por fuso.
  await connection.query(`SET time_zone = '${localTimezoneOffset()}'`);
}

function transactionLostError() {
  const error = new Error('A conexão com o MySQL caiu no meio de uma transação; a operação foi desfeita.');
  error.code = 'TRANSACTION_LOST';
  return error;
}

async function execute(job) {
  const sql = String(job.sql || '');
  if (transactionBroken) {
    if (TX_ROLLBACK.test(sql)) {
      inTransaction = false;
      transactionBroken = false;
      return { ok: true, changes: 0 };
    }
    if (TX_END.test(sql)) {
      inTransaction = false;
      transactionBroken = false;
    }
    throw transactionLostError();
  }
  if (!connection) {
    if (inTransaction) {
      transactionBroken = true;
      throw transactionLostError();
    }
    await connect();
  }

  if (job.mode === 'exec') {
    await connection.query(job.sql);
    if (TX_BEGIN.test(sql)) inTransaction = true;
    else if (TX_END.test(sql)) inTransaction = false;
    return { ok: true, changes: 0 };
  }

  const [result] = await connection.query(job.sql, job.params || []);
  if (job.method === 'run') {
    return {
      ok: true,
      changes: result && Number.isFinite(result.affectedRows) ? result.affectedRows : 0,
      lastInsertRowid: result && Number.isFinite(result.insertId) ? result.insertId : 0,
    };
  }
  return { ok: true, rows: Array.isArray(result) ? result : [] };
}

async function boot() {
  try {
    await connect();
    publish({ ok: true, ready: true });
  } catch (error) {
    publish({ ok: false, error: serializeError(error) });
  }
  Atomics.store(control, 2, 1);
  Atomics.notify(control, 2);
}

parentPort.on('message', async (job) => {
  if (job && job.action === 'close') {
    try {
      if (connection) await connection.end();
    } catch {
      /* ignore */
    }
    publish({ ok: true, closed: true });
    return;
  }

  const id = job ? job.id : undefined;
  try {
    let result;
    try {
      result = await execute(job);
    } catch (error) {
      // Uma falha fatal invalida a conexão. Somente leituras são repetidas:
      // reenviar um INSERT/UPDATE após queda poderia duplicar dados.
      const fatal = isConnectionError(error);
      if (fatal) destroyConnection();
      if (fatal && inTransaction) {
        transactionBroken = true;
        throw transactionLostError();
      }
      const isRead = job.method === 'get' || job.method === 'all';
      if (!isRead || !fatal) throw error;
      await connect();
      result = await execute(job);
    }
    publish({ ...result, id });
  } catch (error) {
    publish({ ok: false, id, error: serializeError(error) });
  }
});

// Um erro inesperado não pode publicar uma resposta "solta": ela seria lida
// como resposta da consulta em andamento (ou da próxima). O worker encerra;
// a thread principal percebe pela deathPort, descarta a sessão e reconecta.
function die(error) {
  try {
    console.error('[mysql-worker] erro inesperado, encerrando a conexão:', error && error.message);
  } finally {
    process.exit(1);
  }
}
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

boot();
