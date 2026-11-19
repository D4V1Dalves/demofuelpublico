const APP_NAME = 'Fuel Jobs';
const STATUS = ['Novo', 'Em andamento', 'Em processo', 'Aprovação', 'Aprovado', 'Rejeitado'];
const PRIORITY = ['Baixa', 'Média', 'Alta', 'Urgente'];
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;
const AVATAR_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AVATAR_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// Limites alinhados às colunas VARCHAR do schema MySQL. No SQLite qualquer
// tamanho passaria; sem estas validações o MySQL em strict mode devolve 500.
const LIMITS = {
  userName: 120,
  userEmail: 190,
  clientName: 160,
  clientInlineName: 120,
  clientPhone: 40,
  clientEmail: 190,
  requestTitle: 255,
  ruleName: 160,
  ruleTitle: 255,
  attachmentName: 255,
  // Campos TEXT: limite de caracteres na UI + bytes no MySQL (TEXT = 65.535).
  descriptionChars: 20000,
  commentChars: 20000,
  rejectionReasonChars: 2000,
  textBytes: 60000,
  urlMaxChars: 2048,
};

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

const ALLOWED_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.docx', '.xlsx', '.txt']);

// Formatos que o navegador consegue exibir com segurança dentro da plataforma.
// DOCX/XLSX continuam disponíveis apenas para download.
const PREVIEW_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);

module.exports = {
  APP_NAME,
  STATUS,
  PRIORITY,
  SESSION_MS,
  MAX_UPLOAD_BYTES,
  MAX_AVATAR_BYTES,
  AVATAR_MIME,
  AVATAR_EXT,
  LIMITS,
  ALLOWED_MIME,
  ALLOWED_EXT,
  PREVIEW_MIME,
};
