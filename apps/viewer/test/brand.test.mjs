import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

test('Viewer shell and project title use the shared Ledge Top brand', () => {
  assert.match(html, /<title>Ledge Top — 3D Viewer<\/title>/);
  // The LT mark is inline SVG (no remote image), so its accessible name is an aria-label on role=img.
  assert.match(html, /<svg class="lt-mark"[^>]*role="img"[^>]*aria-label="Ledge Top logo"/);
  assert.doesNotMatch(html, /DroneLogo01\.webp/);
  assert.match(html, /id="brand-company">Ledge Top<\/span>/);
  assert.match(main, /document\.title = `Ledge Top — \$\{p\.title\}`/);
});
