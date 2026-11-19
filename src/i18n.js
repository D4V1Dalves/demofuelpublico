// Textos da página pública de aprovação em português e inglês.
// Só a interface é traduzida: título, descrição, comentários, nomes e o
// motivo da rejeição aparecem como foram escritos.

const APPROVAL_LANGS = ['pt', 'en'];

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STRINGS = {
  pt: {
    htmlLang: 'pt-BR',
    pageTitle: 'Aprovação de job',
    topbarTag: 'Link de aprovação',
    regionLabel: 'Detalhes do job para aprovação',
    factsLabel: 'Informações do job',
    stage: 'Etapa',
    priority: 'Prioridade',
    dueDate: 'Prazo',
    responsible: 'Responsável',
    noResponsible: 'Sem responsável',
    createdAt: 'Criado em',
    report: 'Relatório do que foi feito',
    attachments: 'Anexos',
    files: (n) => `${n} ${n === 1 ? 'arquivo' : 'arquivos'}`,
    openDropbox: 'Abrir pasta no Dropbox',
    enlarge: (name) => `Ampliar ${name}`,
    attachmentAlt: (name) => `Anexo: ${name}`,
    previewOf: (name) => `Pré-visualização de ${name}`,
    by: 'por',
    bytes: 'bytes',
    noPreview: 'visualização não disponível',
    noAttachments: 'Nenhum anexo ainda.',
    comments: 'Comentários',
    noComments: 'Nenhum comentário ainda.',
    editedAt: 'editado em',
    timeline: 'Linha do tempo',
    tlCreated: 'Job criado',
    tlAdminApproved: 'Aprovação do Admin',
    tlClientApproved: 'Aprovação do Cliente',
    tlClientRejected: 'Rejeição pelo cliente',
    tlCompleted: 'Aprovado e finalizado',
    yourDecision: 'Sua decisão',
    titleApproved: 'Job aprovado',
    titleRejected: 'Job rejeitado',
    titleIdle: 'Sem decisão pendente',
    titleAsk: 'Aprovar este job?',
    resultApproved: 'Job aprovado pelo cliente. Obrigado! A equipe foi avisada.',
    resultRejected: 'Job rejeitado. A equipe foi avisada e vai revisar os ajustes.',
    resultIdle: 'Este job não está aguardando aprovação neste momento.',
    currentStage: 'Etapa atual',
    reviewHint: 'Revise o relatório, os anexos e os comentários da equipe antes de responder.',
    approve: 'Aprovar job',
    confirmTitle: 'Confirmar aprovação?',
    confirmHint: 'O job será concluído e a equipe será avisada.',
    confirmApprove: 'Sim, aprovar job',
    approving: 'Aprovando…',
    cancel: 'Cancelar',
    or: 'ou',
    reject: 'Rejeitar job',
    rejectReason: 'Qual o motivo da rejeição?',
    rejectPlaceholder: 'Explique o que precisa ser ajustado.',
    confirmReject: 'Confirmar rejeição',
    errInvalidLink: 'Link de aprovação inválido.',
    errNotFound: 'Anexo não encontrado.',
    errNotPending: 'Este job não está aguardando aprovação.',
    errReasonRequired: 'Informe o motivo da rejeição.',
    errReasonTooLong: (max) => `O motivo deve ter no máximo ${max} caracteres.`,
    themeDark: 'Tema escuro',
    themeLight: 'Tema claro',
    dialogConfirmTitle: 'Confirmar ação',
    dialogConfirm: 'Confirmar',
    previewKicker: 'Anexo',
    previewTitle: 'Visualizar arquivo',
    previewClose: 'Fechar visualização',
    status: {},
    priorityLabel: {},
  },
  en: {
    htmlLang: 'en',
    pageTitle: 'Job approval',
    topbarTag: 'Approval link',
    regionLabel: 'Job details for approval',
    factsLabel: 'Job information',
    stage: 'Stage',
    priority: 'Priority',
    dueDate: 'Due date',
    responsible: 'Owner',
    noResponsible: 'Unassigned',
    createdAt: 'Created on',
    report: 'Report of the work done',
    attachments: 'Attachments',
    files: (n) => `${n} ${n === 1 ? 'file' : 'files'}`,
    openDropbox: 'Open Dropbox folder',
    enlarge: (name) => `Enlarge ${name}`,
    attachmentAlt: (name) => `Attachment: ${name}`,
    previewOf: (name) => `Preview of ${name}`,
    by: 'by',
    bytes: 'bytes',
    noPreview: 'preview not available',
    noAttachments: 'No attachments yet.',
    comments: 'Comments',
    noComments: 'No comments yet.',
    editedAt: 'edited on',
    timeline: 'Timeline',
    tlCreated: 'Job created',
    tlAdminApproved: 'Approved by the team',
    tlClientApproved: 'Approved by the client',
    tlClientRejected: 'Rejected by the client',
    tlCompleted: 'Approved and completed',
    yourDecision: 'Your decision',
    titleApproved: 'Job approved',
    titleRejected: 'Job rejected',
    titleIdle: 'No pending decision',
    titleAsk: 'Approve this job?',
    resultApproved: 'Job approved. Thank you! The team has been notified.',
    resultRejected: 'Job rejected. The team has been notified and will review the changes.',
    resultIdle: 'This job is not awaiting approval right now.',
    currentStage: 'Current stage',
    reviewHint: "Review the team's report, attachments and comments before you respond.",
    approve: 'Approve job',
    confirmTitle: 'Confirm approval?',
    confirmHint: 'The job will be completed and the team will be notified.',
    confirmApprove: 'Yes, approve job',
    approving: 'Approving…',
    cancel: 'Cancel',
    or: 'or',
    reject: 'Reject job',
    rejectReason: 'Why are you rejecting it?',
    rejectPlaceholder: 'Explain what needs to change.',
    confirmReject: 'Confirm rejection',
    errInvalidLink: 'Invalid approval link.',
    errNotFound: 'Attachment not found.',
    errNotPending: 'This job is not awaiting approval.',
    errReasonRequired: 'Please tell us why you are rejecting it.',
    errReasonTooLong: (max) => `The reason must be at most ${max} characters.`,
    themeDark: 'Dark theme',
    themeLight: 'Light theme',
    dialogConfirmTitle: 'Confirm action',
    dialogConfirm: 'Confirm',
    previewKicker: 'Attachment',
    previewTitle: 'View file',
    previewClose: 'Close preview',
    status: {
      Novo: 'New',
      'Em andamento': 'In progress',
      'Em processo': 'In review',
      'Aprovação': 'Awaiting approval',
      Aprovado: 'Approved',
      Rejeitado: 'Rejected',
    },
    priorityLabel: {
      Baixa: 'Low',
      'Média': 'Medium',
      Alta: 'High',
      Urgente: 'Urgent',
    },
  },
};

