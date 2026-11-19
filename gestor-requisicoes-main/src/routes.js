const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { STATUS, PRIORITY, LIMITS, PREVIEW_MIME } = require('./config');
const { verifyPassword, hashPassword, randomToken } = require('./security');
const { createSession, destroySession, requireAuth, requireAdmin, SESSION_MS } = require('./auth');
const { createUploadMiddleware, createAvatarUploadMiddleware } = require('./upload');
const { AI_PROVIDERS, getAiSettings, setSetting, maskApiKey } = require('./settings');
const { approvalLang, approvalStrings } = require('./i18n');
const { validateStatusChange, hasApproval, CLEAR_APPROVALS_SQL } = require('./workflow');
const { localSuggestions, buildCorpus } = require('./suggestions');
const { aiConfig, requestAiSuggestions } = require('./ai');
const { computeNextRun, runRuleNow } = require('./scheduler');
const { parseStartTime } = require('./scheduler-core');
const { buildReport, presetRange, GRANULARIDADES } = require('./reports');
const { validateClientInput, getClient, getClientJobCount } = require('./clients');
const {
  getTimer,
  getTimersForRequest,
  elapsedSeconds,
  totalSeconds,
  formatDuration,
  startTimer,
  pauseTimer,
  finishTimer,
} = require('./timer');

function getStats(db, responsibleId = null) {
  const scoped = Number(responsibleId) > 0;
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN ('Aprovado','Rejeitado') THEN 1 ELSE 0 END) AS abertas,
        SUM(CASE WHEN status = 'Aprovado' THEN 1 ELSE 0 END) AS concluidas,
        SUM(CASE WHEN status NOT IN ('Aprovado','Rejeitado') AND due_date IS NOT NULL
                      AND due_date < date('now','localtime')
                 THEN 1 ELSE 0 END) AS atrasadas
       FROM requests${scoped ? ' WHERE responsible_id = ?' : ''}`,
    )
    .get(...(scoped ? [Number(responsibleId)] : []));

  return {
    total: Number(row.total || 0),
    abertas: Number(row.abertas || 0),
    concluidas: Number(row.concluidas || 0),
    atrasadas: Number(row.atrasadas || 0),
  };
}

function getRequests(db, { cliente, status, q, responsible_id }) {
  const where = [];
  const params = [];

  if (cliente && Number(cliente) > 0) {
    where.push('r.client_id = ?');
    params.push(Number(cliente));
  }
  if (responsible_id && Number(responsible_id) > 0) {
    where.push('r.responsible_id = ?');
    params.push(Number(responsible_id));
  }
  if (STATUS.includes(status)) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (q && String(q).trim()) {
    const like = `%${String(q).trim()}%`;
    where.push('(r.title LIKE ? OR r.description LIKE ?)');
    params.push(like, like);
  }

  return db
    .prepare(
      `SELECT r.*, c.name AS client_name, u.name AS responsible_name,
              u.avatar AS responsible_avatar,
              (SELECT COUNT(*) FROM comments cm WHERE cm.request_id = r.id) AS comment_count,
              (SELECT COUNT(*) FROM attachments ax WHERE ax.request_id = r.id) AS attachment_count
       FROM requests r
       JOIN clients c ON c.id = r.client_id
       LEFT JOIN users u ON u.id = r.responsible_id
       WHERE ${where.length ? where.join(' AND ') : '1 = 1'}
       ORDER BY CASE r.priority
                  WHEN 'Urgente' THEN 0 WHEN 'Alta' THEN 1
                  WHEN 'Média' THEN 2 ELSE 3 END,
                r.id DESC`,
    )
    .all(...params);
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Campos TEXT do MySQL aceitam até 65.535 bytes. O limite de caracteres da UI
// é mais baixo, mas o byte length protege entradas com muitos caracteres
// multibyte (emoji/acentos).
function textTooLong(value, maxChars) {
  return value.length > maxChars || Buffer.byteLength(value, 'utf8') > LIMITS.textBytes;
}

// `Number('')` é 0 e `Number('abc')` é NaN; ambos criam SQL inválido no MySQL.
// Retorna null para vazio e NaN (rejeitado depois) ou o inteiro convertido.
function optionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  return Number(value);
}

function urlTooLong(value) {
  return value.length > LIMITS.urlMaxChars || Buffer.byteLength(value, 'utf8') > LIMITS.urlMaxChars;
}

// Opções do cookie de sessão. SESSION_COOKIE_SECURE=1 ativa Secure em produção
// HTTPS; TRUST_PROXY=1 faz o Express reconhecer o HTTPS do proxy do cPanel.
function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.SESSION_COOKIE_SECURE === '1',
  };
}

function validateRequestInput(db, body) {
  const values = {
    client_id: Number(body.client_id),
    new_client_name: String(body.new_client_name || '').trim(),
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    status: String(body.status || ''),
    priority: String(body.priority || ''),
    responsible_id: optionalId(body.responsible_id),
    due_date: String(body.due_date || '').trim(),
    dropbox_url: String(body.dropbox_url || '').trim(),
  };

  if (!values.title) return { error: 'O título é obrigatório.' };
  if (values.title.length > LIMITS.requestTitle) {
    return { error: `O título deve ter no máximo ${LIMITS.requestTitle} caracteres.` };
  }
  if (textTooLong(values.description, LIMITS.descriptionChars)) {
    return { error: `A descrição deve ter no máximo ${LIMITS.descriptionChars} caracteres.` };
  }
  if (values.new_client_name) {
    if (values.new_client_name.length > LIMITS.clientInlineName) {
      return { error: `O nome do cliente deve ter no máximo ${LIMITS.clientInlineName} caracteres.` };
    }
  } else if (
    !Number.isInteger(values.client_id) ||
    !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(values.client_id)
  ) {
    return { error: 'Cliente inválido.' };
  }
  if (!STATUS.includes(values.status)) return { error: 'Status inválido.' };
  if (!PRIORITY.includes(values.priority)) return { error: 'Prioridade inválida.' };
  if (
    values.responsible_id !== null &&
    (!Number.isInteger(values.responsible_id) ||
      !db.prepare('SELECT 1 FROM users WHERE id = ?').get(values.responsible_id))
  ) {
    return { error: 'Responsável inválido.' };
  }
  if (values.due_date && !isRealDate(values.due_date)) return { error: 'Data inválida.' };
  const dropboxError = validateDropboxUrl(values.dropbox_url);
  if (dropboxError) return { error: dropboxError };

  return { values, error: null };
}

// Valida o link do Dropbox (opcional): tamanho máximo e protocolo http/https.
function validateDropboxUrl(url) {
  if (!url) return null;
  if (urlTooLong(url)) return `O link deve ter no máximo ${LIMITS.urlMaxChars} caracteres.`;
  try {
    if (['http:', 'https:'].includes(new URL(url).protocol)) return null;
  } catch {
    // cai na mensagem abaixo
  }
  return 'Link do Dropbox inválido. Use http:// ou https://.';
}

function resolveClientId(db, values) {
  if (!values.new_client_name) return values.client_id;
  const existing = db
    .prepare('SELECT id FROM clients WHERE lower(name) = lower(?)')
    .get(values.new_client_name);
  if (existing) return existing.id;
  return Number(
    db.prepare('INSERT INTO clients (name) VALUES (?)').run(values.new_client_name).lastInsertRowid,
  );
}

function canControlTimer(request, user) {
  if (!request || !user) return false;
  if (user.role === 'admin') return true;
  return !request.responsible_id || Number(request.responsible_id) === Number(user.id);
}

// Automação: começar o timer tira o job da fila e coloca a equipe em produção.
// Também vale para retrabalho de um job rejeitado: iniciar/retomar o timer
// devolve o job para "Em andamento", descarta a decisão anterior do cliente e
// abre um novo ciclo de trabalho (que exige um relato novo para concluir).
// Em revisão ("Em processo") o timer só registra tempo — por exemplo, o admin
// cronometrando a revisão; para pedir ajustes, o job volta para Em andamento.
const WORK_RESTART_STATUSES = ['Novo', 'Rejeitado'];
function advanceOnTimerStart(db, request) {
  if (!WORK_RESTART_STATUSES.includes(request.status)) return;
  if (request.status !== 'Novo') db.prepare(CLEAR_FOR_REWORK_SQL).run(request.id);
  db.prepare(
    `UPDATE requests SET status = 'Em andamento', cycle_started_at = datetime('now','localtime'),
       updated_at = datetime('now','localtime') WHERE id = ?`,
  ).run(request.id);
  request.status = 'Em andamento';
}

// Automação: concluir o timer devolve o job para a revisão do administrador.
function advanceOnTimerFinish(db, request) {
  if (!['Novo', 'Em andamento'].includes(request.status)) return;
  db.prepare(
    "UPDATE requests SET status = 'Em processo', updated_at = datetime('now','localtime') WHERE id = ?",
  ).run(request.id);
  request.status = 'Em processo';
}

function getRequestById(db, id) {
  return db
    .prepare(
      `SELECT r.*, c.name AS client_name, u.name AS responsible_name
       FROM requests r
       JOIN clients c ON c.id = r.client_id
       LEFT JOIN users u ON u.id = r.responsible_id
       WHERE r.id = ?`,
    )
    .get(id);
}

function renderRequestForm(res, { current, clients, users, error }) {
  res.status(error ? 400 : 200).render('request-form', {
    title: current && current.id ? 'Editar requisição' : 'Nova requisição',
    current,
    clients,
    users,
    error: error || null,
  });
}

const CONCLUDE_REQUIRED_MESSAGE =
  'É obrigatório preencher o campo "O que está sendo feito?" antes de concluir o job.';

// O job tem o relato "O que está sendo feito?" do ciclo de trabalho atual: um
// comentário feito desde que o job entrou em "Em andamento" pela última vez.
// Sem ciclo aberto (job que ainda não começou), nenhum comentário conta — um
// briefing deixado no job "Novo" não substitui o relato da equipe.
function hasProgressNote(db, request) {
  if (!request.cycle_started_at) return false;
  return Boolean(
    db
      .prepare('SELECT 1 FROM comments WHERE request_id = ? AND created_at >= ? LIMIT 1')
      .get(request.id, request.cycle_started_at),
  );
}

// Abre um ciclo de aprovação: registra a aprovação do Admin, descarta a decisão
// anterior do cliente e gera um novo link público. Único caminho para "Aprovação".
function openApprovalCycle(db, requestId) {
  db.prepare(
    `UPDATE requests SET status = 'Aprovação', completed_at = NULL,
       admin_approved_at = datetime('now','localtime'), client_approved_at = NULL,
       client_rejected_at = NULL, client_rejection_reason = NULL, approval_token = ?,
       updated_at = datetime('now','localtime')
     WHERE id = ?`,
  ).run(randomToken(), requestId);
}

// Marca o início de um novo ciclo de trabalho (entrada em "Em andamento").
function startWorkCycle(db, requestId) {
  db.prepare("UPDATE requests SET cycle_started_at = datetime('now','localtime') WHERE id = ?").run(requestId);
}

function endWorkCycle(db, requestId) {
  db.prepare('UPDATE requests SET cycle_started_at = NULL WHERE id = ?').run(requestId);
}

// Retrabalho: a aprovação anterior deixa de valer, mas o motivo da rejeição do
// cliente continua guardado para a equipe ler. Um novo ciclo de aprovação limpa.
const CLEAR_FOR_REWORK_SQL = `
  UPDATE requests SET admin_approved_at = NULL, client_approved_at = NULL,
    approval_token = NULL, completed_at = NULL
  WHERE id = ?
