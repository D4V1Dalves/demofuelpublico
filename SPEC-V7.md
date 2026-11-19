# Fuel Jobs — SPEC v7 (workspace Monday-inspired, login e papéis)

## Objetivo

Redesenhar a interface no estilo de um board de trabalho (Monday-inspired, sem clonar marca/assets) e entregar login único com papéis reais **admin** e **usuário**.

O escopo foi dividido em duas fases:

- **Fase A (entregue):** shell com sidebar, login, board (Main table + Kanban + drawer do item), Meu trabalho e rotas de apoio.
- **Fase B (entregue):** tema escuro alternável, acento vermelho, clientes na sidebar, Criar JOB com cliente inline, automação de etapas, timer por job e retenção automática de anexos.

## Decisões aprovadas

- **Linguagem visual própria**, inspirada no Monday: sidebar escura, canvas claro (`#f6f7fb`) no tema claro, acento vermelho (`#fa0002`), fontes self-hosted Bricolage Grotesque (display) e Instrument Sans (corpo). Nenhum asset/logo do Monday é usado.
- **Tema escuro por padrão + toggle.** A preferência fica em `localStorage['fuel-theme']`, é aplicada antes do primeiro paint via script inline no `<head>` e pode ser revertida para o claro. Nas telas públicas o toggle aparece flutuante.
- **Automação de etapas sem migração:** `Novo` → `Em andamento` (início do timer) → `Aguardando` (conclusão do timer) → `Aprovação` (Admin aprova e gera o link) → `Aprovado`/`Rejeitado` (cliente).
- **Timer persistido no servidor** na tabela `time_entries`, por job e por pessoa, com iniciar/pausar/retomar/concluir. Controlam o timer o Admin, o responsável ou qualquer usuário quando o job não tem responsável.
- **Retenção de anexos de 30 dias** (`ATTACHMENT_RETENTION_DAYS`), executada no boot e a cada 24h. Apenas arquivo + registro são apagados; o job é preservado.
- **Cliente inline:** o nome digitado no formulário de job cria o cliente (ou reutiliza um com o mesmo nome, sem diferenciar maiúsculas) e ele passa a aparecer na sidebar.
- **Não há dois logins.** A tela tem abas **Admin / Usuário** apenas como referência visual do que cada papel faz; o papel real vem do usuário autenticado no banco.
- **Visão padrão = Main table**, com toggle para **Kanban**. A preferência fica em `localStorage`. O arraste continua trocando o status, e só existe no Kanban.
- **Rotas protegidas no servidor.** Esconder um link na interface não substitui o `requireAdmin`/`requireAuth`.
- **Coluna de checkbox removida** da tabela: 8 colunas (Item, Cliente, Responsável, Status, Prioridade, Prazo, Coment., Anexos).
- **Pílulas de status** usam a cor brilhante da etapa como dot/barra do grupo e um fundo escurecido com texto branco para garantir contraste AA.
- **Sem git** na máquina: o backup pré-redesign existe em `..\gestor-requisicoes.backup-pre-monday`.

## Fase A — entregue

### 1. Shell (`views/partials/top.ejs` / `bottom.ejs`)

- Sidebar com marca, navegação por papel e cartão do usuário (nome, papel, Sair).
- Nav do usuário: Dashboard, Meu trabalho, Clientes, Relatórios.
- Nav do admin: os mesmos itens + seção **Administração** com Agendamentos e Usuários.
- Estado ativo por rota (`res.locals.path`) e por modo (`res.locals.query.mine`), com `aria-current="page"`.
- Barra do workspace com busca global (`q`) e ações da tela.
- Em viewport pequeno, a sidebar vira menu deslizante (botão de menu + backdrop).

### 2. Login (`views/login.ejs`)

- Split screen: painel de marca à esquerda, formulário à direita.
- Um único `<form action="/login">` (e-mail + senha + CSRF/Origin já existentes).
- Abas Admin/Usuário com `aria-selected`; ao trocar, atualizam apenas o texto explicativo do papel.

### 3. Board (`views/dashboard.ejs`)

- Cabeçalho do board com título, subtítulo, KPIs e filtros.
- **Main table** agrupada por status em `<tbody class="group">` com:
  - linha de grupo `button.group-inner` (`aria-expanded`, `aria-controls`), cor da etapa na barra esquerda, nome e contagem;
  - linha de item com nome clicável, cliente, responsável (avatar + nome), pílula de status, prioridade, prazo, contagem de comentários e de anexos.
  - botão global **+ Novo item** no cabeçalho (somente Admin). O antigo link "+ Adicionar item" por grupo foi removido na v7.1.
