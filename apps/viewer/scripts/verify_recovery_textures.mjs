#!/usr/bin/env node
// One-shot, read-only relation component. The owner MUST supply immutable input
// mounts and enforce memory, time and process-tree limits externally. This is
// deliberately not an HTTP endpoint or a recovery admission/ready operation.
import { proveTextureOutput } from './lib/texture-output-proof.mjs';

const abort = new AbortController();
const stop = () => abort.abort(new Error('stopped'));
process.once('SIGTERM',stop); process.once('SIGINT',stop);
try {
  const args = process.argv.slice(2), options = new Map();
  if (args.length !== 6) throw Error('arguments');
  for (let at = 0; at < args.length; at += 2) {
    if (!['--output','--basis-javascript','--basis-wasm'].includes(args[at]) || options.has(args[at])) throw Error('arguments');
    options.set(args[at],args[at+1]);
  }
  const result = await proveTextureOutput({ output:options.get('--output'),basisJavascript:options.get('--basis-javascript'),
    basisWasm:options.get('--basis-wasm'),signal:abort.signal });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // OS/GDAL/model exceptions can contain private paths. Never forward them.
  const code = /^lod_texture_[a-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'lod_texture_output_proof_failed';
  process.stdout.write(`${JSON.stringify({schemaVersion:1,scope:'full-render-mip-decode-and-lod0-photographic-relation-v1',
    error:code,candidatePass:false,calibrationRequired:true,ready:false})}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM',stop); process.removeListener('SIGINT',stop);
}
