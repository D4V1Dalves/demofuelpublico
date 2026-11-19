const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { aiConfig } = require('../src/ai');

let env;
const originalFetch = globalThis.fetch;
const originalProvider = process.env.AI_PROVIDER;
const originalKey = process.env.AI_API_KEY;

before(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_KEY;
  env = makeApp();
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = originalProvider;
  if (originalKey === undefined) delete process.env.AI_API_KEY;
  else process.env.AI_API_KEY = originalKey;
  env.cleanup();
});

function setAiEnv(provider, key) {
  if (provider) process.env.AI_PROVIDER = provider;
  else delete process.env.AI_PROVIDER;
  if (key) process.env.AI_API_KEY = key;
  else delete process.env.AI_API_KEY;
}

async function loginAdmin() {
  const agent = request.agent(env.app);
  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'admin@empresa.local', password: 'Admin@123' });
  assert.equal(res.status, 302);
  return agent;
}

const currentJobId = () =>
  env.app.locals.db.prepare("SELECT id FROM requests WHERE title = 'Relatório mensal de vendas'").get().id;

test('aiConfig is null when no key or provider is configured', () => {
  setAiEnv(null, null);
  assert.equal(aiConfig(), null);
  setAiEnv('openai', null);
  assert.equal(aiConfig(), null);
  setAiEnv(null, 'sk-teste');
  assert.equal(aiConfig(), null);
});

test('aiConfig accepts openai and anthropic providers', () => {
  setAiEnv('openai', 'sk-teste');
  assert.equal(aiConfig().provider, 'openai');
  setAiEnv('anthropic', 'sk-ant-teste');
  assert.equal(aiConfig().provider, 'anthropic');
  setAiEnv('desconhecido', 'chave');
  assert.equal(aiConfig(), null);
});

test('without AI configuration the endpoint uses local suggestions', async () => {
  setAiEnv(null, null);
  const agent = await loginAdmin();
  const res = await agent.post(`/requisicoes/${currentJobId()}/sugestoes`);

  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'local');
  assert.equal(res.body.fallback, undefined);
});

test('with OpenAI configured the endpoint returns generated suggestions', async () => {
  setAiEnv('openai', 'sk-teste');
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '1. Resumo executivo do relatório.\n2. Comparativo com o mês anterior.' } }],
      }),
    };
  };

  const agent = await loginAdmin();
  const res = await agent.post(`/requisicoes/${currentJobId()}/sugestoes`);

  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'ai');
  assert.equal(res.body.suggestions.length, 2);
  assert.match(res.body.suggestions[0].text, /Resumo executivo/);
  assert.match(captured.url, /api\.openai\.com/);
  assert.equal(captured.options.headers.Authorization, 'Bearer sk-teste');
});

test('with Anthropic configured the endpoint uses the x-api-key header', async () => {
  setAiEnv('anthropic', 'sk-ant-teste');
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      json: async () => ({ content: [{ text: '- Roteiro de apresentação\n- Lista de validação' }] }),
    };
  };

  const agent = await loginAdmin();
  const res = await agent.post(`/requisicoes/${currentJobId()}/sugestoes`);

  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'ai');
  assert.match(captured.url, /api\.anthropic\.com/);
  assert.equal(captured.options.headers['x-api-key'], 'sk-ant-teste');
});

test('an AI failure falls back to local suggestions with a notice', async () => {
  setAiEnv('openai', 'sk-teste');
  globalThis.fetch = async () => {
    throw new Error('API indisponível');
  };

  const agent = await loginAdmin();
  const res = await agent.post(`/requisicoes/${currentJobId()}/sugestoes`);

  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'local');
  assert.match(res.body.fallback, /indisponível|local/i);
  assert.ok(Array.isArray(res.body.suggestions));
});

test('a malformed AI response falls back to local suggestions', async () => {
  setAiEnv('openai', 'sk-teste');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [] }) });

  const agent = await loginAdmin();
  const res = await agent.post(`/requisicoes/${currentJobId()}/sugestoes`);

  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'local');
  assert.match(res.body.fallback, /indisponível|local/i);
});
