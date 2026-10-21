import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { patchLodLoadingBudget } from '../scripts/lib/patch-lod-loading-budget.mjs';

const installedRoot = path.resolve(import.meta.dirname, '../node_modules/3d-tiles-renderer');
const hook = 'this.__ltdsLoadingBudget?.bodyReady(';
const sourceHook = '\t\t\t\tthis.__ltdsLoadingBudget?.bodyReady( tile, content );\n';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ltds-loading-patch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = 'src/core/renderer/tiles/TilesRendererBase.js';
  const source = await fs.readFile(path.join(installedRoot, sourcePath), 'utf8');
  const build = path.join(installedRoot, 'build');
  const found = [];
  for (const name of await fs.readdir(build)) {
    if (!/^renderer-.*\.js$/.test(name)) continue;
    const content = await fs.readFile(path.join(build, name), 'utf8');
    if (content.includes(hook)) found.push({ name, content });
  }
  assert.equal(found.length, 1, 'installed dependency has exactly one patched body hook chunk');
  const sourceFile = path.join(root, sourcePath);
  const bundleFile = path.join(root, 'build', found[0].name);
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.mkdir(path.dirname(bundleFile), { recursive: true });
  await fs.writeFile(sourceFile, source);
  await fs.writeFile(bundleFile, found[0].content);
  return { root, sourceFile, bundleFile };
}

test('loading-body patch applies to the pinned source and bundle and repeats without changes', async t => {
  const { root, sourceFile, bundleFile } = await fixture(t);
  const expectedSource = await fs.readFile(sourceFile, 'utf8');
  const expectedBundle = await fs.readFile(bundleFile, 'utf8');
  assert.equal(expectedSource.split(sourceHook).length, 2);
  const builtHook = /this\.__ltdsLoadingBudget\?\.bodyReady\([\w$]+, [\w$]+\), /g;
  assert.equal([...expectedBundle.matchAll(builtHook)].length, 1);
  await fs.writeFile(sourceFile, expectedSource.replace(sourceHook, ''));
  await fs.writeFile(bundleFile, expectedBundle.replace(builtHook, ''));
  patchLodLoadingBudget(root);
  patchLodLoadingBudget(root);
  assert.equal(await fs.readFile(sourceFile, 'utf8'), expectedSource);
  assert.equal(await fs.readFile(bundleFile, 'utf8'), expectedBundle);
});

for (const target of ['sourceFile', 'bundleFile']) {
  for (const corruption of ['duplicate', 'misplaced']) {
    test(`loading-body patch rejects a ${corruption} hook in the pinned ${target}`, async t => {
      const files = await fixture(t);
      const file = files[target];
      const before = await fs.readFile(file, 'utf8');
      const match = before.match(/this\.__ltdsLoadingBudget\?\.bodyReady\([^\n]+?\)/);
      assert.ok(match);
      const corrupted = corruption === 'duplicate'
        ? `${before}\n${match[0]};\n`
        : `${before.replace(match[0], 'void 0')}\n${match[0]};\n`;
      await fs.writeFile(file, corrupted);
      assert.throws(() => patchLodLoadingBudget(files.root), /count or placement/);
      assert.equal(await fs.readFile(file, 'utf8'), corrupted, 'invalid patched input is not silently rewritten');
    });
  }
}
