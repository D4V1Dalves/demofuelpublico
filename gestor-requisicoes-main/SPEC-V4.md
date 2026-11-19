# Fuel Jobs — SPEC v4 (Agendamentos + Relatórios)

## Objetivo
Adicionar duas abas à plataforma sem alterar o comportamento atual:
1. **Agendamentos** — regras que geram jobs automaticamente a partir de um modelo, com periodicidade e horário.
2. **Relatórios** — gráfico de pizza, gráfico de barras e tabela-resumo, filtráveis por dia/semana/mês/ano e intervalo "de até".

## Decisões aprovadas
- Periodicidade: **dia, semana ou mês**, com N > 0 e horário `HH:MM`.
- Servidor desligado na hora: **gera apenas a próxima ocorrência** a partir de agora (sem "catch-up" em lote).
- Segundo gráfico: **barras + tabela-resumo** numérica.
- Pizza: **Abertos / Concluídos / Rejeitados**. Barras: **criados vs concluídos** por período.
- Acesso: **Agendamentos só Admin**; **Relatórios para qualquer usuário logado**.
- Horário = **hora local do servidor**; documentado no README.

## 1. Agendamentos

### Schema (migração)
Nova tabela `recurring_rules`:
`id, name, client_id, title, description, priority, responsible_id, due_days, dropbox_url, interval_value, interval_unit ('dia'|'semana'|'mes'), start_time ('HH:MM'), active, next_run_at, last_run_at, created_by, created_at, updated_at`.

Nova coluna em `requests`: `generated_by_rule_id` (nullable, FK lógica para a regra).

### Regras de geração
- O job gerado usa o modelo da regra, `status = 'Novo'`, `created_by = created_by da regra`, `due_date = hoje + due_days` (0 → sem prazo).
- `start_time` define a **primeira** execução: próxima ocorrência daquele horário estritamente depois de agora. As seguintes somam `N` unidades a partir dela.
- Após gerar: `last_run_at = agora`, `next_run_at = próxima ocorrência calculada a partir de agora`.
- Tudo em transação; regras inativas são ignoradas.

### Scheduler
- `src/scheduler.js`: `computeNextRun(rule, now)`, `runDueRules(db, now)` e `startScheduler(db, intervalMs)`.
- `startScheduler` roda uma vez ao iniciar e depois a cada 60 s; timer com `unref()`.
- `server.js` chama `startScheduler` após `listen`. Testes chamam `runDueRules(db, now)` diretamente (sem timer).

### Rotas (todas `/agendamentos`)
- `GET /agendamentos` (Admin) — lista com cliente, próxima execução, status e total gerado.
- `GET /agendamentos/nova` e `POST /agendamentos` (Admin).
- `GET /agendamentos/:id/editar` e `POST /agendamentos/:id/editar` (Admin).
- `POST /agendamentos/:id/alternar` — ativa/pausa.
- `POST /agendamentos/:id/executar` — dispara uma geração imediata (útil para teste).
- `POST /agendamentos/:id/excluir` — remove a regra (jobs já gerados permanecem).

Validação: nome/título obrigatórios, cliente e responsável válidos, prioridade válida, `interval_value` 1..365, unidade enumerada, `start_time` `HH:MM` válido, `due_days` 0..365, Dropbox http/https.

## 2. Relatórios

### Schema
Nova coluna `completed_at TEXT` em `requests`, preenchida quando o status muda para **Concluído** e limpa quando uma edição invalida aprovações. Seed concluído recebe timestamp.

### Métricas
- **Coorte**: jobs com `created_at` dentro do intervalo selecionado (e cliente opcional).
- **Pizza**: Abertos (`status NOT IN ('Concluído','Rejeitado')`), Concluídos, Rejeitados.
- **Barras**: por bucket de período, `Criados` (created_at) vs `Concluídos` (completed_at).
- **Tabela**: bucket, criados, concluídos, abertos, rejeitados, total, taxa de conclusão.
- Buckets: `dia` (YYYY-MM-DD), `semana` (semana ISO), `mês` (MM/YYYY), `ano` (YYYY). Máximo de 24 buckets exibidos, com aviso.

### Filtros
`GET /relatorios?granularidade=mes&de=YYYY-MM-DD&ate=YYYY-MM-DD&cliente=ID`
- Presets: Hoje, 7 dias, 30 dias, Mês atual, Ano atual; intervalo manual "de/até".
- Validação: datas ISO, `ate >= de`, granularidade enumerada.

### Gráficos
SVG de pizza gerado no servidor (arcos calculados em `src/reports.js`); barras em CSS puro com alturas proporcionais; tabela semântica. **Sem biblioteca externa/CDN** — mantém o app offline e o estilo Fuel.

### Rota e view
- `GET /relatorios` (`requireAuth`) → `views/reports.ejs`.
- Nav: `Relatórios` para todos; `Agendamentos` apenas Admin.

## Fora de escopo
- E-mails/notificações, edição em massa, exclusão de jobs, metas por cliente.
- Nenhuma chave de API ou dependência nova.

## Tarefas (TDD)
1. **RED** — `tests/scheduler.test.js`, `tests/recurring.test.js`, `tests/reports.test.js`: falham por funções/rotas/campos inexistentes.
2. **GREEN** — migrações, `scheduler.js`, `reports.js`, rotas, views, nav e estilos.
3. **REFACTOR** — validações centralizadas, transações, responsividade, acessibilidade dos gráficos (labels/ARIA).
4. **REVIEW** — 100% da suíte, smoke com geração real, ZIP final verificado por extração.
