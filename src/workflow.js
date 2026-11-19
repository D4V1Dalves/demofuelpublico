const { STATUS } = require('./config');

function validateStatusChange(row, target) {
  if (!STATUS.includes(target)) return { error: 'Status inválido.' };

  if (target === 'Rejeitado') {
    return { error: 'Somente o cliente pode colocar um job em Rejeitado.' };
  }

  if (target === 'Aprovação' && row.status !== 'Aprovação' && row.status !== 'Em processo') {
    return { error: 'Só é possível enviar para aprovação um job que está em Em processo.' };
  }

  if (target === 'Aprovado') {
    if (!row.admin_approved_at) return { error: 'É necessária a aprovação do Admin para aprovar.' };
    if (!row.client_approved_at) return { error: 'É necessária a aprovação do cliente para aprovar.' };
  }

  return { error: null };
}

function hasApproval(row) {
  return Boolean(row.admin_approved_at || row.client_approved_at);
}

const CLEAR_APPROVALS_SQL = `
  UPDATE requests SET admin_approved_at = NULL, client_approved_at = NULL,
    client_rejected_at = NULL, client_rejection_reason = NULL, approval_token = NULL,
    completed_at = NULL
  WHERE id = ?
`;

module.exports = { validateStatusChange, hasApproval, CLEAR_APPROVALS_SQL };