`;

// Regras de mudança de etapa compartilhadas pelo quadro, pela edição e pelo timer.
function transitionError(db, current, target) {
  // Sem mudança de etapa (ex.: corrigir o título de um job rejeitado): nada a validar.
  if (target === current.status) return null;
  const { error } = validateStatusChange(current, target);
  if (error) return error;
  if (target === 'Em processo' && current.status !== 'Em processo') {
    if (current.status === 'Rejeitado') {
      return 'Job rejeitado: volte para Em andamento, faça os ajustes e registre o que foi feito antes de enviar para revisão.';
    }
    if (!hasProgressNote(db, current)) return CONCLUDE_REQUIRED_MESSAGE;
  }
  return null;
}

function renderRequestDetail(res, db, id, error = null) {
  const current = getRequestById(db, id);
  if (!current) return res.status(404).send('Requisição não encontrada.');

  const { comments, attachments } = listCommentsAndAttachments(db, current.id);

  const timers = getTimersForRequest(db, current.id);
  const timer = timers.find((row) => row.user_id === res.locals.user.id) || null;
  const timeTotal = totalSeconds(timers);
  const canTime = canControlTimer(current, res.locals.user);

  const approvalUrl = current.approval_token
    ? `${res.req.protocol}://${res.req.get('host')}/aprovacao/${current.approval_token}`
    : null;
  return res.status(error ? 400 : 200).render('request', {
    title: current.title,
    request: current,
    comments,
    attachments,
    timer,
    timers,
    timeTotal,
    canTime,
    canEditComments: res.locals.user.role === 'admin' && current.status === 'Em processo',
    hasProgressNote: hasProgressNote(db, current),
    concludeRequiredMessage: CONCLUDE_REQUIRED_MESSAGE,
    approvalUrl,
    approvalUrlEn: approvalUrl ? `${approvalUrl}?lang=en` : null,
    formatDuration,
    elapsedSeconds,
    error,
  });
}

// Comentários e anexos de um job, com o nome do autor. `lastComments` limita
// aos N comentários mais recentes (mantendo a ordem cronológica).
function listCommentsAndAttachments(db, requestId, { lastComments } = {}) {
  const comments = lastComments
    ? db
        .prepare(
          `SELECT cm.*, u.name AS user_name FROM comments cm
           JOIN users u ON u.id = cm.user_id
           WHERE cm.request_id = ? ORDER BY cm.id DESC LIMIT ${Number(lastComments)}`,
        )
        .all(requestId)
        .reverse()
    : db
        .prepare(
          `SELECT cm.*, u.name AS user_name FROM comments cm
           JOIN users u ON u.id = cm.user_id WHERE cm.request_id = ? ORDER BY cm.id`,
        )
        .all(requestId);
  const attachments = db
    .prepare(
      `SELECT ax.*, u.name AS user_name FROM attachments ax
       JOIN users u ON u.id = ax.user_id WHERE ax.request_id = ? ORDER BY ax.id`,
    )
    .all(requestId);
  return { comments, attachments };
}

function resolveUploadPath(uploadDir, storedName) {
  const filePath = path.resolve(uploadDir, storedName);
  if (path.dirname(filePath) !== path.resolve(uploadDir) || !fs.existsSync(filePath)) return null;
  return filePath;
}

// Serve imagens/PDF/texto inline para o modal de visualização. O Content-Type
// vem de uma whitelist e o nosniff global impede que um arquivo renomeado seja
// interpretado como HTML/script pelo navegador.
function sendInlinePreview(res, filePath, mimeType, message = 'Este tipo de arquivo não pode ser visualizado aqui.') {
  if (!PREVIEW_MIME.has(mimeType)) {
    return res.status(415).send(message);
  }
  res.setHeader('Content-Type', mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : mimeType);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.sendFile(filePath);
}