- **Kanban** mantém `#board`, `.column[data-status]`, `.req-card.draggable`, `.count` e `.kpis .kpi-number`.
- Estado vazio quando não há jobs no filtro.
- Container do drawer no fim da página.

### 4. Drawer do item

- Clique no nome do item faz `fetch('/requisicoes/:id/drawer')`, interpreta o HTML com `DOMParser` e injeta o partial no drawer.
- `Ctrl`/`Cmd`/`Shift`/`Alt` + clique abre o item completo em nova aba.
- Fechamento por botão, `Esc` e clique no backdrop; foco devolvido ao gatilho.
- Fechado = `visibility: hidden` (não focável).
- Skeleton de carregamento.

### 5. Meu trabalho

- `GET /dashboard?mine=1` filtra por `responsible_id = req.user.id`.
- Título e subtítulo mudam para **Meu trabalho**.
- KPIs também são escopados (`getStats(db, req.user.id)`).
- Filtros e busca preservam `mine=1`; o link **Limpar** volta para `/dashboard?mine=1`.
- Link na sidebar para ambos os papéis.

### 6. Rotas novas/alteradas (`src/routes.js`, `src/app.js`)

| Rota | Acesso | Comportamento |
| --- | --- | --- |
| `GET /requisicoes/:id/drawer` | autenticado | Partial do drawer com job, últimas 5 comentários e anexos; 404 se não existir. |
| `GET /requisicoes/nova?status=` | admin | Pré-seleciona o status quando o valor é válido. |
| `GET /dashboard?mine=1` | autenticado | Escopa jobs e KPIs pelo responsável logado. |

- `app.locals.path`, `app.locals.query` e `app.locals.initials` disponíveis em todas as views.
- `getRequests` aceita `responsible_id`; `getStats` aceita um responsável opcional.

### 7. Design system (`public/styles.css`)

Tokens principais:

| Token | Valor | Uso |
| --- | --- | --- |
| `--sidebar` | `#1f2430` | fundo da sidebar |
| `--canvas` | `#f6f7fb` | fundo do workspace |
| `--surface` | `#ffffff` | cards/tabela/drawer |
| `--surface-2` | `#f7f8fb` | cabeçalho de grupo, chips |
| `--accent` | `#0073ea` | links/ações primárias |
| `--ink` | `#323338` | texto principal |
| `--muted` | `#676879` | texto secundário |
| `--muted-soft` | `#6c7080` | texto terciário (AA ≥ 4.5:1) |
| `--line` / `--hairline` | `#e1e4ec` / `#eceef4` | bordas |
| `--st-novo` | `#579bfc` | etapa Novo |
| `--st-andamento` | `#a25ddc` | etapa Em andamento |
| `--st-aguardando` | `#8b93a6` | etapa Aguardando |
| `--st-aprovacao` | `#fdab3d` | etapa Aprovação |
| `--st-aprovado` | `#00c875` | etapa Aprovado |
| `--st-rejeitado` | `#fa0002` | etapa Rejeitado |

Componentes: shell (`app-shell`, `sidebar`, `bar`), board (`board-head`, `kpis`, `table-shell`, `group`, `item-row`, `status-pill`), Kanban (`board`, `column`, `req-card`), drawer (`item-drawer`, `drawer-*`), login (`auth-*`) e utilitários (`badge`, `priority-pill`, `avatar`, `sr-only`). O componente `add-row` foi removido na v7.1.

### 8. Acessibilidade

- Grupos recolhíveis são `<button>` reais com `aria-expanded`/`aria-controls`.
- Tabela com `<caption class="sr-only">` e `scope="col"` nos cabeçalhos.
- Contraste AA validado nos pares de texto/fundo (pílulas, prioridade, sidebar, links).
- `prefers-reduced-motion` desliga animações.
- Drawer fechado não recebe foco; `Esc` fecha.
- Toggle de visão usa `aria-pressed`.

## Evidências da Fase A

