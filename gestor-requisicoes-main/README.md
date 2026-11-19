# Fuel Jobs

Quadro interno de jobs para acompanhar solicitações de clientes — substituto leve do Monday. Workspace com sidebar escura, canvas claro, tabela principal agrupada por etapa e alternância para Kanban, arrastar e soltar **sem recarregar a página**, fichas de clientes, aprovação sequencial (Admin → cliente), **tela pública de aprovação em tela cheia**, anexos visíveis com envio por arrastar e soltar, links do Dropbox e sugestões inteligentes. A sidebar lista os **clientes**, o **Admin cria jobs** por ela, o **tema escuro** é o padrão e pode ser alternado, e cada job tem **timer com pausa e conclusão** que movimenta as etapas automaticamente. Cada usuário pode **editar o próprio nome e enviar uma foto de perfil**. O app roda com **SQLite** (padrão de desenvolvimento) ou **MySQL/MariaDB** (recomendado para produção e compatível com o phpMyAdmin do cPanel).

## Identidade visual

A linguagem é inspirada em boards de trabalho (não é um clone do Monday): sidebar escura, canvas `#f6f7fb` no tema claro, acento vermelho `#fa0002`, grupos com barra colorida, pílulas de status e tabela densa. O **tema escuro é o padrão** (com fundo profundo `#05070b`) e pode ser alternado pela pílula com thumb deslizante da sidebar (ou pela versão flutuante nas telas públicas): a troca dispara uma **varredura em tela cheia: preta ao ir para o tema claro e branca ao voltar para o escuro** antes de revelar o novo tema; a preferência fica em `localStorage['fuel-theme']` e é aplicada antes do primeiro paint, sem flash. A marca no shell e no login usa `public/logo-fuel.svg`; o favicon é o PNG quadrado de alta resolução `public/favicon.png`, usado também como ícone de tela inicial (`apple-touch-icon`) e reaproveitado como imagem no cabeçalho de **Fuel Jobs** e **Meu trabalho** — os glifos da sidebar continuam os mesmos. A interface usa **Bricolage Grotesque** (display) e **Instrument Sans** (corpo), auto-hospedadas em `public/fonts/` — não há dependência de CDN e o app funciona offline. As fontes são distribuídas sob SIL Open Font License 1.1; os textos das licenças acompanham os arquivos.

### Shell e navegação

- **Sidebar** com marca, atalho **Criar JOB** (Admin), navegação por papel, lista de **Clientes** com contagem de jobs, alternador de tema e cartão do usuário no rodapé. O cartão mostra **foto (ou iniciais), nome e papel** e abre a página **Meu perfil**.
- **Barra do workspace** com busca global de jobs e ações da tela.
- **Login** em tela dividida: marca à esquerda e formulário à direita. As abas **Admin / Usuário** são apenas referência visual do que cada papel pode fazer — o papel real vem do usuário autenticado no banco.
- **Admin** vê Dashboard, Meu trabalho, Clientes, Relatórios, Agendamentos, Usuários; **Usuário** vê Dashboard, Meu trabalho, Clientes e Relatórios.
- **Meu trabalho** (`/dashboard?mine=1`) mostra apenas os jobs em que o usuário logado é o responsável — inclusive os KPIs.
- Os clientes listados na sidebar vêm do banco a cada requisição: um cliente criado junto com um job aparece na lista no próximo carregamento.
- Em telas pequenas a sidebar vira um menu deslizante acionado pelo botão de menu.

## Requisitos

- **Node.js 22.13 ou superior** (`node:sqlite` sem flag experimental a partir do 22.13).
- npm (vem com o Node).
- **Banco de dados:** SQLite nativo do Node (`node:sqlite`, sem instalar nada) para desenvolvimento, ou **MySQL 8+ / MariaDB 10.4+** para produção (cPanel). Com MySQL, o pacote `mysql2` já vem nas dependências e o `node:sqlite` não é carregado.

## Como executar

```bash
npm install
npm start
```

Abra <http://localhost:3000>.

Para usar outra porta ou caminhos personalizados:

```bash
PORT=8080 DB_PATH=./data/app.db UPLOAD_DIR=./uploads npm start
```

No Windows (PowerShell):

```powershell
$env:PORT = 8080
npm start
```

### Usando MySQL/MariaDB

Crie o banco (o schema é aplicado automaticamente pelo app na primeira conexão) e informe as variáveis:

