import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import converterPolicy from '../../lod-converter-policy.cjs';
import { proveTextureOutput } from './texture-output-proof.mjs';
import { bindRecoveryRenderArtifacts } from './recovery-render-provenance.mjs';

const RAW_SCRIPT = fileURLToPath(new URL('../verify_recovery_raw_uv.py',import.meta.url));
const fail = code => { throw Object.assign(new Error(code),{code:`recovery_proof_${code}`}); };
const require = (value,code) => { if (!value) fail(code); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && !value.includes('\0');

export function validateRecoveryProofRequest(request) {
  const keys = ['schemaVersion','mode','output','sourceObj','sourceGlb','converterBinary','basisJavascript','basisWasm',
    'sourceObjSha256','sourceGlbSha256','converterBinarySha256','converterSerialRetry'].sort();
  require(request && !Array.isArray(request) && Object.keys(request).sort().join('|') === keys.join('|')
    && request.schemaVersion === 1 && ['prepare','verify'].includes(request.mode)
    && ['output','sourceObj','sourceGlb','converterBinary','basisJavascript','basisWasm'].every(key => absolute(request[key]))
    && ['sourceObjSha256','sourceGlbSha256','converterBinarySha256'].every(key => digest(request[key]))
    && typeof request.converterSerialRetry === 'boolean', 'request');
  const command = request.converterSerialRetry ? converterPolicy.SERIAL_RETRY_CONVERTER_COMMAND_SHA256
    : converterPolicy.CONTROLLED_CONVERTER_COMMAND_SHA256;
  require(converterPolicy.acceptedConverterBinaryCommand(command,request.converterBinarySha256), 'converter');
  return Object.freeze({...request});
}

// All heavy work runs INSIDE this owner-admitted one-shot proof child. Its
// parent must keep the immutable custody fence and heartbeat alive, and enforce
// one cgroup/process-tree deadline through final child reap. No host admission,
// reconstruction, output mutation, network access or ready/ACK is done here.
export async function proveRecoveryCandidate(request, {signal = null,python = '/usr/bin/python3',timeoutMs = 1800000} = {}) {
  signal?.throwIfAborted();
  const input = validateRecoveryProofRequest(request);
  require(absolute(python) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1800000, 'runtime');
  const check = () => signal?.throwIfAborted(); check();
  async function sourceHash(filename,expected) {
    check(); require(await fs.promises.realpath(filename) === filename, 'source_link');
    const file = await fs.promises.open(filename,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const before = await file.stat({bigint:true});
      require(before.isFile() && before.size > 0n && before.size <= 2n * 1024n ** 3n, 'source_budget');
      const digest = crypto.createHash('sha256'), bytes = Buffer.alloc(1024 ** 2); let offset = 0;
      while (offset < Number(before.size)) {
        check(); const got = await file.read(bytes,0,Math.min(bytes.length,Number(before.size)-offset),offset);
        require(got.bytesRead > 0,'source_short'); offset += got.bytesRead; digest.update(bytes.subarray(0,got.bytesRead));
      }
      const after = await file.stat({bigint:true});
      require(['dev','ino','mode','size','mtimeNs','ctimeNs'].every(key => before[key] === after[key])
        && digest.digest('hex') === expected,'source_changed');
    } finally { await file.close(); }
  }
  async function sources() {
    // Sequential I/O bounds memory and avoids contending with other sessions.
    await sourceHash(input.sourceObj,input.sourceObjSha256);
    await sourceHash(input.sourceGlb,input.sourceGlbSha256);
    await sourceHash(input.converterBinary,input.converterBinarySha256);
  }
  await sources();
  // Dynamic import avoids loading native geometry dependencies for CLI guards.
  const {auditControlledObj2Tiles} = await import('./lod-equivalence.mjs');
  check();
  const geometry = await auditControlledObj2Tiles({ derivativeDir:input.output,sourceGlb:input.sourceGlb,
    converterInput:input.sourceObj,converterBinary:input.converterBinary,allowExternalSource:true,
    converterSerialRetry:input.converterSerialRetry,trustedConverterBinarySha256:[input.converterBinarySha256] });
  check();
  require(geometry.sourceSha256 === input.sourceGlbSha256 && geometry.converter?.inputSha256 === input.sourceObjSha256
    && geometry.converter.binarySha256 === input.converterBinarySha256,'geometry_binding');
  const textures = await proveTextureOutput({ output:input.output,basisJavascript:input.basisJavascript,
    basisWasm:input.basisWasm,signal,python });
  const inventoryBytes = Buffer.from(JSON.stringify(textures.expectedLod0Inventory));
  require(hash(inventoryBytes) === textures.expectedLod0InventorySha256,'inventory_binding');
  const temporaryRoot = await fs.promises.realpath(os.tmpdir());
  const scratch = await fs.promises.mkdtemp(path.join(temporaryRoot,'ltds-recovery-proof-'));
  let raw,rawStdoutSha256;
  try {
    await fs.promises.chmod(scratch,0o700);
    const inventoryFile = path.join(scratch,'reachable-lod0.json');
    await fs.promises.writeFile(inventoryFile,inventoryBytes,{flag:'wx',mode:0o400});
    const child = spawn(python,[RAW_SCRIPT,'--source-obj',input.sourceObj,'--output',input.output,
      '--expected-source-sha256',input.sourceObjSha256,'--expected-lod0-inventory',inventoryFile],
    {cwd:scratch,stdio:['ignore','pipe','pipe'],windowsHide:true,env:{PATH:'/usr/bin:/bin',TMPDIR:scratch,
      PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',GDAL_PAM_ENABLED:'NO',GDAL_DISABLE_READDIR_ON_OPEN:'EMPTY_DIR',
      GDAL_NUM_THREADS:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
    let closed = false,problem = null,killTimer,stdoutBytes = 0,stderrBytes = 0; const chunks = [];
    const done = new Promise(resolve => {
      child.once('error',()=>{problem ||= 'raw_unavailable';});
      child.once('close',(code,killedBy)=>{closed=true;resolve({code,killedBy});});
    });
    const stop = code => {
      problem ||= code;
      if (!closed) { child.kill('SIGTERM'); killTimer ??= setTimeout(()=>{if (!closed) child.kill('SIGKILL');},2000); }
    };
    const abort = ()=>stop('cancelled'); signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    const timer = setTimeout(()=>stop('raw_timeout'),timeoutMs);
    child.stdout.on('data',bytes=>{stdoutBytes+=bytes.length; if (stdoutBytes > 1024 ** 2) stop('raw_receipt_budget'); else chunks.push(bytes);});
    child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;if (stderrBytes > 4096) stop('raw_stderr_budget');});
    try {
      const status = await done; check();
      if (problem) fail(problem);
      require(status.code === 0 && !status.killedBy,'raw_failed');
      const bytes = Buffer.concat(chunks); rawStdoutSha256 = hash(bytes);
      try {raw=JSON.parse(bytes.toString('utf8'));} catch {fail('raw_receipt');}
    } finally {
      if (!closed) stop('raw_stopped');
      await done; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort',abort);
    }
  } finally {
    // Only this mkdtemp-owned private tree is removed, after the owned Python
    // process has exited. The input/output roots are never cleanup targets.
    require(path.dirname(scratch) === temporaryRoot && /^ltds-recovery-proof-[A-Za-z0-9]+$/.test(path.basename(scratch)),'scratch_identity');
    await fs.promises.rm(scratch,{recursive:true,force:true});
  }
  check();
  require(raw?.schemaVersion === 1 && raw.scope === 'recovery-lod0-raw-atlas-and-source-uv-association-v1'
    && raw.sourceObjSha256 === input.sourceObjSha256 && raw.expectedLod0InventorySha256 === textures.expectedLod0InventorySha256
    && raw.lod0Tiles === textures.lod0Contents && raw.rawFaceRecords === textures.declaredTriangles
    && raw.rawAtlasPixelEqualityVerified === true && raw.sourceUvAssociationVerified === true
    && raw.reachableLod0ProofInventoryVerified === true && raw.retainedInputsFinalCheckCompleted === true
    && raw.sourceUv?.retainedProofInputsFinalCheckCompleted === true && digest(raw.receiptSha256),'raw_binding');
  const provenance = bindRecoveryRenderArtifacts(geometry,textures);
  if (input.mode === 'verify') {
    const filename = path.join(input.output,'lod-provenance.json');
    require(await fs.promises.realpath(filename) === filename,'provenance_link');
    const file = await fs.promises.open(filename,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const stat = await file.stat();
      require(stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024 ** 2,'provenance_budget');
      const stored = JSON.parse(await file.readFile('utf8'));
      require(converterPolicy.stable(stored) === converterPolicy.stable(provenance),'provenance_changed');
    } finally {await file.close();}
  }
  await sources(); check();
  const result = {schemaVersion:1,scope:'recovery-candidate-independent-evidence-v1',mode:input.mode,
    sourceObjSha256:input.sourceObjSha256,sourceGlbSha256:input.sourceGlbSha256,
    converterBinarySha256:input.converterBinarySha256,provenance,rawProof:raw,rawProofStdoutSha256:rawStdoutSha256,
    textures:{tilesetSha256:textures.tilesetSha256,expectedLod0InventorySha256:textures.expectedLod0InventorySha256,
      renderContents:textures.renderContents,lod0Contents:textures.lod0Contents,images:textures.images,mips:textures.mips,
      declaredTriangles:textures.declaredTriangles,comparedPixels:textures.comparedPixels,
      orderedImageMetricsSha256:textures.orderedImageMetricsSha256,basisPins:textures.basisPins,policy:textures.policy},
    checks:{geometry:true,sourceUvCoverage:true,atlasPixels:true,finalTextureCandidate:true},calibrationRequired:true,ready:false};
  require(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024 ** 2,'receipt_budget');
  return result;
}
