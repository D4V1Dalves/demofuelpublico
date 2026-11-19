const { formatLocalDate } = require('./scheduler-core');

const GRANULARIDADES = ['dia', 'semana', 'mes', 'ano'];
// 31 cobre o preset de 30 dias por dia (inclusive hoje) sem cortes.
const MAX_BUCKETS = 31;
const PIE_COLORS = {
  abertos: '#e11d2a',
  concluidos: '#f5f3ef',
  rejeitados: '#5c5c63',
};

const pad = (value) => String(value).padStart(2, '0');

function parseDate(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`Data ${label} inválida. Use AAAA-MM-DD.`);
  }
  const date = new Date(`${text}T00:00:00`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(text.slice(0, 4)) ||
    date.getMonth() + 1 !== Number(text.slice(5, 7)) ||
    date.getDate() !== Number(text.slice(8, 10))
  ) {
    throw new Error(`Data ${label} inválida.`);
  }
  return text;
}

function normalizeFilters(input = {}) {
  const granularidade = GRANULARIDADES.includes(input.granularidade) ? input.granularidade : 'mes';
  const now = input.now instanceof Date ? input.now : new Date();
  const de = parseDate(input.de || formatLocalDate(new Date(now.getFullYear(), now.getMonth(), 1)), 'inicial');
  const ate = parseDate(input.ate || formatLocalDate(now), 'final');

  if (de > ate) throw new Error('Intervalo inválido: a data inicial deve ser menor ou igual à final.');

  const clienteRaw = Number(input.cliente);
  const cliente = Number.isInteger(clienteRaw) && clienteRaw > 0 ? clienteRaw : null;
  return { granularidade, de, ate, cliente };
}

function defaultRange(now = new Date()) {
  return {
    granularidade: 'mes',
    de: formatLocalDate(new Date(now.getFullYear(), now.getMonth(), 1)),
    ate: formatLocalDate(now),
    cliente: null,
  };
}

function presetRange(preset, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (days) => formatLocalDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
  const ate = formatLocalDate(today);
  switch (preset) {
    case 'hoje':
      return { granularidade: 'dia', de: ate, ate };
    case '7dias':
      return { granularidade: 'dia', de: shift(-6), ate };
    case '30dias':
      return { granularidade: 'dia', de: shift(-29), ate };
    case 'mes':
      return { granularidade: 'mes', de: formatLocalDate(new Date(today.getFullYear(), today.getMonth(), 1)), ate };
    case 'ano':
      return { granularidade: 'ano', de: `${today.getFullYear()}-01-01`, ate };
    default:
      return defaultRange(now);
  }
}

function isoWeek(date) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: utc.getUTCFullYear(), week: String(week).padStart(2, '0') };
}

function bucketFor(dateText, granularidade) {
  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(5, 7));
  const day = Number(dateText.slice(8, 10));
  if (granularidade === 'dia') {
    return { key: `${year}-${pad(month)}-${pad(day)}`, label: `${pad(day)}/${pad(month)}/${year}` };
  }
  if (granularidade === 'ano') return { key: String(year), label: String(year) };
  if (granularidade === 'mes') return { key: `${year}-${pad(month)}`, label: `${pad(month)}/${year}` };
  const week = isoWeek(new Date(year, month - 1, day));
  return { key: `${week.year}-W${week.week}`, label: `Semana ${week.week}/${week.year}` };
}

function polar(cx, cy, radius, angle) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: Number((cx + radius * Math.cos(radians)).toFixed(2)),
    y: Number((cy + radius * Math.sin(radians)).toFixed(2)),
  };
}

function slicePath(cx, cy, radius, start, end) {
  if (end - start >= 359.99) {
    const first = polar(cx, cy, radius, start);
    const half = polar(cx, cy, radius, start + 180);
    return `M ${first.x} ${first.y} A ${radius} ${radius} 0 1 1 ${half.x} ${half.y} A ${radius} ${radius} 0 1 1 ${first.x} ${first.y} Z`;
  }
  if (end - start <= 0.01) return `M ${cx} ${cy} Z`;
  const from = polar(cx, cy, radius, start);
  const to = polar(cx, cy, radius, end);
  const large = end - start > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${from.x} ${from.y} A ${radius} ${radius} 0 ${large} 1 ${to.x} ${to.y} Z`;
}

function buildPie(totals) {
  const definitions = [
    { key: 'abertos', label: 'Abertos' },
    { key: 'concluidos', label: 'Concluídos' },
    { key: 'rejeitados', label: 'Rejeitados' },
  ];
  const cx = 90;
  const cy = 90;
  const radius = 68;
  let angle = 0;

  return definitions.map((definition) => {
    const value = totals[definition.key] || 0;
    const sweep = totals.total > 0 ? (value / totals.total) * 360 : 0;
    const start = angle;
    const end = angle + sweep;
    angle = end;
    return {
      ...definition,
      value,
      percent: totals.total > 0 ? Math.round((value / totals.total) * 100) : 0,
      color: PIE_COLORS[definition.key],
      path: slicePath(cx, cy, radius, start, end),
    };
  });
}

function buildReport(db, input = {}) {
  const filters = normalizeFilters(input);
  const params = [filters.de, filters.ate];
  const clientFilter = filters.cliente ? ' AND client_id = ?' : '';
  if (filters.cliente) params.push(filters.cliente);

  const cohort = db
    .prepare(`SELECT id, status, created_at FROM requests WHERE date(created_at) BETWEEN ? AND ?${clientFilter}`)
    .all(...params);
  const completed = db
    .prepare(
      `SELECT id, status, completed_at FROM requests WHERE status = 'Aprovado' AND completed_at IS NOT NULL
       AND date(completed_at) BETWEEN ? AND ?${clientFilter}`,
    )
    .all(...params);

  const totals = { total: cohort.length, abertos: 0, concluidos: 0, rejeitados: 0 };
  for (const job of cohort) {
    if (job.status === 'Aprovado') totals.concluidos += 1;
    else if (job.status === 'Rejeitado') totals.rejeitados += 1;
    else totals.abertos += 1;
  }

  const byKey = new Map();
  const bucket = (job, dateField) => {
    const info = bucketFor(String(job[dateField]).slice(0, 10), filters.granularidade);
    if (!byKey.has(info.key)) {
      byKey.set(info.key, { key: info.key, label: info.label, criados: 0, concluidos: 0, abertos: 0, rejeitados: 0 });
    }
    return byKey.get(info.key);
  };

  for (const job of cohort) {
    const row = bucket(job, 'created_at');
    row.criados += 1;
    if (job.status === 'Rejeitado') row.rejeitados += 1;
    else if (job.status !== 'Aprovado') row.abertos += 1;
  }
  for (const job of completed) {
    bucket(job, 'completed_at').concluidos += 1;
  }

  let buckets = [...byKey.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((row) => ({
      ...row,
      total: row.criados,
      taxa:
        row.criados > 0
          ? Math.min(100, Math.round((row.concluidos / row.criados) * 100))
          : null,
    }));
  const truncated = buckets.length > MAX_BUCKETS;
  // Ao cortar, mantém os períodos mais recentes, que são os mais relevantes.
  if (truncated) buckets = buckets.slice(-MAX_BUCKETS);
  const maxValue = buckets.reduce(
    (max, row) => Math.max(max, row.criados, row.concluidos),
    0,
  );

  return {
    filters,
    totals,
    pie: buildPie(totals),
    buckets,
    truncated,
    maxValue,
  };
}

module.exports = {
  buildReport,
  defaultRange,
  presetRange,
  normalizeFilters,
  GRANULARIDADES,
  MAX_BUCKETS,
};