```bash
DB_DRIVER=mysql DB_HOST=127.0.0.1 DB_PORT=3306 \
DB_USER=fuel_user DB_PASSWORD=segredo DB_NAME=fuel_jobs npm start
```

No phpMyAdmin do cPanel, importe `database/mysql-schema.sql` antes de subir o app. O guia completo está em [`DEPLOY-CPANEL.md`](DEPLOY-CPANEL.md).

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `DB_DRIVER` | detectado | `mysql`/`mariadb` força MySQL; `sqlite` força SQLite. |
| `DB_HOST` | `127.0.0.1` | Host do MySQL (no cPanel costuma ser `localhost`). |
| `DB_PORT` | `3306` | Porta do MySQL. |
| `DB_USER` | `root` | Usuário do banco. |
| `DB_PASSWORD` | vazio | Senha do banco. |
| `DB_NAME` | `fuel_jobs` | Nome do banco. |
| `DB_SOCKET` | — | Caminho do socket Unix, quando o host usa socket em vez de TCP. |
| `DB_CONNECT_TIMEOUT_MS` | `15000` | Timeout da conexão inicial. |
| `INSTALL_TOKEN` | — | Em produção, código exigido na tela de instalação do primeiro admin. |
| `APP_TIMEZONE` | `America/Sao_Paulo` | Fuso de agendamentos, prazos e relatórios (o app define `TZ` com ele). |
| `ALLOW_SQLITE` | — | `1` permite SQLite em produção. Sem isso, produção exige MySQL configurado. |
| `DB_QUERY_TIMEOUT_MS` | `15000` | Timeout de cada consulta. No MySQL, o app espera cada consulta terminar antes de atender o próximo pedido; um limite curto evita que uma consulta lenta trave todos. |
| `TRUST_PROXY` | — | `1` quando o app roda atrás de proxy/Passenger para reconhecer HTTPS. |
| `SESSION_COOKIE_SECURE` | — | `1` marca o cookie `sid` como `Secure` (exige HTTPS). |
| `NODE_ENV` | — | Use `production` em produção (modo de produção do Express e cache de views). |

Se `DB_DRIVER` não for definido, o app usa MySQL quando `DB_HOST` ou `MYSQL_HOST` estiverem presentes; caso contrário, SQLite. As variáveis `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD` e `MYSQL_DATABASE` também são aceitas.

## Primeiro acesso

**Produção** (`NODE_ENV=production`): não há contas de exemplo. Com o banco vazio, o app abre a tela **Instalação** para criar o administrador com a senha escolhida.

**Desenvolvimento** (sem `NODE_ENV=production`, ou com `SEED=true`): o app cria dados de exemplo e estas contas, **só para testes locais**:

| Perfil | E-mail | Senha |
| --- | --- | --- |
| Admin | `admin@empresa.local` | `Admin@123` |
| Usuário | `usuario@empresa.local` | `Usuario@123` |

Os dados de exemplo só são criados se a tabela `users` estiver vazia. Em **Configurações › Usuários**, o admin cria, desativa e reativa contas e redefine senhas.

## Perfil da conta

A página **Meu perfil** (`/perfil`), acessível pelo cartão do usuário na sidebar, permite:

- **Editar o nome** exibido na conta (até 120 caracteres). O novo nome aparece imediatamente na sidebar, nos jobs como responsável e nas listas.
- **Enviar uma foto de perfil** PNG, JPG ou WebP de até **3 MB**. A foto substitui as iniciais no cartão da sidebar, no perfil, na lista de usuários (Admin) e na coluna Responsável da Main table.
- **Remover a foto**, voltando para as iniciais coloridas.

As imagens ficam em `UPLOAD_DIR/avatars/` e são servidas em `/avatars/<arquivo>`. Ao trocar ou remover a foto, o arquivo antigo é apagado. A troca de senha continua em **Minha senha** (`/perfil/senha`) e revoga as sessões anteriores.

## Colunas do quadro

`Novo` → `Em andamento` → `Em processo` → `Aprovação` → `Aprovado`, com `Rejeitado` ao lado. Cada grupo tem uma barra/dot com a cor da etapa na tabela e no Kanban.

| Coluna | Cor | HEX |
| --- | --- | --- |
| Novo | Azul | `#579bfc` |
| Em andamento | Roxo | `#a25ddc` |
| Em processo | Cinza | `#8b93a6` |
| Aprovação | Laranja | `#fdab3d` |
| Aprovado | Verde | `#00c875` |
| Rejeitado | Vermelho | `#fa0002` |

As pílulas de status usam a cor da etapa como fundo escurecido com texto branco, para manter contraste AA (≥ 4.5:1).

