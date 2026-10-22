#!/usr/bin/env node

import path from 'node:path';
import { auditFailureExitCode, writeLodProvenance } from './lib/lod-equivalence.mjs';

function usage() {
  console.error('Usage: npm run audit:lod -- <derivative-directory> <source.glb> [--tolerance <model-units>] [--external-source] [--controlled-obj2tiles <source.obj> <Obj2Tiles-binary>] [--converter-serial-retry]');
}

async function main() {
  const args = process.argv.slice(2);
  const derivativeDir = args.shift();
  const sourceGlb = args.shift();
  let tolerance;
  let allowExternalSource = false;
  let controlledObj2Tiles = false;
  let converterInput;
  let converterBinary;
  let converterSerialRetry = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--tolerance' && args.length) tolerance = Number(args.shift());
    else if (flag === '--external-source') allowExternalSource = true;
    else if (flag === '--controlled-obj2tiles' && args.length >= 2) {
      controlledObj2Tiles = true;
      converterInput = args.shift();
      converterBinary = args.shift();
    }
    else if (flag === '--converter-serial-retry' && controlledObj2Tiles) converterSerialRetry = true;
    else throw new Error(`unknown or incomplete argument: ${flag}`);
  }
  if (!derivativeDir || !sourceGlb) {
    usage();
    process.exitCode = 2;
    return;
  }
  const result = await writeLodProvenance({
    derivativeDir: path.resolve(derivativeDir),
    sourceGlb: path.resolve(sourceGlb),
    allowExternalSource,
    controlledObj2Tiles,
    converterSerialRetry,
    ...(converterInput ? { converterInput: path.resolve(converterInput) } : {}),
    ...(converterBinary ? { converterBinary: path.resolve(converterBinary) } : {}),
    ...(tolerance === undefined ? {} : { tolerance }),
  });
  console.log(JSON.stringify({ valid: true, output: result.outputPath, audit: result.provenance.audit }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    valid: false,
    error: error.message,
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
  }, null, 2));
  process.exitCode = auditFailureExitCode(error);
}
