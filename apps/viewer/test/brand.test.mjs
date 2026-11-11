import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

test('Viewer shell and project title use the shared Ledge Top brand', () => {
  assert.match(html, /<title>Ledge Top — 3D Viewer<\/title>/);
  assert.match(html, /alt="Ledge Top logo"/);
  assert.match(html, /id="brand-company">Ledge Top<\/span>/);
  assert.match(main, /document\.title = `Ledge Top — \$\{p\.title\}`/);
});