| KPI | Cor | HEX |
| --- | --- | --- |
| Total de Jobs | Cinza | `#676879` |
| Abertos | Azul (Novo) | `#579bfc` |
| Em Atraso | Vermelho (Rejeitado) | `#fa0002` |
| Concluídos | Verde (Aprovado) | `#00c875` |

`Abertos` conta todos os jobs que não estão em `Aprovado` nem em `Rejeitado`; `Concluídos` conta somente jobs com status `Aprovado`.

### Visões do board

- A visão padrão é a **Main table**: tabela de 8 colunas (Item, Cliente, Responsável, Status, Prioridade, Prazo, Coment., Anexos), agrupada por status em grupos recolhíveis (`aria-expanded`).
- O cabeçalho de cada grupo é compacto e neutro; a cor da etapa aparece de forma **discreta ao longo de cada linha de job**, com uma leve tinta de fundo e um filete de 4px à esquerda (azul em `Novo`, roxo em `Em andamento`, cinza em `Em processo`, âmbar em `Aprovação`, verde em `Aprovado` e vermelho em `Rejeitado`).
- Na coluna **Status**, o Admin troca a etapa pelo próprio seletor da linha, **sem recarregar**: o job é movido para o grupo de destino, as contagens e os KPIs são atualizados e transições inválidas exibem o motivo. Usuários veem a pílula colorida.
- O toggle **Tabela / Kanban** troca a visão sem recarregar e lembra a preferência em `localStorage`.
- Clicar no nome do item abre o **drawer** lateral com os dados do job, últimos comentários e anexos; `Ctrl`/`Cmd`/`Shift` + clique abre o item completo em nova aba.
- O botão global **+ Novo item** (somente Admin) fica no cabeçalho do board. Cada etapa **não** repete mais um link "Adicionar item", deixando a tabela mais limpa.

## O que o sistema faz

### Quadro e arraste

- **Somente o Admin** arrasta cards entre colunas; usuários apenas visualizam. O arraste funciona na visão **Kanban**.
- Ao soltar, o status é salvo por `POST /requisicoes/:id/status`. O card é movido no próprio DOM, a pílula de status, as contagens das colunas e os KPIs são atualizados via `GET /dashboard/stats` — **sem recarregar a página** e sem repetir a animação de entrada.
- **Rejeitado** só é definido pelo cliente (via link público); o Admin não consegue arrastar um job para lá.
- **Aprovado** exige as duas aprovações (Admin e cliente) e pode ser definido pelo cliente ao aprovar ou pelo Admin via arraste.
- O board ocupa a altura disponível do shell; se o volume de jobs exceder a tela, a rolagem fica restrita ao interior da tabela/colunas.

### Fluxo de etapas, timer e revisão

O fluxo Admin → Equipe → Admin → Cliente reaproveita as seis etapas existentes:

`Novo` (Admin cria) → `Em andamento` (equipe trabalha) → `Em processo` (equipe concluiu) → `Aprovação` (Admin aprovou e gerou o link) → `Aprovado` / `Rejeitado` (decisão do cliente).

- **Iniciar o timer** em um job `Novo` move o job para **Em andamento**.
- **Pausar** congela o tempo; **retomar** continua do total acumulado.
- **Concluir** abre uma janela que exige o **comentário do que foi feito** (obrigatório) e, se o job estava em `Novo`/`Em andamento`, move para **Em processo** (revisão do Admin).
- O Admin revisa e usa **Aprovar e enviar ao cliente**, que move o job para `Aprovação` e gera o link público.
- O **timer é salvo no servidor** (`time_entries`): continua contando com a aba fechada, e cada job mostra o tempo por pessoa e o total.
- Podem controlar o timer o **Admin**, o **responsável do job** ou qualquer usuário quando o job **não tem responsável**; os demais recebem `403`.
- Iniciar, pausar e concluir ficam nos **ícones** do canto superior direito do painel do job (play, pause e check).

### Criar JOB e cliente na barra lateral

- O botão **Criar JOB** aparece na sidebar apenas para o Admin e abre o formulário de job.
- No formulário é possível escolher um cliente existente **ou** digitar o nome de um **cliente novo** (até 120 caracteres). O cliente é criado e vinculado ao job na mesma operação; se já existir um cliente com o mesmo nome (sem diferenciar maiúsculas), ele é reutilizado.
- A sidebar consulta os clientes no banco a cada requisição, então o cliente novo aparece automaticamente na lista, com a contagem de jobs atualizada.