function validateRuleInput(db, body) {
  const values = {
    name: String((body && body.name) || '').trim(),
    client_id: Number((body && body.client_id) || 0),
    title: String((body && body.title) || '').trim(),
    description: String((body && body.description) || '').trim(),
    priority: String((body && body.priority) || ''),
    responsible_id: optionalId(body && body.responsible_id),
    due_days: Number((body && body.due_days) || 0),
    dropbox_url: String((body && body.dropbox_url) || '').trim(),
    interval_value: Number((body && body.interval_value) || 0),
    interval_unit: String((body && body.interval_unit) || ''),
    start_time: String((body && body.start_time) || '').trim(),
  };

  if (!values.name) return { error: 'O nome da regra é obrigatório.' };
  if (!values.title) return { error: 'O título do modelo é obrigatório.' };
  if (values.name.length > LIMITS.ruleName) {
    return { error: `O nome da regra deve ter no máximo ${LIMITS.ruleName} caracteres.` };
  }
  if (values.title.length > LIMITS.ruleTitle) {
    return { error: `O título do modelo deve ter no máximo ${LIMITS.ruleTitle} caracteres.` };
  }
  if (textTooLong(values.description, LIMITS.descriptionChars)) {
    return { error: `A descrição deve ter no máximo ${LIMITS.descriptionChars} caracteres.` };
  }
  if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(values.client_id)) {
    return { error: 'Cliente inválido.' };
  }
  if (!PRIORITY.includes(values.priority)) return { error: 'Prioridade inválida.' };
  if (values.responsible_id !== null && (!Number.isInteger(values.responsible_id) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(values.responsible_id))) {
    return { error: 'Responsável inválido.' };
  }
  if (!Number.isInteger(values.interval_value) || values.interval_value < 1 || values.interval_value > 365) {
    return { error: 'Periodicidade inválida: use um número entre 1 e 365.' };
  }
  if (!['dia', 'semana', 'mes'].includes(values.interval_unit)) {
    return { error: 'Unidade de periodicidade inválida.' };
  }
  if (!parseStartTime(values.start_time)) return { error: 'Horário inválido. Use HH:MM.' };
  if (!Number.isInteger(values.due_days) || values.due_days < 0 || values.due_days > 365) {
    return { error: 'O prazo deve estar entre 0 e 365 dias.' };
  }
  const dropboxError = validateDropboxUrl(values.dropbox_url);
  if (dropboxError) return { error: dropboxError };

  return { values, error: null };
}

function renderRuleForm(res, { current, clients, users, error }) {
  res.status(error ? 400 : 200).render('agendamento-form', {
    title: current && current.id ? 'Editar agendamento' : 'Novo agendamento',
    current: current || {},
    clients,
    users,
    error: error || null,
  });
}

