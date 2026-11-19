const path = require('node:path');
const { fmtDate, fmtDateTime, fmtDayMonth } = require('./format');
const express = require('express');
const { openDb, seed } = require('./db');
const { checkOrigin } = require('./security');
const { errorMessages } = require('./i18n');
const { attachUser } = require('./auth');
const { STATUS, PRIORITY, PREVIEW_MIME } = require('./config');
const { registerRoutes } = require('./routes');
const { formatLocalDate } = require('./scheduler-core');

function createApp({ dbPath, uploadDir, seedData = true, dbOptions } = {}) {
  const db = openDb(dbPath, dbOptions);
  if (seedData) seed(db);

  const app = express();
  app.disable('x-powered-by');
  // Atrás do Passenger/reverse proxy do cPanel o Express precisa confiar no
  // primeiro proxy para reconhecer HTTPS (e permitir cookie Secure).
  // Em produção (cPanel/Passenger) o app sempre fica atrás de um proxy: sem
  // isso, todos os usuários aparecem com o IP do proxy (limite de login por IP
  // e cookie Secure deixam de funcionar). TRUST_PROXY=0 desliga, =1 força.
  const trustProxy =
    process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY === '1' : process.env.NODE_ENV === 'production';
  if (trustProxy) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  const slug = (value) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const initials = (name) =>
    String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

  app.locals.STATUSES = STATUS;
  app.locals.PRIORITIES = PRIORITY;
  app.locals.STATUS_SLUG = Object.fromEntries(STATUS.map((s) => [s, slug(s)]));
  app.locals.PRIORITY_SLUG = Object.fromEntries(PRIORITY.map((p) => [p, slug(p)]));
  app.locals.initials = initials;
  app.locals.avatarUrl = (value) => (value ? `/avatars/${encodeURIComponent(value)}` : null);
  app.locals.PREVIEW_MIME = PREVIEW_MIME;
  app.locals.fmtDate = fmtDate;
  app.locals.fmtDateTime = fmtDateTime;
  app.locals.fmtDayMonth = fmtDayMonth;

  // Os limites acomodam descrições de 20.000 caracteres acentuados, que ficam
  // maiores depois do percent-encoding. Sem isso o parser devolveria 413 em
  // payloads que a aplicação aceita.
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(express.json({ limit: '64kb' }));
  // Impede que o navegador "adivinhe" o tipo de um arquivo enviado por usuário
  // (defesa extra para os avatares servidos em /avatars).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  app.use(
    '/avatars',
    express.static(path.join(uploadDir, 'avatars'), { maxAge: '7d', index: false, dotfiles: 'ignore' }),
  );
  app.use(checkOrigin);
  app.use(attachUser(db));
  app.use((req, res, next) => {
    res.locals.user = req.user;
    res.locals.path = req.path;
    res.locals.query = req.query;
    // Calculado a cada requisição, no fuso local: o board e o detalhe não podem
    // divergir do KPI de atrasadas (que usa a data local do banco).
    res.locals.today = formatLocalDate(new Date());
    // A lista de clientes da sidebar é carregada pelo próprio layout (top.ejs),
    // no máximo uma vez por requisição: JSON, downloads, redirects e partials
    // (como o painel lateral do job) não executam a consulta.
    let sidebarClients;
    res.locals.loadSidebarClients = () => {
      if (sidebarClients === undefined) {
        sidebarClients = req.user
          ? db
              .prepare(
                `SELECT c.id, c.name, COUNT(r.id) AS job_count
                 FROM clients c LEFT JOIN requests r ON r.client_id = c.id
                 GROUP BY c.id, c.name ORDER BY c.name COLLATE NOCASE`,
              )
              .all()
          : [];
      }
      return sidebarClients;
    };
    next();
  });

  registerRoutes(app, { db, uploadDir });

  app.use((req, res) => res.status(404).send('Página não encontrada.'));
  // Nunca devolver stack trace ao cliente, mesmo em desenvolvimento. Erros de
  // cliente (payload grande, JSON inválido, URL malformada) preservam o status.
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const requested = Number(error.status || error.statusCode || 0);
    const status = requested >= 400 && requested < 500 ? requested : 500;
    if (status === 500) console.error('[app] erro não tratado:', error);
    const messages = errorMessages(req);
    if (status === 413) return res.status(413).send(messages.tooLarge);
    if (status === 500) return res.status(500).send(messages.internal);
    return res.status(status).send(messages.invalid);
  });

  app.locals.db = db;
  app.locals.uploadDir = uploadDir;
  return app;
}

module.exports = { createApp };
