# Fuel Jobs — SPEC v3 (Agency Edition)

## Objetivo
Revestir **todo o app** (login, dashboard, detalhe, formulários, aprovação pública) com uma identidade de agência premium, inspirada em `agenciafuel.com.br`, sem quebrar nenhuma funcionalidade v2.

## Referência investigada (fatos, não suposições)
- CSS da referência expõe `--fuel-red: oklch(53.01% .208 22.88)` e `--fuel-bg-red: oklch(58.99% .237 25.01)`.
- Escala neutra: preto `#171717`, branco, cinzas; `--radius: .625rem`.
- Tipografia da referência: **Roboto 100–900** (108 `@font-face`).
- **Conflito resolvido com o usuário:** a diretriz de design proíbe Roboto/Inter/Arial/system fonts. Mantemos a regra do plugin; adoptamos apenas a *energia* cromática da referência.

## Decisões de design
### 1. Tipografia
- Display: **Bricolage Grotesque** (variável 200–800) — wordmark, H1, números dos KPIs, títulos de coluna.
- Corpo: **Instrument Sans** (400–700) — textos, labels, botões, badges.
- Ambas auto-hospedadas em `public/fonts/` (woff2, SIL OFL 1.1) — sem CDN, funciona offline.
- Salto de escala extremo: H1 `clamp(3rem, 6vw, 6.5rem)` / peso 800 / tracking `-.045em`; corpo `13px`. Nada de meio-tom.
- Proibição testada: nenhuma ocorrência de Roboto, Inter, Arial, Space Grotesk, system-ui ou BlinkMacSystemFont no CSS.

### 2. Cor (CSS variables)
- `--canvas: #0b0b0c` (dominante), `--surface: #141417`, `--paper: #f5f3ef`.
- `--fuel: #e11d2a` (idêntico ao token legado `--brand`) e `--fuel-hot: #f24a2e` (acento único e agressivo).
- `--ink` permanece `#ffffff` como token legado de texto; não foi renomeado para preservar a regressão v2.
- `--line: rgba(255,255,255,.11)`, `--muted: #9b9ba1`, `--good: #2fd07a` (apenas Concluído).
- Sem purple, sem gradientes lilás, sem paleta pastel distribuída.

### 3. Composição
- Login: wordmark gigante "FUEL" sangrando pela borda esquerda + card deslocado à direita sobre slash vermelho diagonal.
- Dashboard: topbar com wordmark Bricolage 800, KPIs com números 3× o corpo, colunas com cabeçalhos escalonados (offsets 0/6/12px) e badge de contagem invadindo a borda. Cards com leve rotação alternada e sombras em camadas.
-Detalhe: kicker vermelho, H1 gigante, grid assimétrico 2fr/1fr, painel de sugestões com borda esquerda vermelha.
- Aprovação pública: mesmo sistema, chip de cliente, título grande, Aprovar preenchido / Rejeitar contornado.
- Mantido: `body.board-page { height:100vh; overflow:hidden }`, scroll apenas em `.column-body`/`.board`.

### 4. Motion (uma coreografia só)
- `@keyframes fuel-in`: `opacity 0→1`, `translateY(18px)→0`, `cubic-bezier(.2,.8,.2,1)`.
- Cascata: topbar → page-head → KPIs → filtros → colunas → cards, delays progressivos.
- `@media (prefers-reduced-motion: reduce)` desativa tudo.
- Transição de estado: `.column.drop-target` ganha glow vermelho; card arrastado esmaece.

### 5. Atmosfera
- Mesh de gradientes radiais escuros com brilho vermelho discreto no topo.
- Textura de ruído SVG em data-URI, opacidade baixa, `pointer-events:none`.
- Glassmorphism leve nos cards, sombras dramáticas em camadas.

## Fora de escopo
- Nenhuma mudança de rotas, banco, regras de aprovação, Dropbox, sugestões ou AI.
- Nenhuma chave de API no pacote.

## Tarefas (TDD)
1. **RED** — `tests/design-system.test.js`: falha por fontes ausentes, variáveis ausentes, fontes proibidas presentes e keyframes ausente.
2. **GREEN** — adicionar woff2 + `@font-face`, substituir tokens e tipografia, escrever a coreografia e a atmosfera.
3. **Templates** — ajustar ganchos de classe em `partials/top.ejs`, `login.ejs`, `dashboard.ejs`, `request.ejs`, `approval.ejs`, `request-form.ejs`, `users.ejs`, `password.ejs`.
4. **REFACTOR** — consolidar regras, garantir contraste e `prefers-reduced-motion`, rodar os 90 testes + smoke.
5. **REVIEW** — auto-review, regenerar ZIP, verificar extração/teste.
