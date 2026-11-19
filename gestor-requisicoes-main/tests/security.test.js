const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

let env;

before(() => {
  env = makeApp();
});

after(() => {
  env.cleanup();
});

async function login(email, password) {
  const agent = request.agent(env.app);
  const res = await agent.post('/login').type('form').send({ email, password });
  assert.equal(res.status, 302);
  return agent;
}

test('session cookie is HttpOnly and SameSite=Lax', async () => {
  const res = await request(env.app)
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });
  const cookie = (res.headers['set-cookie'] || []).find((c) => /^sid=/.test(c));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test('SESSION_COOKIE_SECURE=1 marks the session cookie as Secure', async () => {
  const saved = process.env.SESSION_COOKIE_SECURE;
  process.env.SESSION_COOKIE_SECURE = '1';
  try {
    const res = await request(env.app)
      .post('/login')
      .type('form')
      .send({ email: 'admin@empresa.local', password: 'Admin@123' });
    const cookie = (res.headers['set-cookie'] || []).find((c) => /^sid=/.test(c));
    assert.match(cookie, /;\s*Secure/i);
  } finally {
    if (saved === undefined) delete process.env.SESSION_COOKIE_SECURE;
    else process.env.SESSION_COOKIE_SECURE = saved;
  }
});

test('responses send X-Content-Type-Options: nosniff', async () => {
  const res = await request(env.app).get('/login');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('payloads above the parser limit return 413 instead of 500', async () => {
  const res = await request(env.app)
    .post('/login')
    .type('form')
    .send({ email: 'a@b.com', password: 'x'.repeat(300 * 1024) });
  assert.equal(res.status, 413);
  assert.match(res.text, /muito grande/i);
});

test('malformed JSON returns 400 instead of 500', async () => {
  const res = await request(env.app)
    .post('/login')
    .set('Content-Type', 'application/json')
    .send('{"email":');
  assert.equal(res.status, 400);
});

test('session token is persisted only as a SHA-256 hash', async () => {
  const res = await request(env.app)
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });
  const token = (res.headers['set-cookie'] || []).find((c) => /^sid=/.test(c)).split(';')[0].slice(4);
  const stored = env.app.locals.db.prepare('SELECT token_hash FROM sessions LIMIT 1').get().token_hash;

  assert.notEqual(stored, token);
  assert.equal(stored.length, 64);
  assert.match(stored, /^[0-9a-f]+$/);
});

test('POST with a foreign Origin is rejected with 403', async () => {
  const res = await request(env.app)
    .post('/login')
    .set('Origin', 'https://site-malicioso.example')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });
  assert.equal(res.status, 403);
  assert.match(res.text, /Origem não permitida/);
});

test('password change page requires authentication', async () => {
  const res = await request(env.app).get('/perfil/senha');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('changing password with a wrong current password is rejected', async () => {
  const agent = await login('usuario@empresa.local', 'Usuario@123');
  const res = await agent.post('/perfil/senha').type('form').send({
    current_password: 'errada',
    new_password: 'NovaSenha123',
    confirm_password: 'NovaSenha123',
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /atual/i);
});

test('user changes password and the new password works for login', async () => {
  const agent = await login('usuario@empresa.local', 'Usuario@123');
  const res = await agent.post('/perfil/senha').type('form').send({
    current_password: 'Usuario@123',
    new_password: 'NovaSenha123',
    confirm_password: 'NovaSenha123',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');

  const oldLogin = await request(env.app)
    .post('/login')
    .type('form')
    .send({ email: 'usuario@empresa.local', password: 'Usuario@123' });
  assert.equal(oldLogin.status, 401);

  const accepted = await login('usuario@empresa.local', 'NovaSenha123');
  assert.equal((await accepted.get('/dashboard')).status, 200);
});

test('short new passwords are rejected', async () => {
  const agent = await login('admin@empresa.local', 'Admin@123');
  const res = await agent.post('/perfil/senha').type('form').send({
    current_password: 'Admin@123',
    new_password: '123',
    confirm_password: '123',
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /8 caracteres/);
});

test('path traversal in a stored attachment name cannot expose arbitrary files', async () => {
  const secretPath = path.join(env.dir, 'segredo.txt');
  fs.writeFileSync(secretPath, 'CONTEUDO_SECRETO', 'utf8');

  const requestRow = env.app.locals.db.prepare('SELECT id FROM requests LIMIT 1').get();
  const userId = env.app.locals.db.prepare('SELECT id FROM users LIMIT 1').get();
  const result = env.app.locals.db
    .prepare(
      `INSERT INTO attachments (request_id, user_id, original_name, stored_name, mime_type, size)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(requestRow.id, userId.id, 'segredo.txt', '../segredo.txt', 'text/plain', 16);
  const attachmentId = Number(result.lastInsertRowid);

  const agent = await login('admin@empresa.local', 'Admin@123');
  const res = await agent.get(`/anexos/${attachmentId}`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(JSON.stringify(res.text), /CONTEUDO_SECRETO/);
});
