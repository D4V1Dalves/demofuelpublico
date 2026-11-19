/* Ponte síncrona para MySQL/MariaDB.
   O app usa a API síncrona do node:sqlite em todo lugar; este módulo mantém
   uma conexão em worker_thread e bloqueia a thread principal com Atomics.wait.
   Se o worker morrer ou uma consulta estourar o tempo, a sessão é descartada
   e a próxima chamada abre uma conexão nova — sem deixar o app sem banco. */
const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { toMysql } = require('./sql-dialect');

const OUTPUT_BYTES = 16 * 1024 * 1024;
const CONTROL_BYTES = 12; // state | payload length | ready

const CONNECTION_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ER_SERVER_SHUTDOWN',
  'ER_CONNECTION_KILLED',
  'ER_CON_COUNT_ERROR',
  'ER_CLIENT_INTERACTION_TIMEOUT',
]);

// Atomics.wait bloqueia o event loop, então worker.on('exit') não roda enquanto
// esperamos. O worker sinaliza a própria morte por um MessagePort, que
// receiveMessageOnPort drena de forma síncrona — abortando a requisição na hora.
function waitFor(state, index, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!state.dead && state.deathPort && receiveMessageOnPort(state.deathPort)) {
      state.dead = new Error('A conexão MySQL encerrou inesperadamente.');
    }
    if (state.dead) return 'dead';
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timed-out';
    const result = Atomics.wait(state.control, index, 0, Math.min(remaining, 250));
    if (result === 'ok' || result === 'not-equal') return result;
  }
}

function readPayload(control, output, decoder) {
  const length = Atomics.load(control, 1);
  if (!length) return {};
  try {
    return JSON.parse(decoder.decode(output.subarray(0, length)));
  } catch {
    throw new Error('Resposta inválida do MySQL.');
  }
}

function createMysqlDb(config) {
  const timeoutMs = config.queryTimeoutMs || 15000;
  const connectTimeoutMs = config.connectTimeoutMs || 15000;
  let closed = false;
  let session = null;
  let sequence = 0;

  const discard = (reason) => {
    if (!session) return;
    const dying = session;
    session = null;
    dying.closing = true;
    try {
      dying.worker.terminate();
    } catch {
      /* worker já encerrado */
    }
    try {
      dying.deathPort.close();
    } catch {
      /* porta já fechada */
    }
    if (reason) console.warn(`[mysql] conexão descartada: ${reason}`);
  };

  const openSession = () => {
    const controlBuffer = new SharedArrayBuffer(CONTROL_BYTES);
    const control = new Int32Array(controlBuffer);
    const outputBuffer = new SharedArrayBuffer(OUTPUT_BYTES);
    const output = new Uint8Array(outputBuffer);
    const decoder = new TextDecoder();
    const { port1, port2 } = new MessageChannel();
    port2.unref();

    const worker = new Worker(path.join(__dirname, 'mysql-worker.js'), {
      workerData: { ...config, control: controlBuffer, output: outputBuffer, deathPort: port1 },
      transferList: [port1],
    });
    const state = {
      worker,
      control,
      output,
      decoder,
      deathPort: port2,
      dead: null,
      closing: false,
    };
    worker.on('error', (error) => {
      state.dead = error;
    });
    worker.on('exit', (code) => {
      if (!state.closing && code !== 0) {
        state.dead =
          state.dead || new Error(`Conexão MySQL encerrou inesperadamente (código ${code}).`);
      }
    });

    // Handshake: o worker conecta e publica o resultado antes de aceitar queries.
    const booted = waitFor(state, 2, connectTimeoutMs);
    if (booted === 'dead') {
      state.closing = true;
      worker.terminate();
      throw state.dead || new Error('A conexão MySQL encerrou durante a inicialização.');
    }
    if (booted === 'timed-out') {
      state.closing = true;
      worker.terminate();
      throw new Error(
        'Não foi possível conectar ao MySQL (timeout). Confira DB_HOST, DB_NAME, DB_USER e DB_PASSWORD.',
      );
    }
    const handshake = readPayload(control, output, decoder);
    if (!handshake.ok) {
      state.closing = true;
      worker.terminate();
      const detail =
        handshake.error && handshake.error.message ? handshake.error.message : 'erro desconhecido';
      throw new Error(`Não foi possível conectar ao MySQL: ${detail}`);
    }
    Atomics.store(control, 0, 0);
    Atomics.store(control, 1, 0);
    return state;
  };

  const getSession = () => {
    if (session && session.dead) {
      discard(session.dead.message);
    }
    if (!session) session = openSession();
    return session;
  };

  const exchange = (job) => {
    if (closed) throw new Error('Banco de dados já foi encerrado.');

    const active = getSession();
    if (active.dead) {
      const reason = active.dead.message;
      discard(reason);
      throw active.dead;
    }

    Atomics.store(active.control, 0, 0);
    Atomics.store(active.control, 1, 0);
    // Cada consulta leva um número; a resposta precisa trazer o mesmo número.
    const id = ++sequence;
    active.worker.postMessage({ ...job, id });

    const status = waitFor(active, 0, timeoutMs);
    if (status === 'dead') {
      const reason = active.dead ? active.dead.message : 'o worker MySQL encerrou';
      discard(reason);
      throw active.dead || new Error('A conexão MySQL encerrou inesperadamente.');
    }
    if (status === 'timed-out') {
      discard('consulta excedeu o tempo limite');
      throw new Error('A consulta ao MySQL excedeu o tempo limite.');
    }

    const payload = readPayload(active.control, active.output, active.decoder);
    if (payload.id !== id) {
      // Resposta de outra consulta: o protocolo saiu de sincronia. Nunca usar
      // esse resultado; descarta a sessão e a próxima chamada reconecta limpa.
      discard('resposta fora de ordem');
      throw new Error('Resposta do MySQL fora de ordem; a conexão foi reiniciada.');
    }
    if (!payload.ok) {
      const error = new Error(
        payload.error && payload.error.message
          ? payload.error.message
          : 'Erro ao executar a consulta.',
      );
      if (payload.error) {
        error.code = payload.error.code;
        error.errno = payload.error.errno;
        error.sqlState = payload.error.sqlState;
      }
      // Falhas de conexão invalidam a sessão; a próxima chamada reconecta.
      if (CONNECTION_CODES.has(error.code)) discard(`erro ${error.code}`);
      throw error;
    }
    return payload;
  };

  const prepare = (sql) => {
    const translated = toMysql(sql);
    return {
      run(...params) {
        const result = exchange({ method: 'run', sql: translated, params });
        return {
          changes: Number(result.changes || 0),
          lastInsertRowid: Number(result.lastInsertRowid || 0),
        };
      },
      get(...params) {
        const result = exchange({ method: 'get', sql: translated, params });
        return result.rows && result.rows.length ? result.rows[0] : undefined;
      },
      all(...params) {
        const result = exchange({ method: 'all', sql: translated, params });
        return result.rows || [];
      },
    };
  };

  return {
    driver: 'mysql',
    prepare,
    exec(sql) {
      exchange({ mode: 'exec', sql: toMysql(sql) });
    },
    close() {
      if (closed) return;
      closed = true;
      if (!session) return;
      const dying = session;
      session = null;
      dying.closing = true;
      try {
        dying.worker.postMessage({ action: 'close' });
      } catch {
        /* worker já encerrado */
      }
      dying.worker.terminate();
      try {
        dying.deathPort.close();
      } catch {
        /* porta já fechada */
      }
    },
  };
}

module.exports = { createMysqlDb };
