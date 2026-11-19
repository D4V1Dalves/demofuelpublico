# Fuel Jobs — SPEC v6 (relatório público, coluna Aprovado, cores e favicon)

## Objetivo
1. A tela pública do link de aprovação deve mostrar um **relatório do que foi feito**, incluindo o link do Dropbox quando existir.
2. Ao aprovar, o job vai **automaticamente** para a nova coluna **Aprovado**.
3. Reorganizar as seis colunas e suas cores, e atualizar as cores dos KPIs.
4. Trocar o favicon pelo PNG enviado.

## Decisões aprovadas
- **Aprovado substitui Concluído** como coluna final. Jobs `Concluído` existentes são migrados para `Aprovado`. KPI e relatórios **mantêm o rótulo “Concluídos”**, contando os jobs `Aprovado`.
- **Admin e cliente** podem colocar um job em Aprovado. O cliente ao aprovar move na hora; o Admin pode arrastar um job que já tenha as duas aprovações (regra antiga de Concluído).
- Relatório público = **descrição + comentários + anexos + Dropbox + linha do tempo** com as datas de criação, aprovação do Admin, aprovação do cliente e rejeição.
- Favicon: copiar `www.agenciafuel.com.br-192x192.png` para `public/favicon.png`, usar como `icon` e `apple-touch-icon`. (O arquivo não foi inspecionado visualmente; será usado como enviado.)
- O **token continua válido** após a decisão: o link pode ser reaberto para ver o status, mas não permite nova aprovação/rejeição.

## 1. Coluna Aprovado

### `src/config.js`
```
STATUS = ['Novo', 'Em andamento', 'Aguardando', 'Aprovação', 'Aprovado', 'Rejeitado']
```

### Migração (`src/db.js`)
- `UPDATE requests SET status = 'Aprovado' WHERE status = 'Concluído'`.
- Preenchimento de `completed_at` passa a considerar `status = 'Aprovado'`.
- Seed usa `Aprovado` no lugar de `Concluído`.

### Regras e métricas
- `src/workflow.js`: alvo `Aprovado` exige `admin_approved_at` e `client_approved_at` (com mensagens “para aprovar”).
- `src/routes.js` (`getStats`): `abertas`/`atrasadas` com `status <> 'Aprovado'`; `concluidas` com `status = 'Aprovado'`. **`concluidas` continua no JSON.**
- `src/reports.js`: contagem de `concluidos` usa `status === 'Aprovado'`; rótulos seguem “Concluídos”.
- Arraste via `POST /requisicoes/:id/status`: `completed_at` preenchido para `Aprovado`; **token não é descartado** (decisão aprovada).
- `GET /aprovacao/:token/aprovar`: grava `client_approved_at`, `status = 'Aprovado'`, `completed_at` e mantém `approval_token`.

### Proteção contra dupla decisão
- Se o job já estiver `Aprovado` ou `Rejeitado`, `POST /aprovacao/:token/aprovar` e `/rejeitar` apenas renderizam o estado atual, sem alterar o banco.

## 2. Relatório público

### `src/routes.js`
- `approvalByToken` continua buscando o job pelo token.
- Nova consulta ao abrir/exibir o link:
  - comentários (`comments` + nome do usuário, ordenados por id);
  - anexos (`attachments` + nome do usuário, ordenados por id).
- `renderApproval` passa `job`, `comments`, `attachments`, `error`, `result`.
- `result` é **derivado do job** (`client_rejection_reason` → `rejected`; `client_approved_at` → `approved`; senão `null`), então funciona tanto no POST quanto ao reabrir o link.
- Nova rota pública `GET /aprovacao/:token/anexo/:attachmentId`: valida que o anexo pertence ao job do token e aplica a mesma checagem de `path.resolve` do download autenticado.

### `views/approval.ejs`
- Cabeçalho: cliente, título, status, prioridade, prazo, responsável e criação.
- Seção **Descrição**.
- Seção **Linha do tempo**: itens preenchidos — Criado, Aprovação do Admin, Aprovação do Cliente, Rejeição, Aprovado em.
- Seção **Comentários**: autor, data e texto (ou “Nenhum comentário”).
- Seção **Anexos**: lista com download por token; **Dropbox** em destaque quando `dropbox_url` existir.
- Rodapé: se pendente, formulários Aprovar/Rejeitar; se decidido, apenas o aviso de resultado (sem formulários).

### CSS
- `body.approval-page .login-card` alargado (≈760px) para acomodar o relatório.
- Estilos para `.report-section`, `.report-timeline`, `.timeline-item`, `.report-attachments`.

## 3. Cores

### Colunas (`public/styles.css`)
Substituir os seis `--stage-accent` atuais por:

| Coluna | Cor | HEX |
| --- | --- | --- |
| Novo | Azul | `#2563EB` |
| Em andamento | Roxo | `#7C3AED` |
| Aguardando | Cinza | `#64748B` |
| Aprovação | Laranja | `#EA580C` |
| Aprovado | Verde | `#16A34A` |
| Rejeitado | Vermelho | `#DC2626` |

### KPIs
| KPI | Cor | HEX |
| --- | --- | --- |
| Total de Jobs | Azul Ardósia | `#334155` |
| Abertos | Azul Vibrante | `#3B82F6` |
| Em Atraso | Vermelho/Coral | `#EF4444` |
| Concluídos | Verde Esmeralda | `#10B981` |

Manter `border-radius: 0` nos KPIs e os seletores `.data-status` das colunas.

## 4. Favicon
- Copiar o PNG para `public/favicon.png` (entrada no ZIP).
- `views/partials/top.ejs` `<head>`:
  - `<link rel="icon" type="image/png" href="/static/favicon.png">`
  - `<link rel="apple-touch-icon" href="/static/favicon.png">`

## Fora de escopo
- Enviar novos anexos ou comentários pelo link público.
- Notificações por e-mail.
- Troca da fonte tipográfica ou do fundo escuro.

## Tarefas (TDD)
1. **RED** — `tests/v6.test.js` (status Aprovado, migração, relatório público, download por token, dupla decisão, cores, favicon) e ajuste dos testes antigos que citam `Concluído`.
2. **GREEN** — config, db, workflow, routes, reports, views, CSS, favicon.
3. **REFACTOR** — derivação do resultado, reuso da checagem de anexo, responsividade do relatório.
4. **REVIEW** — suíte completa, smoke real, ZIP verificado por extração.
