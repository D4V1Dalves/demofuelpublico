const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');

let env;
let requestId;

before(() => {
  env = makeApp();
  requestId = env.app.locals.db.prepare('SELECT id FROM requests LIMIT 1').get().id;
});

after(() => {
  env.cleanup();
});

async function loginRegularUser() {
  const agent = request.agent(env.app);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'usuario@empresa.local', password: 'Usuario@123' });
  assert.equal(res.status, 302);
  return agent;
}

test('anonymous user cannot upload an attachment', async () => {
  const res = await request(env.app)
    .post(`/requisicoes/${requestId}/anexos`)
    .attach('file', Buffer.from('%PDF-1.4 teste'), 'relatorio.pdf');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('user uploads a PDF and it appears in the detail page', async () => {
  const agent = await loginRegularUser();
  const res = await agent
    .post(`/requisicoes/${requestId}/anexos`)
    .attach('file', Buffer.from('%PDF-1.4 conteudo'), 'relatorio.pdf');

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/requisicoes/${requestId}`);

  const row = env.app.locals.db
    .prepare('SELECT * FROM attachments WHERE original_name = ?')
    .get('relatorio.pdf');
  assert.ok(row, 'attachment should be persisted');
  assert.equal(row.request_id, requestId);
  assert.ok(row.stored_name.endsWith('.pdf'));
  assert.equal(row.size, Buffer.from('%PDF-1.4 conteudo').length);

  const page = await agent.get(`/requisicoes/${requestId}`);
  assert.match(page.text, /relatorio\.pdf/);
  // O PDF é exibido dentro da própria página, sem link de download.
  assert.match(page.text, new RegExp(`<iframe[^>]*src="/anexos/${row.id}/preview`));
  assert.doesNotMatch(page.text, new RegExp(`href="/anexos/${row.id}"`));
  assert.doesNotMatch(page.text, />Baixar</);
  // A área de upload aceita arrastar e soltar.
  assert.match(page.text, /data-dropzone/);
  assert.match(page.text, /Arraste o arquivo aqui/);
});

test('imagem enviada aparece de verdade na galeria, sem link de download', async () => {
  const agent = await loginRegularUser();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const res = await agent
    .post(`/requisicoes/${requestId}/anexos`)
    .attach('file', png, 'captura.png');
  assert.equal(res.status, 302);

  const row = env.app.locals.db
    .prepare('SELECT id FROM attachments WHERE original_name = ?')
    .get('captura.png');
  assert.ok(row, 'png attachment should be persisted');

  const page = await agent.get(`/requisicoes/${requestId}`);
  assert.match(page.text, new RegExp(`<img[^>]*src="/anexos/${row.id}/preview"`));
  assert.match(page.text, /data-preview-kind="image"/);
  assert.doesNotMatch(page.text, new RegExp(`href="/anexos/${row.id}"`));

  const preview = await agent.get(`/anexos/${row.id}/preview`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers['content-type'] || '', /image\/png/);
  assert.match(preview.headers['content-disposition'] || '', /^inline/);
});

test('authenticated download returns the original file', async () => {
  const agent = await loginRegularUser();
  const row = env.app.locals.db
    .prepare('SELECT id FROM attachments WHERE original_name = ?')
    .get('relatorio.pdf');
  const res = await agent.get(`/anexos/${row.id}`);

  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'] || '', /relatorio\.pdf/);
  assert.ok(Buffer.isBuffer(res.body), 'download body should be binary');
  assert.match(res.body.toString('utf8'), /%PDF-1\.4 conteudo/);
});

test('anonymous download is redirected to /login', async () => {
  const row = env.app.locals.db
    .prepare('SELECT id FROM attachments WHERE original_name = ?')
    .get('relatorio.pdf');
  const res = await request(env.app).get(`/anexos/${row.id}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('anexo com nome acima do limite é rejeitado e não deixa arquivo órfão', async () => {
  const agent = await loginRegularUser();
  const before = env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n;
  const longName = `${'a'.repeat(252)}.pdf`;

  const res = await agent
    .post(`/requisicoes/${requestId}/anexos`)
    .attach('file', Buffer.from('%PDF-1.4 longo'), longName);

  assert.equal(res.status, 400);
  assert.match(res.text, /no máximo 255 caracteres/);
  assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, before);
});

test('disallowed file extensions are rejected', async () => {
  const agent = await loginRegularUser();
  const before = env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n;
  const res = await agent
    .post(`/requisicoes/${requestId}/anexos`)
    .attach('file', Buffer.from('MZ executable'), 'malware.exe');

  assert.equal(res.status, 400);
  assert.match(res.text, /permitido|inválido/i);
  assert.equal(env.app.locals.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, before);
});

test('files above 10 MB are rejected', async () => {
  const agent = await loginRegularUser();
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
  const res = await agent
    .post(`/requisicoes/${requestId}/anexos`)
    .attach('file', big, 'grande.txt');

  assert.equal(res.status, 400);
  assert.match(res.text, /Arquivo maior que 10 MB/);
});

test('downloading an unknown attachment id returns 404', async () => {
  const agent = await loginRegularUser();
  const res = await agent.get('/anexos/999999');
  assert.equal(res.status, 404);
});

test('preview inline do PDF é servido sem forçar download', async () => {
  const agent = await loginRegularUser();
  const row = env.app.locals.db
    .prepare('SELECT id FROM attachments WHERE original_name = ?')
    .get('relatorio.pdf');

  const res = await agent.get(`/anexos/${row.id}/preview`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] || '', /application\/pdf/);
  assert.match(res.headers['content-disposition'] || '', /^inline/);
  assert.match(res.body.toString('utf8'), /%PDF-1\.4 conteudo/);
});

test('preview de DOCX responde 415 e mantém o download disponível', async () => {
  const agent = await loginRegularUser();
  const upload = await agent
    .post(`/requisicoes/${requestId}/anexos`)
    .attach('file', Buffer.from('PK docx binario'), 'briefing.docx');
  assert.equal(upload.status, 302);

  const row = env.app.locals.db
    .prepare('SELECT id FROM attachments WHERE original_name = ?')
    .get('briefing.docx');
  assert.ok(row, 'docx attachment should be persisted');

  const preview = await agent.get(`/anexos/${row.id}/preview`);
  assert.equal(preview.status, 415);
  assert.match(preview.text, /não pode ser visualizado/i);

  const download = await agent.get(`/anexos/${row.id}`);
  assert.equal(download.status, 200);
});

test('preview anônimo é redirecionado para o login', async () => {
  const row = env.app.locals.db
    .prepare('SELECT id FROM attachments WHERE original_name = ?')
    .get('relatorio.pdf');
  const res = await request(env.app).get(`/anexos/${row.id}/preview`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('preview público da aprovação serve o anexo e valida o token', async () => {
  const agent = await loginRegularUser();
  const job = env.app.locals.db
    .prepare("SELECT * FROM requests WHERE title = 'Proposta de campanha'")
    .get();
  assert.ok(job.approval_token);

  const upload = await agent
    .post(`/requisicoes/${job.id}/anexos`)
    .attach('file', Buffer.from('%PDF-1.4 proposta'), 'proposta.pdf');
  assert.equal(upload.status, 302);

  const row = env.app.locals.db
    .prepare('SELECT id FROM attachments WHERE original_name = ?')
    .get('proposta.pdf');

  const res = await request(env.app).get(
    `/aprovacao/${job.approval_token}/anexo/${row.id}/preview`,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] || '', /application\/pdf/);
  assert.match(res.headers['content-disposition'] || '', /^inline/);

  const invalid = await request(env.app).get(
    `/aprovacao/token-invalido/anexo/${row.id}/preview`,
  );
  assert.equal(invalid.status, 404);
});

