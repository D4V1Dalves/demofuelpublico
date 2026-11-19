# Fuel Jobs — SPEC v5 (arraste sem reload, Clientes, cores e topo)

## Objetivo
Refinar a experiência sem alterar fluxos já aprovados:
1. Mover cards entre colunas **sem recarregar a página**.
2. Reduzir a poluição visual (fundo e animações mais suaves) e **centralizar as abas**.
3. Adicionar aba de **Clientes** com ficha completa (redes sociais, descrição e contatos).
4. Dar **cores distintas** aos KPIs e às seis colunas; KPIs sem bordas arredondadas.

## Decisões aprovadas
- Arraste: mover o card no DOM, atualizar contagens das colunas e dos KPIs; **sem `location.reload()`**.
- Poluição: suavizar mesh/ruído/glass e a animação de entrada, preservando a identidade e o `prefers-reduced-motion`.
- Topo: marca à esquerda, abas centralizadas, usuário/Sair à direita.
- Ficha do cliente: nome, descrição, site, Instagram, Facebook, WhatsApp, LinkedIn, telefone e e-mail, com página de detalhe e jobs do cliente.
- Exclusão: **bloquear** se houver jobs vinculados, informando a quantidade.
- Cores: acentos variados (vermelho, âmbar, azul, violeta, rosa, verde) sobre fundo escuro; KPIs com cantos retos.

## 1. Arraste sem reload

### `public/board.js`
- Ao receber `200` de `POST /requisicoes/:id/status`:
  - remove o card da coluna de origem e o anexa ao `.column-body` da coluna destino;
  - atualiza os `.count` das duas colunas;
  - busca `GET /dashboard/stats` e atualiza os quatro `.kpi-number` (o filtro da tela não afeta esses números, que continuam globais como hoje);
  - remove classes `dragging`/`drop-target`;
  - **não** chama `window.location.reload()`.
- Em caso de erro, mostra o `alert` atual (sem recarregar).

### Nova rota
- `GET /dashboard/stats` (`requireAuth`) → JSON com `{ total, abertas, concluidas, atrasadas }` de `getStats(db)`.

## 2. Poluição visual e topo

### CSS
- `body::before`: reduzir opacidade dos radiais e remover o terceiro brilho central; `body::after`: ruído com opacidade menor.
- `@keyframes fuel-in`: duração reduzida (~.3s) e deslocamento menor; delays em cascata comprimidos.
- `.topbar`: grid de três zonas (`1fr auto 1fr`); `.topbar nav` centralizada; `.topbar-actions` à direita.
- Manter tokens, fontes auto-hospedadas e o fallback `prefers-reduced-motion`.

### `views/partials/top.ejs`
- `<nav>` contém apenas links de abas (Dashboard, Clientes, Relatórios, e Admin → Agendamentos, Usuários).
- Usuário e botão Sair saem do `<nav>` para `.topbar-actions`.

## 3. Clientes

### Schema (migração)
Colunas em `clients`: `description`, `website`, `instagram`, `facebook`, `whatsapp`, `linkedin`, `phone`, `email` (todas `TEXT`, nullable/default vazio). Seed recebe valores de exemplo.

### Módulo `src/clients.js`
- `normalizeSocialUrl(value, kind)`: aceita URL completa ou `usuario`/`@usuario`; WhatsApp aceita número e vira `https://wa.me/<digits>`; demais viram `https://<rede>.com/<usuario>`.
- `validateClientInput(body)`: nome obrigatório, e-mail opcional válido, links normalizados com protocolo http/https.
- `getClient(db, id)`, `getClientJobCount(db, id)`.

### Rotas
- `GET /clientes` (`requireAuth`) — lista com total de jobs; Admin vê botões de criar/editar/excluir.
- `GET /clientes/:id` (`requireAuth`) — ficha com descrição, contatos, links e lista de jobs do cliente.
- `GET /clientes/novo`, `POST /clientes`, `GET /clientes/:id/editar`, `POST /clientes/:id/editar`, `POST /clientes/:id/excluir` — **Admin**.
- Exclusão com jobs: resposta 400 com mensagem contendo a quantidade; nada é apagado.

### Views
- `views/clients.ejs` (lista + formulário novo para Admin).
- `views/client-form.ejs` (edição).
- `views/client.ejs` (ficha).

## 4. Cores dos KPIs e colunas

### KPIs
- Novas classes: `.kpi-total` (vermelho), `.kpi-open` (âmbar), `.kpi-late` (rosa), `.kpi-done` (verde).
- `.kpi { border-radius: 0; }` — cantos retos em todos os KPIs.

### Colunas do quadro
- Cada `.column[data-status="..."]` define `--stage` (acento): Novo = vermelho, Em andamento = âmbar, Aguardando = azul, Aprovação = violeta, Rejeitado = rosa, Concluído = verde.
- `.column-head` usa `border-top-color: var(--stage)`; `.count` usa o mesmo acento; fundo permanece escuro.
- Substituir as regras antigas `.column-head.status-*`.

## Fora de escopo
- Upload de logo, notificações, exclusão em cascata, edição de cliente por usuário comum, mudança de fonte.

## Tarefas (TDD)
1. **RED** — `tests/v5.test.js` (arraste sem reload, stats JSON, marcação HTML das cores, nav centralizada) e `tests/clients.test.js` (ficha, validação, permissões, exclusão bloqueada).
2. **GREEN** — migrações, `src/clients.js`, rotas, views, `board.js`, CSS e nav.
3. **REFACTOR** — normalização centralizada de links, transações/validações, responsividade.
4. **REVIEW** — suíte completa, smoke real, ZIP final verificado por extração.