function registerRoutes(app, { db, uploadDir }) {
  // IDs são inteiros positivos. Sem isso, o MySQL converte "1abc" em 1 e serve
  // um registro que o SQLite (dev/testes) trataria como 404.
  app.param('id', (req, res, next, value) => {
    if (!/^\d+$/.test(String(value))) return res.status(404).send('Registro não encontrado.');
    return next();
  });

  /* ---------- Instalação: primeiro administrador ---------- */
  // Com o banco sem nenhum usuário, toda página leva para /instalacao, onde o
  // primeiro admin é criado com a senha escolhida. Depois disso a rota some.
  const hasUsers = () => Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get());
  let installed = false;
  const isInstalled = () => installed || (installed = hasUsers());
  app.use((req, res, next) => {
    if (isInstalled() || req.path === '/instalacao') return next();
    if (req.method === 'GET') return res.redirect('/instalacao');
    return res.status(503).send('Sistema ainda não instalado. Abra /instalacao.');
  });

  const avatarDir = path.join(uploadDir, 'avatars');
  const avatarUpload = createAvatarUploadMiddleware(uploadDir);
  const renderProfile = (res, { error = null, notice = false, status = 200 } = {}) =>
    res.status(status).render('profile', { title: 'Meu perfil', error, notice });
  const removeAvatarFile = (stored) => {
    if (!stored || path.basename(stored) !== stored) return;
    try {
      fs.rmSync(path.join(avatarDir, stored), { force: true });
    } catch {
      /* arquivo já removido */
    }
  };

  app.get('/login', (req, res) => {
    res.render('login', { title: 'Entrar', error: null });
  });

  // Freio simples de brute force: janela deslizante de 15 min por IP+e-mail.
  // Fica em memória (por processo) e zera ao autenticar com sucesso. O mapa é
  // podado e limitado: a chave é controlada pelo cliente (IP + e-mail digitado).
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_MAX_FAILURES = 10; // por IP + e-mail
  const LOGIN_MAX_IP_FAILURES = 50; // por IP, qualquer e-mail
  // Teto alto (dezenas de milhares de entradas ocupam poucos MB): encher o mapa
  // exigiria centenas de milhares de falhas dentro da janela de 15 minutos.
  const LOGIN_MAX_KEYS = 50000;
  const loginFailures = new Map();
  const ipFailures = new Map();
  const loginKey = (req, email) => `${req.ip || 'local'}|${email.toLowerCase()}`;
  const ipKey = (req) => req.ip || 'local';

  const recordIsBlocked = (map, key, max, now) => {
    const record = map.get(key);
    if (!record) return false;
    if (now - record.first > LOGIN_WINDOW_MS) {
      map.delete(key);
      return false;
    }
    return record.count >= max;
  };
  // Pares IP + e-mail que já entraram com sucesso recentemente não são barrados
  // pelo limite do IP (colegas atrás do mesmo NAT continuam entrando), mas o
  // contador do IP não é zerado: quem tem uma conta não "limpa" o IP para
  // testar senhas de outras pessoas. O limite por conta continua valendo.
  const TRUSTED_MS = 24 * 60 * 60 * 1000;
  const trustedLogins = new Map();
  const isTrusted = (key, now) => {
    const at = trustedLogins.get(key);
    if (at === undefined) return false;
    if (now - at > TRUSTED_MS) {
      trustedLogins.delete(key);
      return false;
    }
    return true;
  };
  const rememberTrusted = (key, now = Date.now()) => {
    trustedLogins.delete(key);
    if (trustedLogins.size >= LOGIN_MAX_KEYS) trustedLogins.delete(trustedLogins.keys().next().value);
    trustedLogins.set(key, now);
  };
  const isLoginBlocked = (req, key, now = Date.now()) =>
    (recordIsBlocked(ipFailures, ipKey(req), LOGIN_MAX_IP_FAILURES, now) && !isTrusted(key, now)) ||
    recordIsBlocked(loginFailures, key, LOGIN_MAX_FAILURES, now);

  // Mapas limitados: a chave é controlada pelo cliente. Com o mapa cheio, sai
  // primeiro o que já expirou e depois a entrada mais antiga ainda NÃO
  // bloqueada. Um bloqueio nunca é expulso antes de expirar; se todas as
  // entradas estiverem bloqueadas, a chave nova simplesmente não é registrada.
  const bump = (map, key, max, now) => {
    const record = map.get(key);
    if (record && now - record.first <= LOGIN_WINDOW_MS) {
      record.count += 1;
      return;
    }
    if (!record && map.size >= LOGIN_MAX_KEYS) {
      for (const [staleKey, entry] of map) {
        if (now - entry.first > LOGIN_WINDOW_MS) map.delete(staleKey);
      }
      if (map.size >= LOGIN_MAX_KEYS) {
        let victim = null;
        for (const [candidate, entry] of map) {
          if (entry.count < max) {
            victim = candidate;
            break;
          }
        }
        if (victim === null) return;
        map.delete(victim);
      }
    }
    map.set(key, { count: 1, first: now });
  };
  const registerLoginFailure = (req, key, now = Date.now()) => {
    bump(ipFailures, ipKey(req), LOGIN_MAX_IP_FAILURES, now);
    bump(loginFailures, key, LOGIN_MAX_FAILURES, now);
  };

  // Em produção, instalar exige o código definido em INSTALL_TOKEN (variável do
  // cPanel). Sem isso, quem abrisse o site antes de você viraria administrador.
  const installTokenRequired = () => process.env.NODE_ENV === 'production';
  const installTokenMissing = () => installTokenRequired() && !process.env.INSTALL_TOKEN;
  const installTokenMatches = (value) => {
    if (!installTokenRequired()) return true;
    const expected = String(process.env.INSTALL_TOKEN || '');
    if (!expected) return false;
    const a = crypto.createHash('sha256').update(String(value || '')).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const renderSetup = (res, { error = null, values = {}, status = 200 } = {}) =>
    res.status(status).render('setup', {
      title: 'Instalação',
      error,
      values,
      tokenRequired: installTokenRequired(),
      tokenMissing: installTokenMissing(),
    });

  app.get('/instalacao', (req, res) => {
    if (isInstalled()) return res.redirect('/login');
    return renderSetup(res);
  });

  app.post('/instalacao', (req, res) => {
    if (isInstalled()) return res.redirect('/login');
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const values = { name, email };
    const fail = (error) => renderSetup(res, { error, values, status: 400 });
    if (installTokenMissing()) {
      return renderSetup(res, { error: 'Defina a variável INSTALL_TOKEN no cPanel antes de instalar.', values, status: 503 });
    }
    if (!installTokenMatches(body.install_token)) return fail('Código de instalação incorreto.');
    if (!name) return fail('Informe o seu nome.');
    if (name.length > LIMITS.userName) return fail(`O nome deve ter no máximo ${LIMITS.userName} caracteres.`);
    if (email.length > LIMITS.userEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('E-mail inválido.');
    if (password.length < 10) return fail('A senha do administrador deve ter pelo menos 10 caracteres.');
    if (password !== String(body.confirm_password || '')) return fail('A confirmação não confere com a senha.');

    // Uma instrução só: se dois acessos enviarem ao mesmo tempo, só um cria o admin.
    const result = db
      .prepare(
        `INSERT INTO users (name, email, password_hash, role)
         SELECT ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .run(name, email, hashPassword(password));
    if (result.changes !== 1) return res.redirect('/login');
    installed = true;
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    const token = createSession(db, user.id);
    res.cookie('sid', token, { ...sessionCookieOptions(), maxAge: SESSION_MS });
    return res.redirect('/dashboard');
  });

  app.post('/login', (req, res) => {
    const email = String((req.body && req.body.email) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const key = loginKey(req, email);

    if (isLoginBlocked(req, key)) {
      return res.status(429).render('login', {
        title: 'Entrar',
        error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.',
      });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);

    if (!user || !verifyPassword(password, user.password_hash) || Number(user.active) !== 1) {
      registerLoginFailure(req, key);
      return res.status(401).render('login', {
        title: 'Entrar',
        error: 'E-mail ou senha inválidos.',
      });
    }

    // Login certo zera as falhas daquela conta e marca o par IP + e-mail como
    // conhecido (não fica preso ao limite do IP, ex.: escritório atrás de NAT).
    loginFailures.delete(key);
    rememberTrusted(key);
    const token = createSession(db, user.id);
    res.cookie('sid', token, { ...sessionCookieOptions(), maxAge: SESSION_MS });
    return res.redirect('/dashboard');
  });

  app.post('/logout', requireAuth, (req, res) => {
    destroySession(db, req.sessionToken);
    res.clearCookie('sid', sessionCookieOptions());
    res.redirect('/login');
  });

  app.get('/', (req, res) => {
    res.redirect(req.user ? '/dashboard' : '/login');
  });

  app.get('/perfil', requireAuth, (req, res) => {
    return renderProfile(res, { notice: req.query.ok === '1' });
  });

  app.post('/perfil', requireAuth, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return renderProfile(res, { error: 'O nome é obrigatório.', status: 400 });
    if (name.length > LIMITS.userName) {
      return renderProfile(res, {
        error: `O nome pode ter no máximo ${LIMITS.userName} caracteres.`,
        status: 400,
      });
    }

    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    return res.redirect('/perfil?ok=1');
  });

  app.post('/perfil/foto', requireAuth, avatarUpload, (req, res) => {
    if (req.uploadError) return renderProfile(res, { error: req.uploadError, status: 400 });
    if (!req.file) return renderProfile(res, { error: 'Selecione uma foto para enviar.', status: 400 });

    const previous = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(req.file.filename, req.user.id);
    removeAvatarFile(previous && previous.avatar);
    return res.redirect('/perfil?ok=1');
  });

  app.post('/perfil/foto/remover', requireAuth, (req, res) => {
    const previous = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(req.user.id);
    removeAvatarFile(previous && previous.avatar);
    return res.redirect('/perfil?ok=1');
  });

  app.get('/perfil/senha', requireAuth, (req, res) => {
    res.render('password', { title: 'Minha senha', error: null });
  });

  app.post('/perfil/senha', requireAuth, (req, res) => {
    const current = String((req.body && req.body.current_password) || '');
    const next = String((req.body && req.body.new_password) || '')
    const confirm = String((req.body && req.body.confirm_password) || '');
    const fail = (error) => res.status(400).render('password', { title: 'Minha senha', error });

    if (!verifyPassword(current, req.user.password_hash)) return fail('A senha atual está incorreta.');
    if (next.length < 8) return fail('A nova senha deve ter pelo menos 8 caracteres.');
    if (next !== confirm) return fail('As senhas não conferem.');

    // Trocar a senha revoga todas as sessões anteriores do usuário.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    const token = createSession(db, req.user.id);
    res.cookie('sid', token, { ...sessionCookieOptions(), maxAge: SESSION_MS });
    return res.redirect('/dashboard');
  });

  /* ---------- Configurações ---------- */
  app.get('/configuracoes', requireAuth, (req, res) => {
    res.render('settings', { title: 'Configurações' });
  });

  const renderAiSettings = (res, { error = null, notice = false, status = 200, form = null } = {}) => {
    const stored = getAiSettings(db);
    const active = aiConfig(process.env, stored);
    const envAi = aiConfig(process.env, null);
    res.status(status).render('settings-ai', {
      title: 'Configurações',
      providers: AI_PROVIDERS,
      form: form || {
        provider: stored.enabled === null ? (envAi ? 'ambiente' : '') : stored.enabled ? stored.provider : '',
        model: stored.model,
      },
      envAi: envAi ? { provider: AI_PROVIDERS[envAi.provider].label, model: envAi.model } : null,
      maskedKey: maskApiKey(stored.apiKey),
      hasStoredKey: Boolean(stored.apiKey),
      disabledByAdmin: stored.enabled === false,
      active: active
        ? { provider: AI_PROVIDERS[active.provider].label, model: active.model, source: active.source }
        : null,
      error,
      notice,
    });
  };

  app.get('/configuracoes/ia', requireAdmin, (req, res) => renderAiSettings(res, { notice: req.query.ok === '1' }));

  app.post('/configuracoes/ia', requireAdmin, (req, res) => {
    const body = req.body || {};
    const provider = String(body.provider || '').trim().toLowerCase();
    const model = String(body.model || '').trim();
    const apiKey = String(body.api_key || '').trim();
    const removeKey = body.remove_key === '1';
    const form = { provider, model };
    const fail = (error) => renderAiSettings(res, { error, status: 400, form });

    // "Usar as variáveis de ambiente do servidor": apaga a escolha salva aqui.
    if (provider === 'ambiente') {
      setSetting(db, 'ai_enabled', null);
      return res.redirect('/configuracoes/ia?ok=1');
    }
    if (provider && !Object.hasOwn(AI_PROVIDERS, provider)) return fail('Escolha um provedor de IA válido.');
    if (model.length > 100 || (model && !/^[\w.:/-]+$/.test(model))) {
      return fail('O modelo deve ter até 100 caracteres, sem espaços (ex.: claude-opus-5-5).');
    }
    if (apiKey.length > 500 || /\s/.test(apiKey)) return fail('A chave da API não pode ter espaços nem passar de 500 caracteres.');
    const stored = getAiSettings(db);
    if (provider && !apiKey && (removeKey || !stored.apiKey)) {
      return fail('Informe a chave da API para ativar as sugestões com IA.');
    }
    // Trocar de provedor exige a chave do novo provedor.
    if (provider && stored.provider && provider !== stored.provider && !apiKey) {
      return fail('Ao trocar de provedor, informe a chave da API do novo provedor.');
    }

    // O modelo salvo pertence ao provedor anterior: ao trocar de provedor sem
    // digitar outro modelo, volta para o padrão do novo provedor.
    const switching = provider && stored.provider && provider !== stored.provider;
    const finalModel = switching && model === stored.model ? '' : model;

    // "Desativada" só desliga: provedor e chave ficam guardados para reativar.
    setSetting(db, 'ai_enabled', provider ? '1' : '0');
    if (provider) setSetting(db, 'ai_provider', provider);
    setSetting(db, 'ai_model', finalModel || null);
    if (apiKey) setSetting(db, 'ai_api_key', apiKey);
    else if (removeKey) setSetting(db, 'ai_api_key', null);
    return res.redirect('/configuracoes/ia?ok=1');
  });

  const USER_NOTICES = {
    desativado: 'Usuário desativado. As sessões dele foram encerradas.',
    ativado: 'Usuário reativado.',
    senha: 'Senha redefinida. As sessões abertas desse usuário foram encerradas.',
  };
  app.get('/usuarios', requireAdmin, (req, res) =>
    renderUsers(res, { notice: USER_NOTICES[req.query.ok] || null }));

  const usersList = () =>
    db.prepare('SELECT id, name, email, role, avatar, active, created_at FROM users ORDER BY active DESC, name').all();
  const renderUsers = (res, { error = null, notice = null, status = 200 } = {}) =>
    res.status(status).render('users', { title: 'Usuários', users: usersList(), error, notice });

  const targetUser = (req) => db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const activeAdmins = () =>
    Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n);

  app.post('/usuarios/:id/desativar', requireAdmin, (req, res) => {
    const target = targetUser(req);
    if (!target) return res.status(404).send('Usuário não encontrado.');
    if (target.id === req.user.id) return renderUsers(res, { error: 'Você não pode desativar a própria conta.', status: 400 });
    if (target.role === 'admin' && Number(target.active) === 1 && activeAdmins() <= 1) {
      return renderUsers(res, { error: 'É preciso manter pelo menos um administrador ativo.', status: 400 });
    }
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    return res.redirect('/usuarios?ok=desativado');
  });

  app.post('/usuarios/:id/ativar', requireAdmin, (req, res) => {
    const target = targetUser(req);
    if (!target) return res.status(404).send('Usuário não encontrado.');
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(target.id);
    return res.redirect('/usuarios?ok=ativado');
  });

  app.post('/usuarios/:id/senha', requireAdmin, (req, res) => {
    const target = targetUser(req);
    if (!target) return res.status(404).send('Usuário não encontrado.');
    const password = String((req.body && req.body.password) || '');
    if (password.length < 8) return renderUsers(res, { error: 'A nova senha deve ter pelo menos 8 caracteres.', status: 400 });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), target.id);
    // Encerra as sessões abertas: quem estava logado com a senha antiga sai.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    return res.redirect('/usuarios?ok=senha');
  });

  app.post('/usuarios', requireAdmin, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const role = String((req.body && req.body.role) || 'user');
    const renderError = (message) => renderUsers(res, { error: message, status: 400 });

    if (!name) return renderError('O nome é obrigatório.');
    if (name.length > LIMITS.userName) {
      return renderError(`O nome deve ter no máximo ${LIMITS.userName} caracteres.`);
    }
    if (email.length > LIMITS.userEmail) {
      return renderError(`O e-mail deve ter no máximo ${LIMITS.userEmail} caracteres.`);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return renderError('E-mail inválido.');
    if (password.length < 8) return renderError('A senha deve ter pelo menos 8 caracteres.');
    if (!['admin', 'user'].includes(role)) return renderError('Perfil inválido.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return renderError('Já existe um usuário com este e-mail.');
    }

    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
      name,
      email,
      hashPassword(password),
      role,
    );
    return res.redirect('/usuarios');
  });

  app.post('/requisicoes/:id/status', requireAdmin, (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).json({ error: 'Job não encontrado.' });

    const target = String((req.body && req.body.status) || '');
    // Card solto na própria coluna: nada muda (não apaga rejeição nem datas).
    if (target === current.status) return res.json({ ok: true, status: target });
    const error = transitionError(db, current, target);
    if (error) return res.status(400).json({ error });

    // Entrar em Aprovação (só a partir de Em processo) equivale à aprovação do Admin.
    if (target === 'Aprovação' && current.status !== 'Aprovação') {
      openApprovalCycle(db, current.id);
      return res.json({ ok: true, status: target });
    }
    if (target === 'Em andamento') startWorkCycle(db, current.id);
    // Voltar para Novo encerra o ciclo: comentários antigos não valem como relato.
    if (target === 'Novo') endWorkCycle(db, current.id);

    // Sair da etapa de aprovação invalida o link público e reinicia o ciclo de decisões.
    const clearApproval = ['Aprovação', 'Aprovado'].includes(target) ? 0 : 1;
    // Retrabalho de um job rejeitado mantém o pedido do cliente visível para a equipe.
    const clearRejection = clearApproval && current.status !== 'Rejeitado' ? 1 : 0;
    db.prepare(
      `UPDATE requests SET status = ?,
         completed_at = CASE WHEN ? = 'Aprovado' THEN datetime('now','localtime') ELSE NULL END,
         admin_approved_at = CASE WHEN ? THEN NULL ELSE admin_approved_at END,
         client_approved_at = CASE WHEN ? THEN NULL ELSE client_approved_at END,
         client_rejected_at = CASE WHEN ? THEN NULL ELSE client_rejected_at END,
         client_rejection_reason = CASE WHEN ? THEN NULL ELSE client_rejection_reason END,
         approval_token = CASE WHEN ? THEN NULL ELSE approval_token END,
         updated_at = datetime('now','localtime')
       WHERE id = ?`,
    ).run(target, target, clearApproval, clearApproval, clearRejection, clearRejection, clearApproval, current.id);
    return res.json({ ok: true, status: target });
  });

  const runTimerAction = (req, res, action) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).send('Job não encontrado.');
    if (!canControlTimer(current, req.user)) {
      return res.status(403).send('Você não tem permissão para controlar o tempo deste job.');
    }

    if (action === 'iniciar' || action === 'retomar') {
      startTimer(db, current.id, req.user.id);
      advanceOnTimerStart(db, current);
    } else if (action === 'pausar') {
      pauseTimer(db, current.id, req.user.id);
    } else if (action === 'concluir') {
      const activeTimer = getTimer(db, current.id, req.user.id);
      if (!activeTimer || activeTimer.status === 'finished') {
        return renderRequestDetail(res, db, current.id, 'Inicie o timer antes de concluir o job.');
      }
      // O relato da equipe ("O que está sendo feito?") do ciclo atual é obrigatório:
      // é o que o cliente lê na aprovação. Registrado neste ciclo, não cobra de novo.
      if (!hasProgressNote(db, current)) {
        return renderRequestDetail(res, db, current.id, CONCLUDE_REQUIRED_MESSAGE);
      }
      finishTimer(db, current.id, req.user.id);
      advanceOnTimerFinish(db, current);
    }

    return res.redirect(`/requisicoes/${current.id}`);
  };

  app.post('/requisicoes/:id/timer/iniciar', requireAuth, (req, res) => runTimerAction(req, res, 'iniciar'));
  app.post('/requisicoes/:id/timer/retomar', requireAuth, (req, res) => runTimerAction(req, res, 'retomar'));
  app.post('/requisicoes/:id/timer/pausar', requireAuth, (req, res) => runTimerAction(req, res, 'pausar'));
  app.post('/requisicoes/:id/timer/concluir', requireAuth, (req, res) => runTimerAction(req, res, 'concluir'));

  // Consultado pelo botão de concluir antes de enviar: o relato pode ter sido
  // registrado em outra aba ou por outra pessoa depois que a página carregou.
  app.get('/requisicoes/:id/relato', requireAuth, (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).json({ error: 'Job não encontrado.' });
    if (!canControlTimer(current, req.user)) {
      return res.status(403).json({ error: 'Você não tem permissão para concluir este job.' });
    }
    return res.json({ hasProgressNote: hasProgressNote(db, current) });
  });

  const asyncHandler = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

  app.post('/requisicoes/:id/sugestoes', requireAuth, asyncHandler(async (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).json({ error: 'Job não encontrado.' });

    const corpus = buildCorpus(db, { includeId: current.id });
    const currentJob = corpus.find((job) => job.id === current.id) || {
      id: current.id,
      title: current.title,
      description: current.description,
      comments: [],
    };
    const local = localSuggestions(currentJob, corpus, 3);
    const config = aiConfig(process.env, getAiSettings(db));
    if (!config) return res.json({ source: 'local', suggestions: local });

    try {
      const suggestions = await requestAiSuggestions({ current: currentJob, similar: local, config });
      return res.json({ source: 'ai', suggestions });
    } catch {
      return res.json({
        source: 'local',
        suggestions: local,
        fallback: 'IA indisponível; exibindo sugestões baseadas em jobs similares.',
      });
    }
  }));

  app.post('/requisicoes/:id/aprovar', requireAdmin, (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).send('Job não encontrado.');
    if (current.status !== 'Em processo') {
      return renderRequestDetail(
        res,
        db,
        current.id,
        'Só é possível aprovar um job que está em Em processo (trabalho concluído pela equipe).',
      );
    }

    openApprovalCycle(db, current.id);
    return res.redirect(`/requisicoes/${current.id}`);
  });

  const approvalByToken = (token) =>
    db
      .prepare(
        `SELECT r.*, c.name AS client_name, u.name AS responsible_name FROM requests r
         JOIN clients c ON c.id = r.client_id
         LEFT JOIN users u ON u.id = r.responsible_id
         WHERE r.approval_token = ?`,
      )
      .get(token);

  const approvalReport = (job) => listCommentsAndAttachments(db, job.id);

  const decisionOf = (job) =>
    job.client_rejection_reason ? 'rejected' : job.client_approved_at ? 'approved' : null;

  // Idioma do link público: ?lang=en mostra a interface em inglês; o conteúdo
  // escrito pela equipe e pelo cliente aparece como foi escrito.
  const approvalT = (req) => approvalStrings(approvalLang(String((req.query && req.query.lang) || '')));
  const renderApproval = (req, res, { job, error = null, result = null }, status = 200) => {
    const t = approvalT(req);
    return res.status(status).render('approval', {
      title: t.pageTitle,
      t,
      langQuery: t.lang === 'en' ? '?lang=en' : '',
      job,
      error,
      result: result || decisionOf(job),
      ...approvalReport(job),
    });
  };

  app.get('/aprovacao/:token', (req, res) => {
    const job = approvalByToken(req.params.token);
    if (!job) return res.status(404).send(approvalT(req).errInvalidLink);
    return renderApproval(req, res, { job });
  });

  app.get('/aprovacao/:token/anexo/:id', (req, res) => {
    const t = approvalT(req);
    const job = approvalByToken(req.params.token);
    if (!job) return res.status(404).send(t.errInvalidLink);

    const attachment = db
      .prepare('SELECT * FROM attachments WHERE id = ? AND request_id = ?')
      .get(req.params.id, job.id);
    if (!attachment) return res.status(404).send(t.errNotFound);

    const filePath = resolveUploadPath(uploadDir, attachment.stored_name);
    if (!filePath) return res.status(404).send(t.errNotFound);
    return res.download(filePath, attachment.original_name);
  });

  app.get('/aprovacao/:token/anexo/:id/preview', (req, res) => {
    const t = approvalT(req);
    const job = approvalByToken(req.params.token);
    if (!job) return res.status(404).send(t.errInvalidLink);

    const attachment = db
      .prepare('SELECT * FROM attachments WHERE id = ? AND request_id = ?')
      .get(req.params.id, job.id);
    if (!attachment) return res.status(404).send(t.errNotFound);

    const filePath = resolveUploadPath(uploadDir, attachment.stored_name);
    if (!filePath) return res.status(404).send(t.errNotFound);
    return sendInlinePreview(res, filePath, attachment.mime_type, t.lang === 'en' ? 'This file type cannot be previewed here.' : undefined);
  });

  app.post('/aprovacao/:token/aprovar', (req, res) => {
    const t = approvalT(req);
    const job = approvalByToken(req.params.token);
    if (!job) return res.status(404).send(t.errInvalidLink);
    if (decisionOf(job)) return renderApproval(req, res, { job });
    if (job.status !== 'Aprovação') {
      return renderApproval(req, res, { job, error: t.errNotPending }, 409);
    }

    // A condição no próprio UPDATE impede que aprovar e rejeitar (ex.: links PT
    // e EN abertos em duas abas) se sobreponham: só a primeira decisão grava.
    const approved = db.prepare(
      `UPDATE requests SET client_approved_at = datetime('now','localtime'),
         status = 'Aprovado', completed_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime')
       WHERE id = ? AND status = 'Aprovação' AND client_approved_at IS NULL AND client_rejection_reason IS NULL`,
    ).run(job.id);
    const fresh = approvalByToken(req.params.token);
    if (approved.changes !== 1) return renderApproval(req, res, { job: fresh }, 409);
    return renderApproval(req, res, { job: fresh, result: 'approved' });
  });

  app.post('/aprovacao/:token/rejeitar', (req, res) => {
    const t = approvalT(req);
    const job = approvalByToken(req.params.token);
    if (!job) return res.status(404).send(t.errInvalidLink);

    // O motivo é validado antes do guard para preservar o 400 do formulário.
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) {
      return renderApproval(req, res, { job, error: t.errReasonRequired }, 400);
    }
    if (textTooLong(reason, LIMITS.rejectionReasonChars)) {
      return renderApproval(req, res, { job, error: t.errReasonTooLong(LIMITS.rejectionReasonChars) }, 400);
    }
    if (decisionOf(job)) return renderApproval(req, res, { job });
    if (job.status !== 'Aprovação') {
      return renderApproval(req, res, { job, error: t.errNotPending }, 409);
    }

    const rejected = db.prepare(
      `UPDATE requests SET status = 'Rejeitado', client_rejected_at = datetime('now','localtime'),
        client_rejection_reason = ?, client_approved_at = NULL, completed_at = NULL,
        updated_at = datetime('now','localtime')
       WHERE id = ? AND status = 'Aprovação' AND client_approved_at IS NULL AND client_rejection_reason IS NULL`,
    ).run(reason, job.id);
    const fresh = approvalByToken(req.params.token);
    if (rejected.changes !== 1) return renderApproval(req, res, { job: fresh }, 409);
    return renderApproval(req, res, { job: fresh, result: 'rejected' });
  });

  app.get('/dashboard/stats', requireAuth, (req, res) => {
    const mine = req.query.mine === '1';
    res.json(getStats(db, mine ? req.user.id : null));
  });

  app.get('/dashboard', requireAuth, (req, res) => {
    const mine = req.query.mine === '1';
    const filters = {
      cliente: String((req.query.cliente || '')),
      status: STATUS.includes(req.query.status) ? req.query.status : '',
      q: String(req.query.q || ''),
      mine,
      responsible_id: mine ? req.user.id : null,
    };
    const requests = getRequests(db, filters);
    const groups = Object.fromEntries(STATUS.map((status) => [status, []]));
    for (const requestRow of requests) (groups[requestRow.status] ??= []).push(requestRow);

    res.render('dashboard', {
      title: mine ? 'Meu trabalho' : 'Dashboard',
      stats: getStats(db, mine ? req.user.id : null),
      groups,
      clients: db.prepare('SELECT id, name FROM clients ORDER BY name').all(),
      filters,
    });
  });

  const uploadFile = createUploadMiddleware(uploadDir);

  const requestExists = (req, res, next) => {
    if (!getRequestById(db, req.params.id)) return res.status(404).send('Requisição não encontrada.');
    return next();
  };

  app.post('/requisicoes/:id/anexos', requireAuth, requestExists, uploadFile, (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (req.uploadError) return renderRequestDetail(res, db, current.id, req.uploadError);
    if (!req.file) return renderRequestDetail(res, db, current.id, 'Nenhum arquivo enviado.');

    // O multer já gravou o arquivo; se o registro falhar (ex.: nome maior que
    // a coluna MySQL), apagamos o arquivo para não deixar órfão em UPLOAD_DIR.
    const discard = () => {
      try {
        fs.rmSync(req.file.path, { force: true });
      } catch {
        /* arquivo já removido */
      }
    };

    if (req.file.originalname.length > LIMITS.attachmentName) {
      discard();
      return renderRequestDetail(
        res,
        db,
        current.id,
        `O nome do arquivo deve ter no máximo ${LIMITS.attachmentName} caracteres.`,
      );
    }

    try {
      db.prepare(
        `INSERT INTO attachments (request_id, user_id, original_name, stored_name, mime_type, size)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        current.id,
        req.user.id,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
      );
    } catch (error) {
      discard();
      return renderRequestDetail(res, db, current.id, 'Não foi possível salvar o anexo.');
    }
    return res.redirect(`/requisicoes/${current.id}`);
  });

  app.get('/anexos/:id', requireAuth, (req, res) => {
    const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
    if (!attachment) return res.status(404).send('Anexo não encontrado.');

    const filePath = resolveUploadPath(uploadDir, attachment.stored_name);
    if (!filePath) return res.status(404).send('Anexo não encontrado.');
    return res.download(filePath, attachment.original_name);
  });

  app.get('/anexos/:id/preview', requireAuth, (req, res) => {
    const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
    if (!attachment) return res.status(404).send('Anexo não encontrado.');

    const filePath = resolveUploadPath(uploadDir, attachment.stored_name);
    if (!filePath) return res.status(404).send('Anexo não encontrado.');
    return sendInlinePreview(res, filePath, attachment.mime_type);
  });

  const formOptions = () => ({
    clients: db.prepare('SELECT id, name FROM clients ORDER BY name').all(),
    users: db.prepare('SELECT id, name FROM users ORDER BY name').all(),
  });

  app.get('/requisicoes/nova', requireAdmin, (req, res) => {
    const status = STATUS.includes(req.query.status) ? req.query.status : '';
    renderRequestForm(res, {
      ...formOptions(),
      current: status ? { status } : null,
      error: null,
    });
  });

  app.post('/requisicoes', requireAdmin, (req, res) => {
    const { values, error } = validateRequestInput(db, req.body || {});
    if (error) {
      return renderRequestForm(res, { ...formOptions(), current: values, error });
    }

    if (!['Novo', 'Em andamento'].includes(values.status)) {
      return renderRequestForm(res, {
        ...formOptions(),
        current: values,
        error: 'Um job novo começa em Novo ou Em andamento. As outras etapas dependem do trabalho da equipe.',
      });
    }

    const clientId = resolveClientId(db, values);
    const inserted = db.prepare(
      `INSERT INTO requests (client_id, title, description, status, priority, responsible_id, due_date, created_by, dropbox_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
    ).run(
      clientId,
      values.title,
      values.description,
      values.status,
      values.priority,
      values.responsible_id,
      values.due_date || null,
      req.user.id,
      values.dropbox_url || null,
    );
    if (values.status === 'Em andamento') startWorkCycle(db, Number(inserted.lastInsertRowid));
    return res.redirect('/dashboard');
  });

  app.get('/requisicoes/:id', requireAuth, (req, res) => {
    return renderRequestDetail(res, db, req.params.id);
  });

  app.get('/requisicoes/:id/drawer', requireAuth, (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).send('Requisição não encontrada.');

    const { comments, attachments } = listCommentsAndAttachments(db, current.id, { lastComments: 5 });

    const timers = getTimersForRequest(db, current.id);
    const timer = timers.find((row) => row.user_id === req.user.id) || null;

    return res.render('partials/item-drawer', {
      request: current,
      comments,
      attachments,
      timer,
      timers,
      timeTotal: totalSeconds(timers),
      canTime: canControlTimer(current, req.user),
      formatDuration,
      elapsedSeconds,
    });
  });

  app.post('/requisicoes/:id/comentarios', requireAuth, (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).send('Requisição não encontrada.');

    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return renderRequestDetail(res, db, current.id, 'O comentário não pode ser vazio.');
    if (textTooLong(body, LIMITS.commentChars)) {
      return renderRequestDetail(
        res,
        db,
        current.id,
        `O comentário deve ter no máximo ${LIMITS.commentChars} caracteres.`,
      );
    }

    db.prepare('INSERT INTO comments (request_id, user_id, body) VALUES (?, ?, ?)').run(
      current.id,
      req.user.id,
      body,
    );
    return res.redirect(`/requisicoes/${current.id}`);
  });

  // Comentários ficam congelados assim que o job sai de "Em processo". Se o
  // admin recuar o status, a edição volta a ser permitida.
  app.post('/requisicoes/:id/comentarios/:commentId/editar', requireAdmin, (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).send('Requisição não encontrada.');
    if (current.status !== 'Em processo') {
      return renderRequestDetail(
        res,
        db,
        current.id,
        'Só é possível editar comentários enquanto o job está em Em processo.',
      );
    }
    if (!/^\d+$/.test(String(req.params.commentId))) {
      return res.status(404).send('Comentário não encontrado.');
    }

    const comment = db
      .prepare('SELECT * FROM comments WHERE id = ? AND request_id = ?')
      .get(req.params.commentId, current.id);
    if (!comment) return res.status(404).send('Comentário não encontrado.');

    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return renderRequestDetail(res, db, current.id, 'O comentário não pode ser vazio.');
    if (textTooLong(body, LIMITS.commentChars)) {
      return renderRequestDetail(
        res,
        db,
        current.id,
        `O comentário deve ter no máximo ${LIMITS.commentChars} caracteres.`,
      );
    }

    db.prepare("UPDATE comments SET body = ?, edited_at = datetime('now','localtime') WHERE id = ?").run(
      body,
      comment.id,
    );
    return res.redirect(`/requisicoes/${current.id}`);
  });

  app.get('/requisicoes/:id/editar', requireAdmin, (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).send('Requisição não encontrada.');
    return renderRequestForm(res, { ...formOptions(), current, error: null });
  });

  app.post('/requisicoes/:id/editar', requireAdmin, (req, res) => {
    const current = getRequestById(db, req.params.id);
    if (!current) return res.status(404).send('Requisição não encontrada.');

    const { values, error } = validateRequestInput(db, req.body || {});
    if (error) {
      return renderRequestForm(res, { ...formOptions(), current: { ...values, id: current.id }, error });
    }

    // Um job rejeitado já perdeu a aprovação: segue as regras normais de etapa
    // (para retrabalho, volta para Em andamento) em vez de ser forçado a Em processo.
    const rejected = current.status === 'Rejeitado';
    const approved = hasApproval(current) && !rejected;
    if (!approved) {
      const transition = transitionError(db, current, values.status);
      if (transition) {
        return renderRequestForm(res, {
          ...formOptions(),
          current: { ...values, id: current.id },
          error: transition,
        });
      }
    }

    const clientId = resolveClientId(db, values);
    db.prepare(
      `UPDATE requests SET client_id = ?, title = ?, description = ?, status = ?, priority = ?,
        responsible_id = ?, due_date = ?, dropbox_url = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    ).run(
      clientId,
      values.title,
      values.description,
      approved ? 'Em processo' : values.status,
      values.priority,
      values.responsible_id,
      values.due_date || null,
      values.dropbox_url || null,
      current.id,
    );

    if (approved) db.prepare(CLEAR_APPROVALS_SQL).run(current.id);
    else if (rejected && values.status !== 'Rejeitado') db.prepare(CLEAR_FOR_REWORK_SQL).run(current.id);
    if (values.status !== 'Aprovado') {
      db.prepare('UPDATE requests SET completed_at = NULL WHERE id = ?').run(current.id);
    }
    if (!approved && values.status !== current.status) {
      if (values.status === 'Aprovação') openApprovalCycle(db, current.id);
      if (values.status === 'Em andamento') startWorkCycle(db, current.id);
      if (values.status === 'Novo') endWorkCycle(db, current.id);
    }
    return res.redirect(`/requisicoes/${current.id}`);
  });

  const ruleOptions = formOptions;

  const getRuleById = (id) => db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id);

  app.get('/agendamentos', requireAdmin, (req, res) => {
    const rules = db
      .prepare(
        `SELECT rr.*, c.name AS client_name, u.name AS responsible_name,
                (SELECT COUNT(*) FROM requests r WHERE r.generated_by_rule_id = rr.id) AS generated_count
         FROM recurring_rules rr
         JOIN clients c ON c.id = rr.client_id
         LEFT JOIN users u ON u.id = rr.responsible_id
         ORDER BY rr.active DESC, rr.next_run_at, rr.id`,
      )
      .all();
    res.render('agendamentos', { title: 'Agendamentos', rules, error: null });
  });

  app.get('/agendamentos/nova', requireAdmin, (req, res) => {
    renderRuleForm(res, { ...ruleOptions(), current: { interval_value: 1, interval_unit: 'dia', start_time: '09:00', due_days: 0, priority: 'Média' }, error: null });
  });

  app.post('/agendamentos', requireAdmin, (req, res) => {
    const { values, error } = validateRuleInput(db, req.body || {});
    if (error) return renderRuleForm(res, { ...ruleOptions(), current: values, error });

    db.prepare(
      `INSERT INTO recurring_rules (
         name, client_id, title, description, priority, responsible_id, due_days, dropbox_url,
         interval_value, interval_unit, start_time, active, next_run_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      values.name,
      values.client_id,
      values.title,
      values.description,
      values.priority,
      values.responsible_id,
      values.due_days,
      values.dropbox_url || null,
      values.interval_value,
      values.interval_unit,
      values.start_time,
      computeNextRun(values, new Date()),
      req.user.id,
    );
    return res.redirect('/agendamentos');
  });

  app.get('/agendamentos/:id/editar', requireAdmin, (req, res) => {
    const current = getRuleById(req.params.id);
    if (!current) return res.status(404).send('Agendamento não encontrado.');
    return renderRuleForm(res, { ...ruleOptions(), current, error: null });
  });

  app.post('/agendamentos/:id/editar', requireAdmin, (req, res) => {
    const current = getRuleById(req.params.id);
    if (!current) return res.status(404).send('Agendamento não encontrado.');

    const { values, error } = validateRuleInput(db, req.body || {});
    if (error) return renderRuleForm(res, { ...ruleOptions(), current: { ...values, id: current.id }, error });

    const scheduleChanged =
      values.interval_value !== Number(current.interval_value) ||
      values.interval_unit !== current.interval_unit ||
      values.start_time !== current.start_time;
    const nextRunAt = scheduleChanged ? computeNextRun(values, new Date()) : current.next_run_at;

    db.prepare(
      `UPDATE recurring_rules SET name = ?, client_id = ?, title = ?, description = ?,
         priority = ?, responsible_id = ?, due_days = ?, dropbox_url = ?,
         interval_value = ?, interval_unit = ?, start_time = ?, next_run_at = ?,
         updated_at = datetime('now','localtime') WHERE id = ?`,
    ).run(
      values.name,
      values.client_id,
      values.title,
      values.description,
      values.priority,
      values.responsible_id,
      values.due_days,
      values.dropbox_url || null,
      values.interval_value,
      values.interval_unit,
      values.start_time,
      nextRunAt,
      current.id,
    );
    return res.redirect('/agendamentos');
  });

  app.post('/agendamentos/:id/alternar', requireAdmin, (req, res) => {
    const current = getRuleById(req.params.id);
    if (!current) return res.status(404).send('Agendamento não encontrado.');
    db.prepare(
      `UPDATE recurring_rules SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END,
         next_run_at = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    ).run(computeNextRun(current, new Date()), current.id);
    return res.redirect('/agendamentos');
  });

  app.post('/agendamentos/:id/executar', requireAdmin, (req, res) => {
    const current = getRuleById(req.params.id);
    if (!current) return res.status(404).send('Agendamento não encontrado.');
    runRuleNow(db, current.id, new Date());
    return res.redirect('/agendamentos');
  });

  app.post('/agendamentos/:id/excluir', requireAdmin, (req, res) => {
    const current = getRuleById(req.params.id);
    if (!current) return res.status(404).send('Agendamento não encontrado.');
    db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(current.id);
    return res.redirect('/agendamentos');
  });

  app.get('/relatorios', requireAuth, (req, res) => {
    const raw = {
      granularidade: String(req.query.granularidade || ''),
      de: String(req.query.de || ''),
      ate: String(req.query.ate || ''),
      cliente: String(req.query.cliente || ''),
    };
    if (req.query.preset) {
      const preset = presetRange(String(req.query.preset));
      raw.granularidade = preset.granularidade;
      raw.de = preset.de;
      raw.ate = preset.ate;
    }

    let report;
    try {
      report = buildReport(db, raw);
    } catch (error) {
      return res.status(400).send(error.message);
    }

    return res.render('reports', {
      title: 'Relatórios',
      report,
      granularidades: GRANULARIDADES,
      clients: db.prepare('SELECT id, name FROM clients ORDER BY name').all(),
    });
  });

  const listClients = () =>
    db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM requests r WHERE r.client_id = c.id) AS job_count
         FROM clients c ORDER BY c.name`,
      )
      .all();

  const renderClientForm = (res, { current, error }) =>
    res.status(error ? 400 : 200).render('client-form', {
      title: current && current.id ? 'Editar cliente' : 'Novo cliente',
      current: current || {},
      error: error || null,
    });

  const renderClientList = (res, error = null) =>
    res.status(error ? 400 : 200).render('clients', {
      title: 'Clientes',
      clients: listClients(),
      error,
    });

  app.get('/clientes', requireAuth, (req, res) => {
    renderClientList(res);
  });

  app.get('/clientes/novo', requireAdmin, (req, res) => {
    renderClientForm(res, { current: null, error: null });
  });

  app.post('/clientes', requireAdmin, (req, res) => {
    const { values, error } = validateClientInput(req.body || {});
    if (error) return renderClientForm(res, { current: values, error });

    db.prepare(
      `INSERT INTO clients (name, description, website, instagram, facebook, whatsapp, linkedin, phone, email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      values.name,
      values.description,
      values.website || null,
      values.instagram || null,
      values.facebook || null,
      values.whatsapp || null,
      values.linkedin || null,
      values.phone || null,
      values.email || null,
    );
    return res.redirect('/clientes');
  });

  app.get('/clientes/:id', requireAuth, (req, res) => {
    const client = getClient(db, req.params.id);
    if (!client) return res.status(404).send('Cliente não encontrado.');
    const jobs = db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM comments c WHERE c.request_id = r.id) AS comment_count
         FROM requests r WHERE r.client_id = ? ORDER BY r.id DESC`,
      )
      .all(client.id);
    return res.render('client', { title: client.name, cliente: client, jobs });
  });

  app.get('/clientes/:id/editar', requireAdmin, (req, res) => {
    const client = getClient(db, req.params.id);
    if (!client) return res.status(404).send('Cliente não encontrado.');
    return renderClientForm(res, { current: client, error: null });
  });

  app.post('/clientes/:id/editar', requireAdmin, (req, res) => {
    const client = getClient(db, req.params.id);
    if (!client) return res.status(404).send('Cliente não encontrado.');

    const { values, error } = validateClientInput(req.body || {});
    if (error) return renderClientForm(res, { current: { ...values, id: client.id }, error });

    db.prepare(
      `UPDATE clients SET name = ?, description = ?, website = ?, instagram = ?, facebook = ?,
         whatsapp = ?, linkedin = ?, phone = ?, email = ? WHERE id = ?`,
    ).run(
      values.name,
      values.description,
      values.website || null,
      values.instagram || null,
      values.facebook || null,
      values.whatsapp || null,
      values.linkedin || null,
      values.phone || null,
      values.email || null,
      client.id,
    );
    return res.redirect(`/clientes/${client.id}`);
  });

  app.post('/clientes/:id/excluir', requireAdmin, (req, res) => {
    const client = getClient(db, req.params.id);
    if (!client) return res.status(404).send('Cliente não encontrado.');

    const jobs = getClientJobCount(db, client.id);
    if (jobs > 0) {
      return renderClientList(
        res,
        `Não é possível excluir "${client.name}": existem ${jobs} job(s) vinculados. Mova ou exclua os jobs primeiro.`,
      );
    }
    const rules = Number(
      db.prepare('SELECT COUNT(*) AS total FROM recurring_rules WHERE client_id = ?').get(client.id).total,
    );
    if (rules > 0) {
      return renderClientList(
        res,
        `Não é possível excluir "${client.name}": existem ${rules} agendamento(s) vinculados. Exclua os agendamentos primeiro.`,
      );
    }
    db.prepare('DELETE FROM clients WHERE id = ?').run(client.id);
    return res.redirect('/clientes');
  });

  app.use((req, res) => {
    res.status(404).send('Página não encontrada.');
  });
}

module.exports = { registerRoutes };
