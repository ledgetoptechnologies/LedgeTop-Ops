#!/usr/bin/env node
// Trusted host request only. No web route, admission, readiness mutation or
// reconstruction. The owner keeps immutable custody and bounds this process
// and ALL descendants; the parent lease owner must remain responsive.
import fs from 'node:fs';
import path from 'node:path';
import { proveRecoveryCandidate } from './lib/recovery-candidate-proof.mjs';
const abort = new AbortController();
const stop = ()=>abort.abort(new Error('stopped'));
process.once('SIGTERM',stop); process.once('SIGINT',stop);
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--request' || !path.isAbsolute(args[1])) throw Error('arguments');
  const file = await fs.promises.open(args[1],fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  let request;
  try {
    const before = await file.stat({bigint:true});
    if (!before.isFile() || before.size <= 0n || before.size > 65536n) throw Error('request');
    const bytes = Buffer.alloc(Number(before.size)); let at = 0;
    while (at < bytes.length) {const read = await file.read(bytes,at,bytes.length-at,at); if (!read.bytesRead) throw Error('request'); at+=read.bytesRead;}
    const after = await file.stat({bigint:true});
    if (['dev','ino','mode','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key])) throw Error('request');
    request = JSON.parse(bytes.toString('utf8'));
  } finally {await file.close();}
  const result = await proveRecoveryCandidate(request,{signal:abort.signal});
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = /^(?:lod_texture|recovery_proof|recovery_render)_[a-z0-9_]{1,80}$/.test(error?.code || '')
    ? error.code : 'recovery_proof_failed';
  process.stdout.write(`${JSON.stringify({schemaVersion:1,scope:'recovery-candidate-independent-evidence-v1',
    error:code,calibrationRequired:true,ready:false})}\n`);
  process.exitCode = 1;
} finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
