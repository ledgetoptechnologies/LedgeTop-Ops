'use strict';
const fs = require('node:fs');
const { openDatabase } = require('../../server/database');
const { ProcessingRepository } = require('../../server/processingRepository');
const { DerivativeRecovery } = require('../../server/derivativeRecovery');
const { stageDerivativeSupplement } = require('../../server/derivativeSupplementIntake');
const pieces = []; let bytes = 0;
process.stdin.on('data', piece => { bytes += piece.length; if (bytes > 1024 * 1024) process.exit(72); pieces.push(piece); });
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(Buffer.concat(pieces).toString('utf8'));
    if (input.crashPhase === 'manifest-link' || input.crashPhase === 'complete-link') {
      const link = fs.linkSync, suffix = input.crashPhase === 'manifest-link' ? '.manifest.json' : '.complete.json';
      fs.linkSync = (...args) => { const result = link(...args); if (String(args[1]).endsWith(suffix)) process.exit(75); return result; };
    }
    const db = openDatabase(input.database), service = new DerivativeRecovery(new ProcessingRepository(db));
    await stageDerivativeSupplement({ service, storage: { roots: { models: input.modelsRoot }, requireSpace() {} },
      operationId: input.operationId, owner: input.owner, leaseToken: input.leaseToken, manifest: input.manifest,
      environment: 'STAGING', assertWriteAdmission: () => true,
      readFile: async function* ({ file }) {
        const data = Buffer.from(input.contents[file.relativePath]);
        if (input.crashPhase !== 'payload') { yield data; return; }
        yield data.subarray(0, 1);
        // The receiver has written this byte before requesting another chunk.
        // Exit bypasses JS cleanup; the parent must observe/reap this child.
        process.exit(73);
      } });
    process.exitCode = 74;
  } catch (error) { process.stderr.write(String(error.code || 'unexpected_crash_fixture_error')); process.exitCode = 1; }
});
