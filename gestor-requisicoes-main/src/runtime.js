// Ajustes de ambiente aplicados antes de qualquer data ser calculada, tanto no
// app (server.js) quanto no cron (scripts/run-scheduler.js).
const path = require('node:path');

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

// Servidores de cPanel costumam rodar em UTC ou no fuso dos EUA. Sem isso, um
// agendamento das 9h sairia às 6h ou 12h de Brasília e os atrasos virariam na
// hora errada. APP_TIMEZONE (ou TZ) troca o fuso.
function applyTimezone(env = process.env) {
  if (!env.TZ) env.TZ = env.APP_TIMEZONE || DEFAULT_TIMEZONE;
  return env.TZ;
}

// Uploads dentro da pasta do app somem quando a pasta é trocada numa
// atualização. Devolve um aviso (ou null) para o log do servidor.
function uploadDirWarning(uploadDir, appRoot, env = process.env) {
  if (env.NODE_ENV !== 'production') return null;
  const relative = path.relative(path.resolve(appRoot), path.resolve(uploadDir));
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!inside) return null;
  return (
    `ATENÇÃO: UPLOAD_DIR (${uploadDir}) está dentro da pasta do app. Ao atualizar o app trocando a pasta, ` +
    'todos os anexos e fotos se perdem. Use uma pasta fora do app, ex.: /home/conta/fueljobs-data/uploads.'
  );
}

module.exports = { DEFAULT_TIMEZONE, applyTimezone, uploadDirWarning };
