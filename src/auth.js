const { randomToken, sha256 } = require('./security');
const { SESSION_MS } = require('./config');

function parseCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function createSession(db, userId) {
  const token = randomToken();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    Date.now() + SESSION_MS,
  );
  return token;
}

function userFromToken(db, token) {
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
      )
      .get(sha256(token), Date.now()) || null
  );
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function attachUser(db) {
  return (req, res, next) => {
    const token = parseCookies(req).sid;
    req.user = userFromToken(db, token);
    req.sessionToken = req.user ? token : null;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.status(403).send('Acesso negado.');
  return next();
}

module.exports = {
  createSession,
  userFromToken,
  destroySession,
  attachUser,
  requireAuth,
  requireAdmin,
  SESSION_MS,
};
