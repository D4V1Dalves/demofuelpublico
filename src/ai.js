const ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

const { AI_PROVIDERS } = require('./settings');

const SYSTEM_PROMPT =
  'Você é um assistente interno que sugere textos, roteiros e conteúdos para jobs, com base em trabalhos anteriores. Responda em português do Brasil, de forma objetiva, uma sugestão por linha, sem numeração.';

// A escolha feita em Configurações > IA tem prioridade, inclusive "Desativada".
// Se o admin nunca salvou nada ali, valem as variáveis de ambiente
// AI_PROVIDER / AI_API_KEY / AI_MODEL. `source` diz de onde veio a configuração.
function aiConfig(env = process.env, stored = null) {
  if (stored && stored.enabled === false) return null;
  const useStored = Boolean(stored && stored.enabled === true);
  const source = useStored ? 'configuracoes' : 'ambiente';
  const provider = String((useStored ? stored.provider : env.AI_PROVIDER) || '').toLowerCase();
  const apiKey = String((useStored ? stored.apiKey : env.AI_API_KEY) || '');
  if (!apiKey || !Object.hasOwn(ENDPOINTS, provider)) return null;
  const model = String((useStored ? stored.model : env.AI_MODEL) || '').trim() || AI_PROVIDERS[provider].defaultModel;
  return { provider, apiKey, endpoint: ENDPOINTS[provider], model, source };
}

function buildPrompt(current, similar) {
  const context = similar.length
    ? similar.map((item, index) => `${index + 1}. ${item.jobTitle}: ${item.text}`).join('\n')
    : 'Nenhum job similar encontrado.';

  return [
    `Job atual: ${current.title}`,
    `Descrição: ${current.description || '(sem descrição)'}`,
    '',
    'Jobs similares anteriores:',
    context,
    '',
    'Gere até 3 sugestões curtas de texto, roteiro ou conteúdo reaproveitáveis para este job.',
  ].join('\n');
}

function parseSuggestions(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length >= 8)
    .slice(0, 3)
    .map((line) => ({ jobTitle: null, text: line, score: null }));
}

async function requestAiSuggestions({ current, similar, config, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const prompt = buildPrompt(current, similar);

  const headers =
    config.provider === 'openai'
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }
      : {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        };

  const body =
    config.provider === 'openai'
      ? {
          model: config.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0.4,
          max_tokens: 500,
        }
      : {
          model: config.model,
          // Teto (não custo): modelos atuais raciocinam antes de responder e o
          // raciocínio conta nesse limite. A resposta em si é curta.
          max_tokens: 4000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        };

  const response = await doFetch(config.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Falha na API de IA: HTTP ${response.status}`);

  const data = await response.json();
  const text =
    config.provider === 'openai'
      ? data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null
      : data && Array.isArray(data.content)
        ? data.content
            .filter((block) => block && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n') || null
        : null;

  const suggestions = parseSuggestions(text);
  if (suggestions.length === 0) throw new Error('Resposta de IA vazia');
  return suggestions;
}

module.exports = { aiConfig, requestAiSuggestions };
