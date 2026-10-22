'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');

// Vite does not parse the classic scripts in copied public HTML. Helper-only
// unit tests likewise miss syntax errors in the inline integration wiring.
const htmlFiles = [root, path.join(root, 'public'), path.join(root, 'test', 'fixtures')]
  .flatMap(directory => fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
    .map(entry => path.join(directory, entry.name)));

for (const file of htmlFiles) {
  test(`all executable inline scripts parse: ${path.relative(root, file)}`, () => {
    const html = fs.readFileSync(file, 'utf8');
    let index = 0;
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const [, attributes, source] = match;
      if (/\bsrc\s*=/i.test(attributes)) continue;
      const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1]?.toLowerCase() || '';
      if (!['', 'module', 'text/javascript', 'application/javascript'].includes(type)) continue;
      index++;
      const label = `${path.relative(root, file)} inline script ${index}`;
      if (type === 'module') {
        // Syntax check only: do not execute DOM code, import dependencies, or
        // fetch script URLs. Module parsing also supports import.meta/await.
        const parsed = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8', timeout: 10000 });
        assert.equal(parsed.status, 0, `${label}: ${parsed.error?.message || parsed.stderr}`);
      } else {
        assert.doesNotThrow(() => new vm.Script(source, { filename: label }), label);
      }
    }
  });
}
