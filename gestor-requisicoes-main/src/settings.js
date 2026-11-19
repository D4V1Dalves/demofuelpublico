// Configurações do sistema guardadas no banco (tabela app_settings).
// Hoje: provedor, chave e modelo da IA que gera as sugestões.

const AI_PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', defaultModel: 'claude-opus-5-5' },
  openai: { label: 'OpenAI', defaultModel: 'gpt-4o-mini' },
};

function getSetting(db, name) {
  const row = db.prepare('SELECT setting_value FROM app_settings WHERE setting_name = ?').get(name);
  return row ? row.setting_value : null;
}

// Uma instrução só (REPLACE no MySQL): dois salvamentos simultâneos não colidem.
function setSetting(db, name, value) {
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (setting_name, setting_value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
  ).run(name, value);
}

// enabled: true/false quando o admin já escolheu em Configurações > IA;
// null quando nunca salvou (aí valem as variáveis de ambiente do servidor).
const AI_KEYS = ['ai_enabled', 'ai_provider', 'ai_api_key', 'ai_model'];

function getAiSettings(db) {
  const values = Object.fromEntries(
    db
      .prepare(`SELECT setting_name, setting_value FROM app_settings WHERE setting_name IN (${AI_KEYS.map(() => '?').join(', ')})`)
      .all(...AI_KEYS)
      .map((row) => [row.setting_name, row.setting_value]),
  );
  const enabled = values.ai_enabled ?? null;
  return {
    enabled: enabled === null ? null : enabled === '1',
    provider: values.ai_provider || '',
    apiKey: values.ai_api_key || '',
    model: values.ai_model || '',
  };
}

// Mostra só o fim da chave na tela: o valor completo nunca volta ao navegador.
function maskApiKey(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`;
}

module.exports = { AI_PROVIDERS, getSetting, setSetting, getAiSettings, maskApiKey };
