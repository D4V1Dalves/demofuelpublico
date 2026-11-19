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

test('GET /login renders the login form', async () => {
  const res = await request(env.app).get('/login');
  assert.equal(res.status, 200);
  assert.match(res.text, /Senha/);
  assert.match(res.text, /name="email"/);
});

test('POST /login rejects a wrong password', async () => {
  const res = await request(env.app)
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'senha-errada' });

  assert.equal(res.status, 401);
  assert.match(res.text, /inválid[oi]/i);
});

test('POST /login with seeded admin sets an HttpOnly session cookie and redirects', async () => {
  const res = await request(env.app)
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');

  const cookies = res.headers['set-cookie'] || [];
  assert.ok(
    cookies.some((c) => /^sid=/.test(c) && /HttpOnly/i.test(c)),
    'expected an HttpOnly sid cookie',
  );
});

test('POST /logout is protected and redirects anonymous users to /login', async () => {
  const res = await request(env.app).post('/logout');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('POST /logout clears the session cookie for an authenticated user', async () => {
  const agent = request.agent(env.app);
  const login = await agent
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });
  assert.equal(login.status, 302);

  const res = await agent.post('/logout');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');

  const cookies = res.headers['set-cookie'] || [];
  assert.ok(cookies.some((c) => /^sid=;/.test(c)), 'expected sid cookie to be cleared');

  const denied = await agent.get('/logout');
  assert.equal(denied.status, 404);
});

test('login is throttled after repeated failures for the same email', async () => {
  const attempt = () =>
    request(env.app)
      .post('/login')
      .type('form')
      .send({ email: 'bloqueio@empresa.local', password: 'senha-incorreta' });

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await attempt()).status, 401);
  }

  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /Muitas tentativas/);
});
