const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('design fonts are self-hosted woff2 files', () => {
  const dir = path.join(root, 'public', 'fonts');
  assert.ok(fs.existsSync(dir), 'public/fonts must exist');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.woff2'));
  assert.ok(files.some((f) => /bricolage/i.test(f)), 'missing Bricolage Grotesque woff2');
  assert.ok(files.some((f) => /instrument/i.test(f)), 'missing Instrument Sans woff2');
});

test('CSS declares both @font-face families', () => {
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*['"]?Bricolage Grotesque/s);
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*['"]?Instrument Sans/s);
});

test('CSS exposes agency color and typography tokens', () => {
  for (const token of ['--canvas', '--paper', '--fuel', '--fuel-hot', '--font-display', '--font-body']) {
    assert.match(css, new RegExp(`${token}\\s*:`), `missing token ${token}`);
  }
});

test('CSS bans AI staple and reference fonts', () => {
  for (const font of ['Roboto', 'Inter', 'Arial', 'Space Grotesk', 'system-ui', 'BlinkMacSystemFont', 'Segoe UI']) {
    assert.doesNotMatch(css, new RegExp(`\\b${font}\\b`, 'i'), `forbidden font ${font}`);
  }
});

test('CSS has one staggered load choreography with reduced-motion fallback', () => {
  assert.match(css, /@keyframes\s+fuel-in\s*\{/);
  assert.match(css, /animation-delay\s*:/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('CSS keeps the viewport-height board with column-only scrolling', () => {
  assert.match(css, /body\.board-page\s*\{[^}]*height:\s*100vh/s);
  assert.match(css, /body\.board-page\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.column-body\s*\{[^}]*overflow:\s*auto/s);
});

test('CSS builds atmosphere with mesh, noise and glass', () => {
  assert.match(css, /radial-gradient/);
  assert.match(css, /data:image\/svg\+xml/);
  assert.match(css, /backdrop-filter/);
});

test('templates expose design hooks on every screen', () => {
  assert.match(read('views/partials/top.ejs'), /brand-mark/);
  assert.match(read('views/login.ejs'), /hero-wordmark/);
  assert.match(read('views/dashboard.ejs'), /kpi-number/);
  assert.match(read('views/request.ejs'), /detail-kicker/);
  assert.match(read('views/approval.ejs'), /approval-decision/);
  assert.match(read('views/request-form.ejs'), /page-title/);
  assert.match(read('views/partials/settings-head.ejs'), /page-title/);
  for (const view of ['users', 'password', 'profile', 'settings', 'settings-ai']) {
    assert.match(read(`views/${view}.ejs`), /partials\/settings-head/);
  }
});