### Navegação e aparência

- A sidebar concentra a navegação; a barra do workspace traz a busca e as ações de cada tela, e o rodapé da sidebar identifica o usuário e o papel.
- Itens de navegação: **Dashboard**, **Meu trabalho**, **Clientes** e **Relatórios** para todos; **Agendamentos** e **Usuários** aparecem na seção **Administração** apenas para Admin.
- O estado ativo da navegação respeita a rota e o modo **Meu trabalho**, com `aria-current="page"`.
- Fundo e animações foram suavizados para reduzir poluição visual; quem prefere menos movimento pode usar `prefers-reduced-motion`. O drawer não fica focável quando está fechado.

### Clientes

A aba **Clientes** lista todos os clientes e o total de jobs de cada um. A ficha reúne descrição, site, Instagram, Facebook, WhatsApp, LinkedIn, telefone e e-mail, além da lista de jobs vinculados.

- **Todos os usuários logados** podem consultar a lista e as fichas.
- **Somente o Admin** cria, edita e exclui clientes.
- Links são normalizados automaticamente: `novaloja.com.br` → `https://novaloja.com.br`, `@novaloja` → `https://instagram.com/novaloja`, `19999999999` → `https://wa.me/19999999999`.
- Excluir um cliente com jobs é **bloqueado** e informa quantos jobs existem — o histórico é preservado.

### Aprovação sequencial e tela pública

1. No detalhe do job, o Admin clica em **Aprovar**.
2. O sistema registra a aprovação, gera um token único e move o job para **Aprovação**.
3. O link `/aprovacao/<token>` aparece no detalhe como **campo somente leitura + botão Copiar link** (o clique no detalhe não navega). Ele abre **sem login**, como **documento full-bleed**: ocupa 100% da viewport (`100dvh` × 100% da largura), sem sidebar, sem rodapé e **sem nenhum link de navegação** — mesmo que seja aberto numa sessão já logada —, mostrando o **relatório do que foi feito**: descrição, linha do tempo (criação, aprovações, rejeição e conclusão), comentários, anexos exibidos inline (imagens, PDF e TXT) e o link do Dropbox quando existir. O relatório ocupa a coluna esquerda e a decisão é um **card de vidro flutuante** na coluna direita, sem faixa de fundo atrás dele, sobre o mesmo fundo da página; no desktop a página não rola (só a coluna de conteúdo rola internamente, se precisar) e no mobile o layout vira uma coluna. O card tem micro-interações: elevação e leve inclinação no hover, brilho radial que segue o ponteiro, reflexo nos botões e estado de press; **Aprovar pede confirmação inline** dentro do próprio card (com Cancelar e `Esc`), exibe "Aprovando…" no envio e o emblema de resultado desenha o check na chegada. Tudo respeita `prefers-reduced-motion`.
4. O cliente **aprova** ou **rejeita com motivo** — ao clicar em rejeitar, a caixa de justificativa é revelada.
   - Aprovação → job vai automaticamente para **Aprovado**.
   - Rejeição → job vai para **Rejeitado** e o motivo fica registrado.
   - O Admin ajusta o job e clica em **Aprovar** novamente: um **novo token** é gerado e o link antigo deixa de funcionar.
5. Com as duas aprovações, o Admin também pode arrastar o job para **Aprovado**.

Após a decisão, o token **continua válido**: o link pode ser reaberto para consultar o resultado da aprovação, mas novas tentativas de aprovar ou rejeitar não alteram o job. O link só decide jobs que estejam em `Aprovação`; se o Admin devolver o job para outra coluna, o token é invalidado e o link antigo retorna 404.

Editar um job que já tinha aprovação **invalida as aprovações** e devolve o job para `Em processo`, evitando aprovação desatualizada.

Comentários podem ser editados **somente pelo Admin** e **somente enquanto o job está em `Em processo`**. Em `Aprovação`, `Aprovado` ou `Rejeitado` ficam congelados; se o status voltar para `Em processo`, a edição é liberada. Cada alteração registra `edited_at` e aparece como "editado em".

Trocar a senha em **Minha senha** revoga todas as sessões anteriores do usuário, mantendo apenas a sessão recém-criada.

### Anexos e Dropbox