function approvalLang(value) {
  return APPROVAL_LANGS.includes(value) ? value : 'pt';
}

// Pedido feito pela página pública em inglês (inclui as respostas de erro).
function isEnglishApproval(req) {
  return String(req.path || '').startsWith('/aprovacao/') && req.query && req.query.lang === 'en';
}

const ERROR_MESSAGES = {
  pt: {
    origin: 'Origem não permitida.',
    tooLarge: 'Requisição muito grande.',
    internal: 'Erro interno. Tente novamente.',
    invalid: 'Requisição inválida.',
    noPreview: 'Este tipo de arquivo não pode ser visualizado aqui.',
  },
  en: {
    origin: 'Request origin not allowed.',
    tooLarge: 'Request too large.',
    internal: 'Something went wrong. Please try again.',
    invalid: 'Invalid request.',
    noPreview: 'This file type cannot be previewed here.',
  },
};

function errorMessages(req) {
  return isEnglishApproval(req) ? ERROR_MESSAGES.en : ERROR_MESSAGES.pt;
}

const format = require('./format');

// Interface da página de aprovação no idioma escolhido.
function approvalStrings(lang) {
  const code = approvalLang(lang);
  const t = STRINGS[code];
  // Português usa os formatadores do app inteiro; inglês só muda a apresentação.
  const fmtDate =
    code === 'en'
      ? (value, empty = '—') => {
          if (!value) return empty;
          const p = format.parts(value);
          return p ? `${MONTHS_EN[Number(p.month) - 1]} ${Number(p.day)}, ${p.year}` : String(value);
        }
      : format.fmtDate;
  const fmtDateTime =
    code === 'en'
      ? (value, empty = '—') => {
          if (!value) return empty;
          const p = format.parts(value);
          if (!p) return String(value);
          return p.hours ? `${fmtDate(value)} at ${p.hours}:${p.minutes}` : fmtDate(value);
        }
      : format.fmtDateTime;
  return {
    ...t,
    lang: code,
    statusName: (status) => t.status[status] || status,
    priorityName: (priority) => t.priorityLabel[priority] || priority,
    fmtDate,
    fmtDateTime,
  };
}

module.exports = { APPROVAL_LANGS, approvalLang, approvalStrings, isEnglishApproval, errorMessages };