- `npm test`: **158/158** passando (146 de baseline + 12 novos em `tests/shell.test.js`).
- Smoke HTTP real (servidor isolado em `PORT=3123`, DB em `%TEMP%\fuel-smoke`): **37/37** checks, incluindo:
  - login admin e usuário, redirecionamento de anônimo;
  - shell, tabela, toggle, pílulas, preselect e drawer partial;
  - todas as telas legadas ainda renderizando;
  - `403` para usuário em `/usuarios` e no drag de status;
  - isolamento do Meu trabalho (vê o job da Maria, não vê os do admin).
- `node --check` limpo em `public/app.js`, `public/board.js`, `src/routes.js` e `src/app.js`.

## Fase B — entregue

### 1. Tema e acento vermelho

- Tokens `--accent`/`--accent-ink`/`--button-bg` em vermelho (`#fa0002` / `#c40002`), com blocos `html[data-theme="dark"]` e `html[data-theme="light"]` para superfícies, linhas, chips, prioridades e avisos. O tema escuro usa fundo profundo (`--canvas: #05070b`, `--surface: #0c1017`, sidebar `#030407`).
- O vermelho substitui o azul em links, foco, item ativo da sidebar, botões primários, gráficos e no gradiente do login. Os botões usam `--button-bg` escuro para manter texto branco com contraste AA.
- O tema escuro é o padrão (`<html data-theme="dark">`), o toggle na sidebar (e flutuante nas telas públicas) atualiza `aria-pressed`, o rótulo e o `localStorage`.

### 2. Sidebar com clientes e Criar JOB

- `res.locals.sidebarClients` (id, nome e contagem de jobs) é montado em `src/app.js` para todo usuário logado.
- A sidebar renderiza a seção **Clientes** com link para a ficha, contagem de jobs e estado ativo.
- O botão **Criar JOB** aparece apenas para Admin e leva a `/requisicoes/nova`.

### 3. Cliente inline no job

- `views/request-form.ejs` ganhou o campo **Ou novo cliente** (somente na criação), com limite de 120 caracteres.
- `resolveClientId` cria o cliente ou reutiliza o existente por nome case-insensitive; o job aponta para ele e o dashboard é recarregado.

### 4. Automação de etapas e timer

- `src/timer.js` centraliza `startTimer`, `pauseTimer`, `finishTimer`, `elapsedSeconds`, `totalSeconds` e `formatDuration`, com timestamps locais `YYYY-MM-DD HH:MM:SS`.
- Rotas `POST /requisicoes/:id/timer/iniciar|retomar|pausar|concluir` exigem login e validam `canControlTimer`.
- Iniciar move `Novo` → `Em andamento`; concluir move `Novo`/`Em andamento` → `Aguardando`.
- `views/partials/timer.ejs` mostra total do job, timer atual ao vivo, tempo por pessoa e ações; é incluído no detalhe e no drawer. A conclusão usa o `<dialog>` global disparado por `data-confirm`.
- No detalhe, o Admin vê **Aprovar e enviar ao cliente** quando o job está `Aguardando`, e cada etapa exibe uma dica do fluxo (`flow-hint`).

### 5. Retenção de anexos

- `src/cleanup.js` remove somente anexos com `created_at` anterior ao cutoff (30 dias por padrão, configurável por `ATTACHMENT_RETENTION_DAYS`), apagando arquivo e registro.
- `startAttachmentCleanup` roda no boot e a cada 24h; falhas são registradas sem derrubar o servidor.
- Uma proteção de caminho impede apagar arquivos fora de `UPLOAD_DIR`.

### 6. Testes e evidências

- `tests/timer.test.js`: início, pausa/retomada com acúmulo, conclusão, automação de status, permissões (403), admin em qualquer job e 404.
- `tests/cleanup.test.js`: retenção configurável, remoção de arquivo + registro, preservação do job e arquivo ausente.
- `tests/theme.test.js`: paleta vermelha, ausência do azul legado, tema escuro padrão, toggle, Criar JOB e cliente inline na sidebar.
- `tests/table-status.test.js`: seletor de status na Main table (Admin), pílula para usuário comum, reagrupamento via `POST /requisicoes/:id/status`, tinta discreta por etapa nas linhas e novos assets de marca.
- `npm test`: **178/178** passando.
- `node --check` limpo em `src/routes.js`, `src/app.js`, `src/timer.js`, `src/cleanup.js`, `public/app.js` e `public/board.js`.

### 7. Main table editável, tinta discreta e identidade

