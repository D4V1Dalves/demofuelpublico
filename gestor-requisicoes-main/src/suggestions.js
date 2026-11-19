const STOPWORDS = new Set([
  'para', 'com', 'que', 'uma', 'dos', 'das', 'nos', 'nas', 'por', 'como', 'mais', 'mas',
  'pelo', 'pela', 'seu', 'sua', 'seus', 'suas', 'este', 'esta', 'esse', 'essa', 'from',
  'with', 'that', 'this', 'the', 'and', 'for', 'has', 'have', 'was', 'were', 'will',
]);

function tokenize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function vectorize(tokens, idf) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);

  const vector = new Map();
  for (const [token, count] of counts) vector.set(token, (1 + Math.log(count)) * idf(token));
  return vector;
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, weight] of a) {
    dot += weight * (b.get(term) || 0);
    normA += weight * weight;
  }
  for (const weight of b.values()) normB += weight * weight;
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function pickSnippet(currentTokens, job) {
  const candidates = [...(job.comments || []), job.description, job.title]
    .flatMap((text) =>
      String(text || '')
        .split(/[.!?]\s+|\n+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 12),
    );

  let best = String(job.title || '').trim();
  let bestScore = -1;
  for (const sentence of candidates) {
    const score = tokenize(sentence).reduce((sum, token) => sum + (currentTokens.has(token) ? 1 : 0), 0);
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  return best.length > 240 ? `${best.slice(0, 237)}...` : best;
}

function localSuggestions(current, jobs, limit = 3) {
  const documents = jobs.map((job) => ({
    job,
    tokens: tokenize([job.title, job.description, ...(job.comments || [])].join(' ')),
  }));

  const documentFrequency = new Map();
  for (const doc of documents) {
    for (const term of new Set(doc.tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }
  const total = documents.length || 1;
  const idf = (term) => Math.log((total + 1) / ((documentFrequency.get(term) || 0) + 1)) + 1;

  const currentTokens = tokenize(
    [current.title, current.description, ...(current.comments || [])].join(' '),
  );
  const currentVector = vectorize(currentTokens, idf);
  const currentSet = new Set(currentTokens);

  return documents
    .filter((doc) => String(doc.job.id) !== String(current.id))
    .map((doc) => ({ job: doc.job, score: cosine(currentVector, vectorize(doc.tokens, idf)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({
      jobId: item.job.id,
      jobTitle: item.job.title,
      text: pickSnippet(currentSet, item.job),
      score: Number(item.score.toFixed(4)),
    }));
}

// Limites do material usado para sugerir: os jobs mais recentes, com textos
// cortados. Mantém a consulta pequena mesmo com milhares de jobs e comentários
// longos (no MySQL a resposta inteira passa por um buffer de tamanho fixo).
const CORPUS_MAX_JOBS = 300;
const CORPUS_MAX_COMMENTS = 20;
const CORPUS_TEXT_CHARS = 2000;

function buildCorpus(db, { includeId = null } = {}) {
  const clip = (text) => (text ? String(text).slice(0, CORPUS_TEXT_CHARS) : text);
  const jobs = db
    .prepare(
      `SELECT id, title, SUBSTR(description, 1, ${CORPUS_TEXT_CHARS}) AS description
       FROM requests ORDER BY id DESC LIMIT ${CORPUS_MAX_JOBS}`,
    )
    .all()
    .map((row) => ({ id: row.id, title: row.title, description: clip(row.description), comments: [] }));
  if (includeId && !jobs.some((job) => job.id === Number(includeId))) {
    const current = db
      .prepare(`SELECT id, title, SUBSTR(description, 1, ${CORPUS_TEXT_CHARS}) AS description FROM requests WHERE id = ?`)
      .get(includeId);
    if (current) jobs.push({ id: current.id, title: current.title, description: clip(current.description), comments: [] });
  }
  if (jobs.length === 0) return [];

  const byId = new Map(jobs.map((job) => [job.id, job]));
  const ids = [...byId.keys()];
  // Comentários sem repetir a descrição em cada linha; os mais recentes primeiro.
  const comments = db
    .prepare(
      `SELECT request_id, SUBSTR(body, 1, ${CORPUS_TEXT_CHARS}) AS body FROM comments
       WHERE request_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id DESC`,
    )
    .all(...ids);
  for (const row of comments) {
    const job = byId.get(row.request_id);
    if (job && job.comments.length < CORPUS_MAX_COMMENTS) job.comments.push(row.body);
  }
  for (const job of jobs) job.comments.reverse();
  return jobs.sort((a, b) => a.id - b.id);
}

module.exports = { localSuggestions, buildCorpus };
