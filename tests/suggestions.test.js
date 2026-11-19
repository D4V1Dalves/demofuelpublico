const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { localSuggestions, buildCorpus } = require('../src/suggestions');

let env;

before(() => {
  env = makeApp();
});

after(() => {
  env.cleanup();
});

const db = () => env.app.locals.db;

async function loginRegularUser() {
  const agent = request.agent(env.app);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'usuario@empresa.local', password: 'Usuario@123' });
  assert.equal(res.status, 302);
  return agent;
}

const corpus = () => db().prepare('SELECT id, title, description FROM requests').all().map((job) => ({
  ...job,
  comments: db()
    .prepare('SELECT body FROM comments WHERE request_id = ?')
    .all(job.id)
    .map((c) => c.body),
}));

test('localSuggestions ranks jobs by shared meaningful terms', () => {
  const jobs = [
    { id: 1, title: 'Campanha de lançamento', description: 'Criar roteiro e linha visual para campanha.', comments: [] },
    { id: 2, title: 'Ajuste no layout', description: 'Alinhar banners e cores da marca.', comments: [] },
    { id: 3, title: 'Roteiro institucional', description: 'Escrever roteiro para video institucional.', comments: [] },
  ];
  const current = { id: 4, title: 'Novo roteiro de campanha', description: 'Roteiro para campanha de lançamento.', comments: [] };

  const suggestions = localSuggestions(current, jobs, 2);

  assert.equal(suggestions.length, 2);
  assert.deepEqual(suggestions.map((s) => s.jobId).sort(), [1, 3]);
  assert.ok(suggestions.every((s) => s.text.length > 0));
  assert.ok(suggestions.every((s) => typeof s.score === 'number'));
});

test('localSuggestions excludes the current job and ignores stopwords', () => {
  const jobs = [
    { id: 1, title: 'Campanha de lançamento', description: 'Roteiro atual e linha visual para campanha.', comments: [] },
    { id: 2, title: 'Job atual', description: 'Descrição do job atual.', comments: [] },
  ];
  const current = { id: 2, title: 'Job atual', description: 'Descrição do job atual.', comments: [] };

  const suggestions = localSuggestions(current, jobs, 3);

  assert.ok(suggestions.every((s) => s.jobId !== 2));
  assert.equal(suggestions.length, 1);
});

test('localSuggestions returns an empty list when there is no overlap', () => {
  const jobs = [{ id: 1, title: 'Migração de dados', description: 'Validar importação legada.', comments: [] }];
  const current = { id: 2, title: 'Treinamento da equipe', description: 'Agendar sessão com o time.', comments: [] };

  assert.deepEqual(localSuggestions(current, jobs, 3), []);
});

test('buildCorpus usa 2 consultas fixas, limita os jobs e não repete a descrição por comentário', () => {
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      statements.push(sql);
      return {
        all: () =>
          /FROM requests/.test(sql)
            ? [
                { id: 2, title: 'Sem comentário', description: 'e' },
                { id: 1, title: 'Campanha', description: 'd' },
              ]
            : [
                { request_id: 1, body: 'segundo' },
                { request_id: 1, body: 'primeiro' },
              ],
        get: () => null,
      };
    },
  };

  const corpus = buildCorpus(fakeDb);

  assert.equal(statements.length, 2);
  assert.match(statements[0], /ORDER BY id DESC LIMIT 300/);
  assert.doesNotMatch(statements[1], /description/);
  assert.deepEqual(corpus, [
    { id: 1, title: 'Campanha', description: 'd', comments: ['primeiro', 'segundo'] },
    { id: 2, title: 'Sem comentário', description: 'e', comments: [] },
  ]);
});

test('buildCorpus corta textos longos e inclui o job atual mesmo fora dos mais recentes', () => {
  const db = env.app.locals.db;
  const longText = 'x'.repeat(5000);
  const id = Number(
    db.prepare("INSERT INTO requests (client_id, title, description, status, priority, created_by) VALUES (1, 'Longo', ?, 'Novo', 'Média', 1)")
      .run(longText).lastInsertRowid,
  );
  db.prepare('INSERT INTO comments (request_id, user_id, body) VALUES (?, 1, ?)').run(id, longText);
  const job = buildCorpus(db).find((item) => item.id === id);
  assert.equal(job.description.length, 2000);
  assert.equal(job.comments[0].length, 2000);
});

test('suggestions endpoint requires authentication', async () => {
  const res = await request(env.app).post('/requisicoes/1/sugestoes');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('suggestions endpoint returns local suggestions as JSON', async () => {
  const agent = await loginRegularUser();
  const adminAgent = await request.agent(env.app);
  await adminAgent
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });
  await adminAgent.post('/requisicoes').type('form').send({
    client_id: String(db().prepare('SELECT id FROM clients LIMIT 1').get().id),
    title: 'Relatório de vendas atualizado',
    description: 'Exportar dados de vendas e validar totais.',
    status: 'Novo',
    priority: 'Média',
    responsible_id: '',
    due_date: '',
  });

  const current = db()
    .prepare('SELECT id FROM requests WHERE title = ?')
    .get('Relatório mensal de vendas');
  const res = await agent.post(`/requisicoes/${current.id}/sugestoes`);

  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'local');
  assert.ok(Array.isArray(res.body.suggestions));
  assert.ok(res.body.suggestions.length >= 1);
  assert.ok(res.body.suggestions.length <= 3);
  assert.ok(res.body.suggestions[0].text);
  assert.ok(res.body.suggestions[0].jobTitle);
});

test('suggestions endpoint returns 404 for an unknown job', async () => {
  const agent = await loginRegularUser();
  const res = await agent.post('/requisicoes/999999/sugestoes');
  assert.equal(res.status, 404);
});

test('job detail page contains the suggestions panel and the comment field', async () => {
  const agent = await loginRegularUser();
  const job = db().prepare('SELECT id FROM requests LIMIT 1').get();
  const res = await agent.get(`/requisicoes/${job.id}`);

  assert.equal(res.status, 200);
  assert.match(res.text, /id="suggestions-panel"/);
  assert.match(res.text, /Gerar sugestões/);
  assert.match(res.text, /id="body"/);
});
