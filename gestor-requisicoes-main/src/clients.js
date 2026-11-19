const { LIMITS } = require('./config');

const NETWORK_HOSTS = {
  instagram: 'instagram.com',
  facebook: 'facebook.com',
  linkedin: 'linkedin.com',
};

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme && !['http:', 'https:'].includes(`${scheme[1].toLowerCase()}:`)) {
    return null;
  }
  const candidate = scheme ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return null;
    return candidate;
  } catch {
    return null;
  }
}

function normalizeSocialUrl(value, kind) {
  const text = String(value || '').trim();
  if (!text) return '';

  if (kind === 'whatsapp') {
    const digits = text.replace(/\D/g, '');
    if (/^\d{10,15}$/.test(digits) && !/^https?:\/\//i.test(text)) {
      return `https://wa.me/${digits}`;
    }
    return normalizeUrl(text) || '';
  }

  const host = NETWORK_HOSTS[kind];
  if (!host) return normalizeUrl(text) || '';
  if (/^https?:\/\//i.test(text)) return normalizeUrl(text) || '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return '';

  const withoutAt = text.replace(/^@+/, '').replace(/^\/+/, '');
  if (!withoutAt) return '';
  if (withoutAt.includes('/') || withoutAt.includes('.')) {
    return normalizeUrl(withoutAt) || '';
  }
  return `https://${host}/${withoutAt}`;
}

function validateClientInput(body) {
  const values = {
    name: String((body && body.name) || '').trim(),
    description: String((body && body.description) || '').trim(),
    website: normalizeUrl((body && body.website) || '') || '',
    instagram: normalizeSocialUrl((body && body.instagram) || '', 'instagram'),
    facebook: normalizeSocialUrl((body && body.facebook) || '', 'facebook'),
    whatsapp: normalizeSocialUrl((body && body.whatsapp) || '', 'whatsapp'),
    linkedin: normalizeSocialUrl((body && body.linkedin) || '', 'linkedin'),
    phone: String((body && body.phone) || '').trim(),
    email: String((body && body.email) || '').trim(),
  };

  if (!values.name) return { error: 'O nome do cliente é obrigatório.' };
  if (values.name.length > LIMITS.clientName) {
    return { error: `O nome do cliente deve ter no máximo ${LIMITS.clientName} caracteres.` };
  }
  if (
    values.description.length > LIMITS.descriptionChars ||
    Buffer.byteLength(values.description, 'utf8') > LIMITS.textBytes
  ) {
    return { error: `A descrição deve ter no máximo ${LIMITS.descriptionChars} caracteres.` };
  }
  if (values.phone.length > LIMITS.clientPhone) {
    return { error: `O telefone deve ter no máximo ${LIMITS.clientPhone} caracteres.` };
  }
  if (values.email.length > LIMITS.clientEmail) {
    return { error: `O e-mail deve ter no máximo ${LIMITS.clientEmail} caracteres.` };
  }
  for (const field of ['website', 'instagram', 'facebook', 'whatsapp', 'linkedin']) {
    if (String((body && body[field]) || '').trim() && !values[field]) {
      return { error: 'Link inválido. Use http:// ou https://.' };
    }
    if (
      values[field].length > LIMITS.urlMaxChars ||
      Buffer.byteLength(values[field], 'utf8') > LIMITS.urlMaxChars
    ) {
      return { error: `O link deve ter no máximo ${LIMITS.urlMaxChars} caracteres.` };
    }
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    return { error: 'E-mail inválido.' };
  }

  return { values, error: null };
}

function getClient(db, id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

function getClientJobCount(db, id) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM requests WHERE client_id = ?').get(id).n);
}

module.exports = {
  normalizeSocialUrl,
  validateClientInput,
  getClient,
  getClientJobCount,
};
