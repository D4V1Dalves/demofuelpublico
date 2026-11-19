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

async function login(role = 'admin') {
  const agent = request.agent(env.app);
  const credentials =
    role === 'admin'
      ? { email: 'admin@empresa.local', password: 'Admin@123' }
      : { email: 'usuario@empresa.local', password: 'Usuario@123' };
  assert.equal((await agent.post('/login').type('form').send(credentials)).status, 302);
  return agent;
}

const fullClient = {
  name: 'Nova Loja',
  description: 'Loja de roupas autorais em Campinas.',
  website: 'novaloja.com.br',
  instagram: '@novaloja',
  facebook: 'facebook.com/novaloja',
  whatsapp: '19999999999',
  linkedin: 'linkedin.com/company/novaloja',
  phone: '(19) 99999-9999',
  email: 'contato@novaloja.com.br',
};

test('clientes exigem login; gestão é somente Admin', async () => {
  assert.equal((await request(env.app).get('/clientes')).status, 302);
  assert.equal((await (await login('user')).get('/clientes')).status, 200);
  assert.equal((await (await login('user')).get('/clientes/novo')).status, 403);
  assert.equal((await (await login()).get('/clientes/novo')).status, 200);
});

test('nome, telefone e e-mail do cliente respeitam os limites do MySQL', async () => {
  const admin = await login();
  const before = env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM clients').get().n;

  const longName = await admin
    .post('/clientes')
    .type('form')
    .send({ ...fullClient, name: 'x'.repeat(161) });
  assert.equal(longName.status, 400);
  assert.match(longName.text, /no máximo 160 caracteres/);

  const longPhone = await admin
    .post('/clientes')
    .type('form')
    .send({ ...fullClient, phone: '9'.repeat(41) });
  assert.equal(longPhone.status, 400);
  assert.match(longPhone.text, /no máximo 40 caracteres/);

  const longEmail = await admin
    .post('/clientes')
    .type('form')
    .send({ ...fullClient, email: `${'a'.repeat(190)}@x.com` });
  assert.equal(longEmail.status, 400);
  assert.match(longEmail.text, /no máximo 190 caracteres/);

  const longWebsite = await admin
    .post('/clientes')
    .type('form')
    .send({ ...fullClient, website: `https://${'a'.repeat(3000)}.com` });
  assert.equal(longWebsite.status, 400);
  assert.match(longWebsite.text, /no máximo 2048 caracteres/);

  assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, before);
});

test('admin cria cliente com ficha completa e links normalizados', async () => {
  const admin = await login();
  assert.equal((await admin.post('/clientes').type('form').send(fullClient)).status, 302);
  const row = env.app.locals.db.prepare('SELECT * FROM clients WHERE name = ?').get('Nova Loja');
  assert.ok(row);
  assert.equal(row.description, fullClient.description);
  assert.equal(row.website, 'https://novaloja.com.br');
  assert.equal(row.instagram, 'https://instagram.com/novaloja');
  assert.equal(row.facebook, 'https://facebook.com/novaloja');
  assert.equal(row.whatsapp, 'https://wa.me/19999999999');
  assert.equal(row.linkedin, 'https://linkedin.com/company/novaloja');
  assert.equal(row.phone, fullClient.phone);
  assert.equal(row.email, fullClient.email);
});

test('validação rejeita nome vazio, e-mail inválido e link inválido', async () => {
  const admin = await login();
  for (const override of [
    { name: '   ' },
    { email: 'triangular' },
    { website: 'ftp://invalido' },
  ]) {
    const res = await admin.post('/clientes').type('form').send({ ...fullClient, ...override });
    assert.equal(res.status, 400, `deveria rejeitar ${JSON.stringify(override)}`);
  }
});

test('usuário comum vê a ficha, mas não pode editar nem excluir', async () => {
  const admin = await login();
  const user = await login('user');
  const row = env.app.locals.db.prepare("SELECT id FROM clients WHERE name = 'Nova Loja'").get();

  const page = await user.get(`/clientes/${row.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Nova Loja/);
  assert.match(page.text, /Loja de roupas autorais/);
  assert.match(page.text, /https:\/\/instagram\.com\/novaloja/);
  assert.match(page.text, /https:\/\/wa\.me\/19999999999/);
  assert.match(page.text, /contato@novaloja\.com\.br/);
  assert.match(page.text, /Jobs do cliente/i);

  assert.equal((await user.get(`/clientes/${row.id}/editar`)).status, 403);
  assert.equal((await user.post(`/clientes/${row.id}/excluir`).type('form').send({})).status, 403);
  assert.equal((await admin.get(`/clientes/${row.id}/editar`)).status, 200);
});

test('admin edita a ficha do cliente', async () => {
  const admin = await login();
  const row = env.app.locals.db.prepare("SELECT id FROM clients WHERE name = 'Nova Loja'").get();
  const res = await admin.post(`/clientes/${row.id}/editar`).type('form').send({
    ...fullClient,
    name: 'Nova Loja Editada',
    description: 'Descrição atualizada.',
    instagram: 'outra_loja',
  });
  assert.equal(res.status, 302);
  const updated = env.app.locals.db.prepare('SELECT * FROM clients WHERE id = ?').get(row.id);
  assert.equal(updated.name, 'Nova Loja Editada');
  assert.equal(updated.description, 'Descrição atualizada.');
  assert.equal(updated.instagram, 'https://instagram.com/outra_loja');
});

test('exclusão é bloqueada enquanto existirem jobs do cliente', async () => {
  const admin = await login();
  const row = env.app.locals.db.prepare("SELECT id FROM clients WHERE name = 'Nova Loja Editada'").get();
  env.app.locals.db
    .prepare(
      "INSERT INTO requests (client_id, title, description, status, priority, created_by) VALUES (?, 'Job do cliente', 'Teste', 'Novo', 'Média', 1)",
    )
    .run(row.id);

  const res = await admin.post(`/clientes/${row.id}/excluir`).type('form').send({});
  assert.equal(res.status, 400);
  assert.match(res.text, /job/i);
  assert.ok(env.app.locals.db.prepare('SELECT 1 FROM clients WHERE id = ?').get(row.id));
});

test('cliente sem jobs pode ser excluído', async () => {
  const admin = await login();
  const row = env.app.locals.db.prepare("SELECT id FROM clients WHERE name = 'Nova Loja Editada'").get();
  env.app.locals.db.prepare('DELETE FROM requests WHERE client_id = ?').run(row.id);
  assert.equal((await admin.post(`/clientes/${row.id}/excluir`).type('form').send({})).status, 302);
  assert.equal(env.app.locals.db.prepare('SELECT 1 FROM clients WHERE id = ?').get(row.id), undefined);
});

test('lista de clientes mostra links de gestão apenas para Admin', async () => {
  const userPage = await (await login('user')).get('/clientes');
  assert.match(userPage.text, /Acme Ltda/);
  assert.doesNotMatch(userPage.text, /Novo cliente/);

  const adminPage = await (await login()).get('/clientes');
  assert.match(adminPage.text, /Novo cliente/);
  assert.match(adminPage.text, /href="\/clientes\/1"/);
});