- Upload local continua funcionando normalmente (PDF, PNG, JPG, DOCX, XLSX, TXT, até 10 MB). Os anexos são **exibidos dentro da própria página**, em galeria: imagens aparecem de verdade (com ampliação em modal), PDF e TXT em visualização inline e DOCX/XLSX com um marcador da extensão. Não há link "Baixar" na interface; o endpoint autenticado continua existindo para compatibilidade. Tudo é servido com `Content-Disposition: inline` e exige login no painel ou um token válido no link público.
- O envio aceita **arrastar e soltar**: solte o arquivo sobre a área tracejada e o upload dispara sozinho (o clique para escolher continua disponível como alternativa).
- O cadastro/edição aceita também um **link do Dropbox** (http/https). Ele aparece no detalhe e no relatório público — é uma alternativa adicional, não substitui o upload.
- **Limpeza automática:** anexos de jobs **aprovados pelo cliente há mais de 30 dias** são removidos do disco e do banco. Jobs abertos, em revisão, aguardando o cliente ou rejeitados nunca perdem anexos. Jobs, comentários e histórico **nunca** são apagados. A rotina roda ao iniciar o servidor e a cada 24 horas. O prazo é configurável por `ATTACHMENT_RETENTION_DAYS` (padrão `30`).

#### Retenção de anexos

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `ATTACHMENT_RETENTION_DAYS` | `30` | Dias, contados a partir da aprovação do job, até os anexos serem removidos. Valores inválidos ou menores que 1 voltam ao padrão. |

```powershell
$env:ATTACHMENT_RETENTION_DAYS = "60"
npm start
```

### Sugestões híbridas

- No detalhe do job, clique em **Gerar sugestões**.
- **Local (sempre):** similaridade TF-IDF entre título, descrição e comentários de jobs anteriores; até 3 trechos reaproveitáveis.
- **Opcional (IA generativa):** defina as variáveis de ambiente abaixo. O sistema usa jobs similares como contexto e gera sugestões via API. Se a chave não estiver configurada ou a API falhar, cai automaticamente para o modo local e avisa na tela.
- Cada sugestão tem o botão **Inserir**, que copia o texto para o campo de comentário.

#### Variáveis de ambiente da IA

| Variável | Valores | Descrição |
| --- | --- | --- |
| `AI_PROVIDER` | `openai` ou `anthropic` | Provedor das sugestões generativas. |
| `AI_API_KEY` | chave do provedor | Necessária para habilitar a IA. |

Exemplo (PowerShell):

```powershell
$env:AI_PROVIDER = "openai"
$env:AI_API_KEY = "sua-chave-aqui"
npm start
```

**Nenhuma chave de API está incluída neste pacote.** As chaves ficam apenas no ambiente do servidor.

### Agendamentos (somente Admin)

A aba **Agendamentos** cria regras que geram jobs automaticamente a partir de um modelo pronto:

- **Periodicidade:** de 1 a 365 dias, semanas ou meses.
- **Horário inicial:** `HH:MM` no **horário local do servidor**.
- **Modelo:** título, descrição, cliente, prioridade, responsável, prazo (dias) e link do Dropbox.
- O job gerado entra em **Novo**, com `created_by` igual ao criador da regra e prazo calculado a partir da geração.
- Cada regra pode ser **editada**, **pausada/ativada**, **executada agora** ou **excluída**. Excluir a regra não apaga os jobs já gerados.
- Na listagem, a coluna **Gerados** mostra quantos jobs vieram de cada regra.

**Reinício do servidor:** se o servidor estiver desligado na hora marcada, ao voltar ele gera **apenas a próxima ocorrência** — não cria um lote de jobs atrasados. O agendador roda ao iniciar e depois a cada 60 segundos.

### Relatórios (todos os usuários logados)

A aba **Relatórios** mostra:

- **Gráfico de pizza:** Abertos / Concluídos / Rejeitados da coorte filtrada (concluídos = jobs com status `Aprovado` e `completed_at` no período).
- **Gráfico de barras:** jobs **criados** versus **concluídos** em cada período.
- **Tabela-resumo:** período, criados, concluídos, abertos, rejeitados, total e taxa de conclusão.
- **Filtros:** granularidade (dia, semana, mês ou ano), intervalo `de` / `até`, cliente e atalhos (Hoje, 7 dias, 30 dias, Mês atual, Ano atual).

A coorte é definida pela data de criação; as barras de **concluídos** usam a data de conclusão (`completed_at`). Os gráficos são SVG/CSS gerados no servidor — sem biblioteca externa ou CDN.

## Deploy em cPanel / phpMyAdmin

O passo a passo completo está em [`DEPLOY-CPANEL.md`](DEPLOY-CPANEL.md). Resumo:

