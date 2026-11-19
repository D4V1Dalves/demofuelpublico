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

async function login(email = 'usuario@empresa.local', password = 'Usuario@123') {
  const agent = request.agent(env.app);
  const res = await agent.post('/login').type('form').send({ email, password });
  assert.equal(res.status, 302);
  return agent;
}

const userRow = () =>
  env.app.locals.db.prepare("SELECT * FROM users WHERE email = 'usuario@empresa.local'").get();

const avatarPath = (stored) => path.join(env.uploadDir, 'avatars', stored);

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('anonymous visitors are redirected from /perfil to /login', async () => {
  const res = await request(env.app).get('/perfil');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('profile page shows the account name and the photo form', async () => {
  const agent = await login();
  const res = await agent.get('/perfil');

  assert.equal(res.status, 200);
  assert.match(res.text, /Meu perfil/);
  assert.match(res.text, /usuario@empresa\.local/);
  assert.match(res.text, /action="\/perfil"/);
  assert.match(res.text, /action="\/perfil\/foto"/);
  assert.match(res.text, /enctype="multipart\/form-data"/);
  assert.match(res.text, /name="name"/);
});

test('user updates the account name and sees it in the sidebar', async () => {
  const agent = await login();
  const res = await agent.post('/perfil').type('form').send({ name: '  Maria Silva  ' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/perfil?ok=1');
  assert.equal(userRow().name, 'Maria Silva');

  const page = await agent.get('/perfil?ok=1');
  assert.match(page.text, /Perfil atualizado com sucesso/);
  assert.match(page.text, /Maria Silva/);
});

test('empty or oversized account names are rejected', async () => {
  const agent = await login();
  const previous = userRow().name;

  const empty = await agent.post('/perfil').type('form').send({ name: '   ' });
  assert.equal(empty.status, 400);
  assert.match(empty.text, /O nome é obrigatório/);
  assert.equal(userRow().name, previous);

  const long = await agent.post('/perfil').type('form').send({ name: 'x'.repeat(121) });
  assert.equal(long.status, 400);
  assert.match(long.text, /no máximo 120 caracteres/);
  assert.equal(userRow().name, previous);
});

test('user uploads a PNG avatar that is served from /avatars', async () => {
  const agent = await login();
  const res = await agent.post('/perfil/foto').attach('photo', png, 'minha-foto.png');

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/perfil?ok=1');

  const stored = userRow().avatar;
  assert.ok(stored, 'avatar filename should be saved on the user');
  assert.match(stored, /\.png$/);
  assert.ok(fs.existsSync(avatarPath(stored)), 'avatar file should exist on disk');

  const image = await request(env.app).get(`/avatars/${stored}`);
  assert.equal(image.status, 200);
  assert.equal(image.body.length, png.length);

  const profile = await agent.get('/perfil');
  assert.match(profile.text, new RegExp(`/avatars/${stored}`));

  const dashboard = await agent.get('/dashboard');
  assert.match(dashboard.text, new RegExp(`/avatars/${stored}`));
});

test('replacing the avatar removes the previous file', async () => {
  const agent = await login();

  // Autossuficiente: garante uma foto anterior mesmo rodando o teste isolado.
  const first = await agent.post('/perfil/foto').attach('photo', png, 'primeira.png');
  assert.equal(first.status, 302);
  const previous = userRow().avatar;
  assert.ok(previous);

  const res = await agent.post('/perfil/foto').attach('photo', png, 'outra.png');
  assert.equal(res.status, 302);

  const current = userRow().avatar;
  assert.ok(current);
  assert.notEqual(current, previous);
  assert.ok(fs.existsSync(avatarPath(current)), 'new avatar should exist');
  assert.ok(!fs.existsSync(avatarPath(previous)), 'old avatar should be deleted');
});

test('avatar upload rejects unsupported formats and keeps the current photo', async () => {
  const agent = await login();
  const previous = userRow().avatar;

  const res = await agent
    .post('/perfil/foto')
    .attach('photo', Buffer.from('GIF89a'), 'animacao.gif');

  assert.equal(res.status, 400);
  assert.match(res.text, /PNG, JPG ou WebP/);
  assert.equal(userRow().avatar, previous);
});

test('avatar upload rejects a fake image whose content is not a real photo', async () => {
  const agent = await login();
  const previous = userRow().avatar;

  const res = await agent.post('/perfil/foto').attach('photo', Buffer.from('<html>oi</html>'), {
    filename: 'falsa.png',
    contentType: 'image/png',
  });

  assert.equal(res.status, 400);
  assert.match(res.text, /PNG, JPG ou WebP/);
  assert.equal(userRow().avatar, previous);
});

test('avatar upload rejects files above 3 MB', async () => {
  const agent = await login();
  const previous = userRow().avatar;
  const big = Buffer.alloc(3 * 1024 * 1024 + 1, 1);

  const res = await agent.post('/perfil/foto').attach('photo', big, 'grande.png');

  assert.equal(res.status, 400);
  assert.match(res.text, /no máximo 3 MB/);
  assert.equal(userRow().avatar, previous);
});

test('user can remove the profile photo', async () => {
  const agent = await login();

  // Autossuficiente: cria a foto que será removida neste teste.
  const upload = await agent.post('/perfil/foto').attach('photo', png, 'para-remover.png');
  assert.equal(upload.status, 302);
  const previous = userRow().avatar;
  assert.ok(previous);
  const file = avatarPath(previous);

  const res = await agent.post('/perfil/foto/remover');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/perfil?ok=1');
  assert.equal(userRow().avatar, null);
  assert.ok(!fs.existsSync(file), 'removed avatar file should be deleted');

  const page = await agent.get('/perfil');
  assert.doesNotMatch(page.text, /\/avatars\//);
});

test('admin users list exposes the photo column', async () => {
  const agent = await login('admin@empresa.local', 'Admin@123');
  const res = await agent.get('/usuarios');

  assert.equal(res.status, 200);
  assert.match(res.text, /class="col-photo"/);
});
