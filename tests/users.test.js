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

const admin = () => login('admin@empresa.local', 'Admin@123');
const user = () => login('usuario@empresa.local', 'Usuario@123');

test('anonymous GET /usuarios redirects to /login', async () => {
  const res = await request(env.app).get('/usuarios');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('regular user cannot open /usuarios', async () => {
  const agent = await user();
  assert.equal((await agent.get('/usuarios')).status, 403);
});

test('admin sees the seeded users list', async () => {
  const agent = await admin();
  const res = await agent.get('/usuarios');
  assert.equal(res.status, 200);
  assert.match(res.text, /admin@empresa\.local/);
  assert.match(res.text, /usuario@empresa\.local/);
});

test('admin creates a user whose password is hashed and usable for login', async () => {
  const agent = await admin();
  const res = await agent.post('/usuarios').type('form').send({
    name: 'João Estoque',
    email: 'joao@empresa.local',
    password: 'SenhaSegura123',
    role: 'user',
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/usuarios');

  const row = env.app.locals.db.prepare('SELECT * FROM users WHERE email = ?').get('joao@empresa.local');
  assert.ok(row, 'user should be persisted');
  assert.equal(row.role, 'user');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.doesNotMatch(row.password_hash, /SenhaSegura123/);

  const newLogin = await login('joao@empresa.local', 'SenhaSegura123');
  const dashboard = await newLogin.get('/dashboard');
  assert.equal(dashboard.status, 200);
});

test('duplicate email and short password are rejected', async () => {
  const agent = await admin();
  const before = env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const duplicate = await agent.post('/usuarios').type('form').send({
    name: 'Duplicado',
    email: 'admin@empresa.local',
    password: 'SenhaSegura123',
    role: 'user',
  });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.text, /e-mail/i);

  const short = await agent.post('/usuarios').type('form').send({
    name: 'Senha Curta',
    email: 'curta@empresa.local',
    password: '123',
    role: 'user',
  });
  assert.equal(short.status, 400);
  assert.match(short.text, /senha/i);

  assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before);
});

test('regular user cannot create users', async () => {
  const agent = await user();
  const res = await agent.post('/usuarios').type('form').send({
    name: 'Invasor',
    email: 'invasor@empresa.local',
    password: 'SenhaSegura123',
    role: 'admin',
  });
  assert.equal(res.status, 403);
  assert.equal(
    env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('invasor@empresa.local').n,
    0,
  );
});
