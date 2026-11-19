const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { aiConfig } = require('../src/ai');
const { getAiSettings } = require('../src/settings');

let env;
const originalFetch = globalThis.fetch;
const saved = { provider: process.env.AI_PROVIDER, key: process.env.AI_API_KEY, model: process.env.AI_MODEL };

before(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  env = makeApp();
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of [['AI_PROVIDER', saved.provider], ['AI_API_KEY', saved.key], ['AI_MODEL', saved.model]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  env.cleanup();
});

async function login(email, password) {
  const agent = request.agent(env.app);
  assert.equal((await agent.post('/login').type('form').send({ email, password })).status, 302);
  return agent;
}
const admin = () => login('admin@empresa.local', 'Admin@123');
const user = () => login('usuario@empresa.local', 'Usuario@123');
const db = () => env.app.locals.db;

test('configurações: abas por papel e engrenagem na sidebar', async () => {
  const a = await admin();
  const page = await a.get('/configuracoes');
  assert.equal(page.status, 200);
  for (const href of ['/configuracoes', '/perfil', '/perfil/senha', '/configuracoes/ia', '/usuarios']) {
    assert.match(page.text, new RegExp(`class="settings-tab[^"]*" href="${href.replace(/\//g, '\\/')}"`));
  }
  assert.match(page.text, /side-settings is-active/);

  const u = await user();
  const userPage = await u.get('/configuracoes');
  assert.equal(userPage.status, 200);
  assert.doesNotMatch(userPage.text, /href="\/configuracoes\/ia"/);
  assert.doesNotMatch(userPage.text, /href="\/usuarios"/);
  // Usuário comum também vê Clientes, agora dentro de Administração.
  const nav = userPage.text.slice(userPage.text.indexOf('Administração'));
  assert.match(nav, /href="\/clientes"/);
  assert.doesNotMatch(nav, /href="\/agendamentos"/);
  assert.equal((await u.get('/configuracoes/ia')).status, 403);
  assert.equal((await u.post('/configuracoes/ia').type('form').send({ provider: 'openai', api_key: 'x' })).status, 403);
});

test('admin salva a IA; a chave não volta para a tela e vale mais que o ambiente', async () => {
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_API_KEY = 'sk-env';
  const a = await admin();

  let res = await a.post('/configuracoes/ia').type('form').send({ provider: 'anthropic', model: '', api_key: 'sk-ant-segredo-1234' });
  assert.equal(res.status, 302);
  assert.deepEqual(getAiSettings(db()), { enabled: true, provider: 'anthropic', apiKey: 'sk-ant-segredo-1234', model: '' });

  const page = await a.get('/configuracoes/ia');
  assert.doesNotMatch(page.text, /sk-ant-segredo-1234/);
  assert.match(page.text, /••••1234/);
  assert.match(page.text, /claude-opus-5-5/);

  const config = aiConfig(process.env, getAiSettings(db()));
  assert.equal(config.provider, 'anthropic');
  assert.equal(config.model, 'claude-opus-5-5');
  assert.equal(config.apiKey, 'sk-ant-segredo-1234');

  // Salvar de novo sem chave mantém a chave salva e troca o modelo.
  res = await a.post('/configuracoes/ia').type('form').send({ provider: 'anthropic', model: 'claude-sonnet-5-5', api_key: '' });
  assert.equal(res.status, 302);
  assert.equal(getAiSettings(db()).apiKey, 'sk-ant-segredo-1234');
  assert.equal(aiConfig(process.env, getAiSettings(db())).model, 'claude-sonnet-5-5');

  // Trocar de provedor sem nova chave é recusado.
  res = await a.post('/configuracoes/ia').type('form').send({ provider: 'openai', model: '', api_key: '' });
  assert.equal(res.status, 400);

  // Validações.
  assert.equal((await a.post('/configuracoes/ia').type('form').send({ provider: 'outra', api_key: 'x' })).status, 400);
  assert.equal((await a.post('/configuracoes/ia').type('form').send({ provider: 'anthropic', model: 'tem espaço' })).status, 400);

  // "Desativada" desliga de verdade (mesmo com IA no ambiente) e mantém a chave salva.
  res = await a.post('/configuracoes/ia').type('form').send({ provider: '', model: '', api_key: '' });
  assert.equal(res.status, 302);
  assert.equal(getAiSettings(db()).apiKey, 'sk-ant-segredo-1234');
  assert.equal(aiConfig(process.env, getAiSettings(db())), null);
  assert.match((await a.get('/configuracoes/ia')).text, /IA desativada/);

  // Reativar sem colar a chave de novo.
  res = await a.post('/configuracoes/ia').type('form').send({ provider: 'anthropic', model: '', api_key: '' });
  assert.equal(res.status, 302);
  assert.equal(aiConfig(process.env, getAiSettings(db())).provider, 'anthropic');

  // Remover a chave explicitamente.
  res = await a.post('/configuracoes/ia').type('form').send({ provider: '', model: '', api_key: '', remove_key: '1' });
  assert.equal(res.status, 302);
  assert.equal(getAiSettings(db()).apiKey, '');
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_KEY;
});

test('sugestões usam o modelo salvo e leem só os blocos de texto da resposta', async () => {
  const a = await admin();
  await a.post('/configuracoes/ia').type('form').send({ provider: 'anthropic', model: '', api_key: 'sk-ant-xyz' });
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: '- Roteiro de apresentação do produto\n- Lista de validação final' },
        ],
      }),
    };
  };
  const jobId = db().prepare("SELECT id FROM requests WHERE title = 'Relatório mensal de vendas'").get().id;
  const res = await a.post(`/requisicoes/${jobId}/sugestoes`);
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'ai');
  assert.equal(res.body.suggestions.length, 2);
  assert.equal(captured.model, 'claude-opus-5-5');
});

test('IA do servidor: formulário mostra a opção e trocar de provedor zera o modelo antigo', async () => {
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_API_KEY = 'sk-env';
  const a = await admin();
  // Volta para a configuração do servidor.
  await a.post('/configuracoes/ia').type('form').send({ provider: 'ambiente' });
  const page = await a.get('/configuracoes/ia');
  assert.match(page.text, /<option value="ambiente" selected>/);
  assert.equal(aiConfig(process.env, getAiSettings(db())).source, 'ambiente');

  await a.post('/configuracoes/ia').type('form').send({ provider: 'anthropic', model: 'claude-sonnet-5-5', api_key: 'sk-ant-1' });
  await a.post('/configuracoes/ia').type('form').send({ provider: 'openai', model: 'claude-sonnet-5-5', api_key: 'sk-openai-2' });
  const config = aiConfig(process.env, getAiSettings(db()));
  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'gpt-4o-mini');
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_KEY;
});
