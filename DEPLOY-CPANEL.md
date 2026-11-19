# Deploy do Fuel Jobs no cPanel (Node.js + phpMyAdmin)

Guia para publicar o sistema em uma hospedagem cPanel com **MySQL/MariaDB** e **Node.js Selector** (Passenger). O app também cria o schema sozinho na primeira conexão, mas importar o SQL pelo phpMyAdmin deixa o banco pronto e evita surpresas.

> **Resumo:** crie o banco e o usuário → importe `database/mysql-schema.sql` → envie os arquivos → crie o app Node apontando para `server.js` → configure as variáveis `DB_*` → rode `npm install` → reinicie → troque as senhas do seed.

---

## 1. Requisitos na hospedagem

- **Node.js 22.13 ou superior** disponível no Node.js Selector.
- **MySQL 8+ ou MariaDB 10.4+** e acesso ao **phpMyAdmin**.
- Acesso ao **File Manager** (ou FTP/SFTP) e ao **Setup Node.js App**.

Se o Node.js Selector só oferecer versões antigas, peça ao suporte para habilitar a 22.x. O app usa `node:sqlite` apenas quando roda em SQLite; em produção com MySQL ele não é carregado, mas o restante do código exige Node moderno.

## 2. Criar o banco e o usuário

1. No cPanel, abra **MySQL Databases** (ou **Bancos de Dados MySQL**).
2. Crie o banco, por exemplo `fuel_jobs`. O cPanel vai prefixar com o usuário da conta: `conta_fuel_jobs`.
3. Crie um usuário dedicado, por exemplo `fuel_user` → vira `conta_fuel_user`, com uma senha forte.
4. Em **Add User To Database**, associe o usuário ao banco e marque **ALL PRIVILEGES** (ou ao menos `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `INDEX`, `REFERENCES`).
5. Anote os quatro valores: **host** (normalmente `localhost`), **nome do banco**, **usuário** e **senha**.

> Não use o usuário `root` do MySQL em produção.

## 3. Importar o schema no phpMyAdmin

1. No cPanel, abra **phpMyAdmin**.
2. Selecione o banco criado (`conta_fuel_jobs`) na coluna da esquerda.
3. Aba **Importar** → **Escolher arquivo** → selecione `database/mysql-schema.sql` do projeto.
4. Confirme o charset **utf-8** e clique em **Executar**.
5. Verifique se apareceram as tabelas: `users`, `sessions`, `clients`, `requests`, `recurring_rules`, `comments`, `attachments` e `time_entries`.

O script é idempotente (`CREATE TABLE IF NOT EXISTS`), então pode ser reimportado sem apagar dados. Ele já cria:

- Charset `utf8mb4` (acentos e emojis) e engine InnoDB.
- Chaves estrangeiras, índices nas FKs e restrições `CHECK` de status/prioridade/papel.
- A coluna `users.avatar` usada pela foto de perfil.

Se o phpMyAdmin reclamar de `SET NAMES utf8mb4`, pode ignorar — é apenas o cabeçalho de charset.

## 4. Enviar os arquivos

1. Gere o pacote a partir do código atual com `npm run package`. Ele cria `fueljobs-deploy.zip` só com os arquivos versionados (sem `node_modules`, banco ou uploads de teste). Não reaproveite zips antigos: eles podem ter código de antes das correções.
2. No **File Manager**, crie uma pasta fora de `public_html`, por exemplo `/home/conta/fueljobs`.
3. Envie o `fueljobs-deploy.zip` e use **Extract**. O conteúdo vem dentro de uma pasta `fueljobs/`; mova os arquivos para a raiz da pasta do app.
4. Confirme que `server.js`, `package.json`, `src/`, `views/`, `public/`, `database/` e `uploads/` estão na raiz dessa pasta.

> O app serve os arquivos estáticos e os avatares pelo próprio Express. Não é necessário copiar `public/` para `public_html`.

## 5. Criar o app Node.js

No cPanel, abra **Setup Node.js App** → **Create Application**:

| Campo | Valor |
| --- | --- |
| Node.js version | 22.x (ou a mais nova disponível) |
| Application mode | Production |
| Application root | `fueljobs` (a pasta criada no passo 4) |
| Application URL | o domínio/subdomínio desejado |
| Application startup file | `server.js` |

Depois de criar, abra a aplicação e adicione as **Environment Variables**:

| Variável | Exemplo | Observação |
| --- | --- | --- |
| `DB_DRIVER` | `mysql` | Força o driver MySQL/MariaDB. |
| `DB_HOST` | `localhost` | No cPanel quase sempre é `localhost`. |
| `DB_PORT` | `3306` | Padrão do MySQL. |
| `DB_NAME` | `conta_fuel_jobs` | Nome completo, com o prefixo do cPanel. |
| `DB_USER` | `conta_fuel_user` | Usuário completo, com prefixo. |
| `DB_PASSWORD` | `sua-senha-forte` | A senha criada no passo 2. |
| `UPLOAD_DIR` | `/home/conta/fueljobs-data/uploads` | Caminho absoluto e gravável para anexos e avatares, **fora da pasta do app** (`fueljobs`). Assim uma atualização que troca a pasta do app não apaga os arquivos. Crie a pasta antes no File Manager. |
| `INSTALL_TOKEN` | um código só seu (ex.: 20+ letras e números) | Exigido na tela **Instalação**. Impede que outra pessoa crie o admin antes de você. Pode apagar depois de instalar. |
| `APP_TIMEZONE` | `America/Sao_Paulo` (padrão) | Fuso usado em agendamentos, prazos e relatórios. Só defina se a equipe estiver em outro fuso. |
| `SEED` | *(não defina)* | Em produção (`NODE_ENV=production`) o padrão é **não** criar dados de exemplo. Só use `SEED=true` em ambiente de teste: cria contas com senha pública. |
| `TRUST_PROXY` | *(não defina)* | Com `NODE_ENV=production` o app já confia no proxy do cPanel (IP real do usuário e HTTPS). Use `0` só se o app ficar exposto sem proxy. |
| `SESSION_COOKIE_SECURE` | `1` | Marca o cookie de sessão como `Secure` (ative após o HTTPS). |
| `NODE_ENV` | `production` | Ativa o modo de produção do Express e o cache de views. |

Não defina `PORT` manualmente: o Passenger do cPanel injeta a porta/socket e o `server.js` já lê `process.env.PORT`.

### Instalar dependências e iniciar

1. Na tela do app, clique em **Run NPM Install** (ou execute `npm install` pelo terminal da cPanel dentro da pasta).
2. Clique em **Restart**.
3. Abra a **Application URL**. A tela de login deve carregar.
4. Se aparecer **503**, veja os logs em **Setup Node.js App → Logs** (ou `stderr.log` na pasta do app).

### Permissões

A pasta `uploads/` (e a subpasta `avatars/`, criada automaticamente) precisa ser gravável pelo usuário da aplicação. No File Manager, ajuste para `755` (pastas) e `644` (arquivos). Se o upload falhar, confirme o dono/permissão e o caminho absoluto em `UPLOAD_DIR`.

## 5.1 Cron dos agendamentos

O cPanel desliga o app quando ninguém acessa o site, e os agendamentos param junto. Para os jobs recorrentes saírem na hora certa:

1. No cPanel, abra **Cron Jobs** e crie uma tarefa **a cada minuto** (`* * * * *`).
2. Comando (ajuste os caminhos; o caminho do Node aparece em **Setup Node.js App** → comando "source"):

```bash
cd /home/conta/fueljobs && source /home/conta/nodevenv/fueljobs/22/bin/activate && \
  NODE_ENV=production DB_HOST=localhost DB_NAME=conta_fuel_jobs DB_USER=conta_fuel_user \
  DB_PASSWORD='sua-senha-forte' UPLOAD_DIR=/home/conta/fueljobs-data/uploads \
  node scripts/run-scheduler.js >> /home/conta/fueljobs/cron.log 2>&1
```

O cron usa o mesmo fuso do app (`America/Sao_Paulo`, ou o de `APP_TIMEZONE`) e só conecta ao banco: a verificação do schema fica com o app. O script roda uma vez e encerra. Pode conviver com o app aberto: cada execução é reservada no banco, então nenhum job sai duplicado. A limpeza de anexos roda junto, uma vez por dia (às 3h).

## 6. Primeiro acesso

Com o banco vazio, qualquer página abre a tela **Instalação**:

1. Informe o **código de instalação** (o valor de `INSTALL_TOKEN`), nome, e-mail e uma senha de pelo menos 10 caracteres. Essa é a conta do administrador; a tela só aparece uma vez.
2. Em **Configurações › Usuários**, crie as contas da equipe.
3. Se alguém sair da equipe, use **Desativar** (a pessoa sai na hora e não entra mais). Se alguém esquecer a senha, use **Redefinir senha**.

Não há contas de exemplo em produção. Se um banco de teste foi criado com `SEED=true`, desative as contas `admin@empresa.local` e `usuario@empresa.local` antes de liberar o acesso.

## 7. Checklist pós-deploy

- [ ] A tela **Instalação** aparece no primeiro acesso e cria o administrador.
- [ ] Login do Admin funciona e o cookie `sid` é gravado.
- [ ] `admin@empresa.local` / `Admin@123` **não** entra (sem contas de exemplo).
- [ ] Dashboard lista os jobs e a sidebar mostra os clientes.
- [ ] Criar um job de teste, mover de etapa e comentar.
- [ ] Enviar um anexo (clique e arrastar) e conferir a pré-visualização inline na página do job; não deve haver link "Baixar".
- [ ] Abrir **Meu perfil**, salvar o nome, enviar uma foto e removê-la.
- [ ] Criar um usuário comum e conferir que ele não acessa **Usuários** nem **Agendamentos**.
- [ ] Abrir o link público de aprovação em uma janela anônima (e também logado, para confirmar que não herda a sidebar): deve mostrar o relatório completo em tela cheia (com anexos e comentários) e o card de decisão flutuante na coluna direita, sem faixa de fundo atrás dele e sem nenhum link de navegação; o card deve reagir ao hover (brilho/inclinação) e **Aprovar deve pedir confirmação inline** antes de concluir o job.
- [ ] Configurar **AutoSSL/HTTPS** no domínio.
- [ ] Cron dos agendamentos criado; depois de 1 minuto, `cron.log` existe e não mostra erros.
- [ ] Agendar backup do banco e da pasta `uploads/`.

## 8. Problemas comuns

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| App não sobe: "Banco não configurado" | Faltam `DB_HOST` (ou `DB_SOCKET`), `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Defina as variáveis do MySQL no **Setup Node.js App** e reinicie. |
| Tela de instalação pede `INSTALL_TOKEN` | Variável não definida | Defina `INSTALL_TOKEN` com um código seu e reinicie o app. |
| Log avisa "UPLOAD_DIR está dentro da pasta do app" | Uploads seriam apagados na atualização | Aponte `UPLOAD_DIR` para fora do app, ex.: `/home/conta/fueljobs-data/uploads`, e mova os arquivos. |
| `Cannot find module 'mysql2'` | Dependências não instaladas | Rode **Run NPM Install** e reinicie. |
| `Não foi possível conectar ao MySQL` | Host/usuário/senha/banco errados ou usuário sem permissão | Confira os valores com prefixo do cPanel e associe o usuário ao banco. |
| `ECONNREFUSED` em `127.0.0.1` | O MySQL do cPanel pode usar socket | Use `DB_HOST=localhost`; se persistir, defina `DB_SOCKET` (ex.: `/var/lib/mysql/mysql.sock`). |
| `Table ... doesn't exist` | Banco vazio sem schema | Importe `database/mysql-schema.sql` ou reinicie o app para criar. |
| Erro de charset/acentos | Conexão fora de utf8mb4 | O app força `utf8mb4`; confirme o charset do banco no phpMyAdmin. |
| **503 Service Unavailable** | App não iniciou | Veja os logs do Node.js Selector; normalmente falta `npm install` ou há variável `DB_*` incorreta. |
| Upload/avatar falha | `uploads/` sem permissão | Ajuste permissões e `UPLOAD_DIR` para o caminho absoluto. |
| Sessão cai a cada deploy | Passenger reinicia o processo | Normal; as sessões ficam no banco (`sessions`) e sobrevivem ao restart. |
| Link de aprovação não abre | Token antigo após edição/reaprovação | Gere um novo link aprovando o job novamente. |

## 9. Backup e atualização

- **Banco:** exporte pelo phpMyAdmin (aba **Exportar**) ou use `mysqldump` pelo terminal.
- **Arquivos:** baixe a pasta de `UPLOAD_DIR` periodicamente (anexos e avatares).
- **Atualização do app:** gere o zip com `npm run package`, envie e extraia **por cima** da pasta do app (os uploads ficam fora dela, em `UPLOAD_DIR`). Depois, rode **Run NPM Install** se `package.json` mudou e clique em **Restart**. O schema é compatível e as migrações leves (colunas, índices e normalização de status antigos) são aplicadas automaticamente no SQLite e no MySQL.

## 10. Validar o caminho MySQL localmente (opcional)

A suíte inteira de testes roda contra um MySQL de verdade: cada arquivo de teste ganha um banco novo, apagado no fim.

```bash
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=... npm run test:mysql
```

O usuário precisa poder criar e apagar bancos. Dois testes são pulados no MySQL de propósito (um status inválido que o banco já recusa e a migração de um arquivo SQLite antigo).


Para um teste rápido (14 verificações) contra um MySQL/MariaDB local:

```bash
DB_DRIVER=mysql DB_HOST=127.0.0.1 DB_PORT=3306 \
DB_USER=root DB_PASSWORD=segredo DB_NAME=fuel_jobs npm run smoke:mysql
```

O script `scripts/smoke-mysql.js` cobre conexão/schema, login, dashboard, usuários, perfil, criação de job, status, timer, anexo, relatórios, agendamentos e a transação do agendador.