1. No phpMyAdmin, crie o banco e um usuário com privilégios apenas nesse banco.
2. Importe `database/mysql-schema.sql` (utf8mb4, tabelas e índices já prontos).
3. Em **Setup Node.js App**, suba o projeto, rode `npm install` e configure as variáveis `DB_DRIVER=mysql`, `DB_HOST=localhost`, `DB_NAME`, `DB_USER` e `DB_PASSWORD`.
4. Aponte o **Application startup file** para `server.js` e reinicie o app.
5. Faça login com as credenciais do seed e troque as senhas imediatamente.

## Estrutura

```
server.js                 ponto de entrada
src/app.js                configuração do Express
src/routes.js             rotas e regras da aplicação
src/db.js                 escolha do driver, schema SQLite e migrações
src/sql-dialect.js        tradução do SQL do app para MySQL/MariaDB
src/mysql-db.js           fachada síncrona do MySQL sobre worker_threads
src/mysql-worker.js       conexão mysql2 que atende a fachada síncrona
database/mysql-schema.sql schema pronto para importar no phpMyAdmin
src/auth.js               sessões e middlewares de acesso
src/security.js           hash de senha e verificação de Origin
src/upload.js             validação e gravação de anexos e avatares
src/workflow.js           regras de transição de status e aprovação
src/timer.js              timers por job/pessoa (iniciar, pausar, retomar, concluir)
src/cleanup.js            limpeza automática de anexos antigos
src/suggestions.js        similaridade local (TF-IDF)
src/ai.js                 integração opcional com OpenAI/Anthropic
src/scheduler.js          agendador (timer + execução de regras)
src/scheduler-core.js     cálculo da próxima ocorrência e geração de jobs
src/reports.js            métricas, buckets e paths da pizza
src/clients.js            normalização de links e validação da ficha
src/config.js             constantes
views/                    templates EJS (dashboard, perfil, drawer, partials)
public/styles.css         design system (tokens, shell, tabela, kanban, drawer)
public/app.js             interações do shell (visões, grupos, drawer, abas)
public/board.js           arraste entre colunas e atualização de KPIs
public/                   fontes e favicon
scripts/smoke-mysql.js    smoke test real de login, perfil, jobs e agendador no MySQL
tests/                    testes automatizados
data/app.db               banco SQLite (criado em tempo de execução)
uploads/                  anexos e avatares (criado em tempo de execução)
```

## Testes

```bash
npm test
```

A suíte cobre rotas, regras de status, aprovação, relatórios, agendador, segurança, o shell do board (papéis, Meu trabalho, drawer e preselect de status), o **timer e a automação de etapas**, o **cliente inline na sidebar**, o **tema escuro**, a **retenção de anexos**, o **status editável na Main table**, a **faixa colorida dos grupos**, o **perfil com nome e foto** e a **camada MySQL** — **208 testes**.

Para validar o caminho MySQL contra um servidor real:

```bash
DB_DRIVER=mysql DB_HOST=127.0.0.1 DB_PORT=3306 \
DB_USER=root DB_PASSWORD=segredo DB_NAME=fuel_jobs npm run smoke:mysql
```

## Segurança e limitações

- Senhas nunca são gravadas em texto puro; tokens de sessão são gravados apenas como SHA-256.
- Cookies `HttpOnly` + `SameSite=Lax`; requisições de escrita com `Origin` estranho são rejeitadas.
- O download de anexos valida o caminho para evitar *path traversal*. Avatares são imagens públicas em `/avatars/` (o nome do arquivo é aleatório) e não expõem dados da conta.
- Links de aprovação são tokens aleatórios de 64 caracteres hexadecimais; são descartados quando uma nova aprovação é gerada e permanecem válidos para consulta após a decisão (sem permitir nova aprovação ou rejeição).
- A gestão de clientes (criar/editar/excluir) exige perfil Admin; a exclusão é bloqueada enquanto houver jobs ligados ao cliente.
- Para produção, use **HTTPS**, um reverse proxy e um usuário de MySQL com privilégios restritos ao banco do app. O login tem limite de tentativas por conta e por IP (defina `TRUST_PROXY=1` atrás de proxy). Não há notificações por e-mail nesta versão. A exclusão automática atinge **somente anexos** de jobs aprovados há mais de `ATTACHMENT_RETENTION_DAYS` dias; jobs nunca são excluídos.
- Faça backup do banco (arquivo `data/app.db` no SQLite ou `mysqldump`/exportação do phpMyAdmin no MySQL) e de `uploads/`.
