// Datas exibidas na interface sempre no formato brasileiro.
// O banco guarda texto ISO ("2026-11-22" ou "2026-11-19 08:08:58").

function parts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || ''));
  if (!match) return null;
  const [, year, month, day, hours, minutes] = match;
  return { year, month, day, hours, minutes };
}

// "2026-11-22" → "22/11/2026"
function fmtDate(value, empty = '—') {
  if (!value) return empty;
  const p = parts(value);
  return p ? `${p.day}/${p.month}/${p.year}` : String(value);
}

// "2026-11-19 08:08:58" → "19/11/2026 às 08:08"
function fmtDateTime(value, empty = '—') {
  if (!value) return empty;
  const p = parts(value);
  if (!p) return String(value);
  return p.hours ? `${p.day}/${p.month}/${p.year} às ${p.hours}:${p.minutes}` : `${p.day}/${p.month}/${p.year}`;
}

// "2026-11-22" → "22/11" (tabelas e cards, onde o ano é óbvio)
function fmtDayMonth(value, empty = '—') {
  if (!value) return empty;
  const p = parts(value);
  return p ? `${p.day}/${p.month}` : String(value);
}

module.exports = { parts, fmtDate, fmtDateTime, fmtDayMonth };
