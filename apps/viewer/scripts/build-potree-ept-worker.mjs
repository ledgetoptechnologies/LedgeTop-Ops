import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repositoryRoot, 'public', 'potree', 'build', 'potree', 'workers');
const workerName = 'EptLazRsDecoderWorker.js';

if (!fs.existsSync(path.join(repositoryRoot, 'public', 'potree', 'build', 'potree', 'potree.js'))) {
  throw new Error('pinned Potree build must be copied before building the EPT worker');
}
for (const name of fs.readdirSync(outDir)) {
  if (/^laz_rs_wasm_bg-.*\.wasm$/.test(name)) fs.rmSync(path.join(outDir, name));
}

await build({
  configFile: false,
  base: './',
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: false,
    target: 'es2022',
    minify: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: path.join(repositoryRoot, 'ept-lazrs-worker.mjs'),
      output: {
        format: 'es',
        entryFileNames: workerName,
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
});

const workerPath = path.join(outDir, workerName);
const workerSource = fs.existsSync(workerPath) ? fs.readFileSync(workerPath, 'utf8') : '';
const relativeWasmReference = /new URL\(`laz_rs_wasm_bg-[^`]+\.wasm`,import\.meta\.url\)/.test(workerSource);
if (!workerSource.includes('EPT LAZ-RS decode failed')
  || workerSource.includes('data:application/wasm;base64,') || !relativeWasmReference) {
  throw new Error('EPT LAZ-RS worker bundle was not produced');
}
const externalWasm = fs.readdirSync(outDir).filter((name) => /^laz_rs_wasm_bg-.*\.wasm$/.test(name));
if (externalWasm.length !== 1 || fs.statSync(path.join(outDir, externalWasm[0])).size < 1000) {
  throw new Error('EPT LAZ-RS worker must emit one WASM payload');
}