- A coluna **Status** da Main table ganhou um `<select>` estilizado como pílula para o Admin (`data-status-select`). A troca usa o endpoint existente `POST /requisicoes/:id/status` com JSON, move a linha para o `<tbody>` da etapa de destino e atualiza contagem e KPIs sem recarregar. Erros de transição revertem o seletor e exibem o motivo.
- Usuário comum continua vendo a pílula `status-pill`, sem permissão de alteração (mesma regra do arraste).
- O cabeçalho do grupo voltou a ser **compacto e neutro** (`padding: 5px 10px`, fundo `--surface-2`). Cada linha de job recebe `--group-row-tint` (alpha entre .06 e .08) e um filete de 4px com `--group-color`; a cor da etapa aparece ao longo da linha sem competir com o conteúdo.
- A marca textual foi substituída por `public/logo-fuel.svg` (`<img class="brand-logo">` na sidebar e no login) e o `public/favicon.png` foi atualizado com o novo ícone 1024×1024.
- O vermelho principal passou a ser `#fa0002` (o mesmo do SVG da marca); botões e links usam `#c40002` para manter contraste AA com texto branco. O tema escuro foi aprofundado (`#05070b` de canvas) para dar mais contraste ao vermelho.

### 8. Atualização pós-V7: perfil, tabela enxuta e MySQL

- **Pílulas de status compactas:** `status-pill` e `status-select` passaram a `font-size: 11px` e `padding: 2px 7px` (pílula) / `1px 22px 1px 8px` (select), devolvendo densidade à Main table sem perder contraste.
- **Sem "Adicionar item" por etapa:** as linhas `add-row` foram removidas de cada `tbody.group` em `views/dashboard.ejs` e as referências em `public/board.js` e `public/styles.css`. O botão global **+ Novo item** continua no cabeçalho do board para o Admin.
- **Meu perfil (`/perfil`):** o usuário edita o próprio nome (até 120 caracteres) e envia/remove foto PNG, JPG ou WebP de até 3 MB. `src/upload.js` ganhou `createAvatarUploadMiddleware`, com arquivos em `UPLOAD_DIR/avatars/` servidos por `/avatars/*`. O avatar aparece na sidebar, no perfil, na lista de usuários e na coluna Responsável da Main table; o arquivo anterior é apagado ao trocar ou remover.
- **MySQL/MariaDB compatível com cPanel:** `src/db.js` escolhe o driver por `DB_DRIVER=mysql|mariadb` ou pela presença de `DB_HOST`/`MYSQL_HOST`. A API síncrona usada pelo app é preservada por uma ponte `worker_threads` + `Atomics.wait` (`src/mysql-db.js`/`src/mysql-worker.js`) sobre `mysql2`. `src/sql-dialect.js` traduz `datetime('now','localtime')`, `date('now','localtime')`, `COLLATE NOCASE` e `INSERT OR IGNORE/REPLACE`.
- **Schema para phpMyAdmin:** `database/mysql-schema.sql` cria todas as tabelas em InnoDB/utf8mb4 com FKs, índices e `CHECK`s. Bancos existentes recebem a coluna `users.avatar` por migração automática; o SQLite continua sendo o driver de testes/dev.
- **Seed normalizado:** timestamps do seed usam `YYYY-MM-DD HH:MM:SS`, formato aceito tanto pelo SQLite quanto pelo MySQL.
- **Testes e evidências:** `tests/profile.test.js` (nome, upload, troca, remoção, formatos, conteúdo falso, 3 MB e avatar servido), `tests/mysql-sql.test.js` (dialeto, schema e seleção de driver), `tests/v5.test.js` (KPIs `?mine=1` e `board.js`), `tests/requests.test.js`/`tests/clients.test.js`/`tests/attachments.test.js` (limites do schema, datas impossíveis, links longos e IDs inválidos), `tests/comments.test.js` (limite de comentário), `tests/auth.test.js` (throttle de login) e `tests/shell.test.js` atualizado para exigir a ausência de "Adicionar item". Suíte: **208/208**. Smoke real contra MariaDB 11.4.5: **14/14** (`npm run smoke:mysql`).
- **Deploy:** `DEPLOY-CPANEL.md` documenta criação do banco, importação no phpMyAdmin, Node.js Selector, variáveis `DB_*`, permissões de `uploads/` e troubleshooting.

## Fora de escopo

- Novas regras de negócio, notificações por e-mail, limite de tentativas de login.
- Clonar assets, logo ou componentes proprietários do Monday.
