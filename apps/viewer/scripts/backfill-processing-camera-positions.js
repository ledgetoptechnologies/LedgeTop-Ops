#!/usr/bin/env node
'use strict';

// Registers ODM camera positions (odm_report/shots.geojson) and photo links for
// processing attempts ingested before the ingest step registered them.
//
//   node scripts/backfill-processing-camera-positions.js --attempt <id> [--attempt <id> ...]
//   node scripts/backfill-processing-camera-positions.js --apply --attempt <id> ...
//
// Without --apply nothing is written. Re-running is safe: versions that already
// have camera positions and photo links are reported as already_present.
// The shots asset is added unpublished; a ready_for_review attempt shows it in
// review and offers it at publish. Undo statements are printed for each change.

const path = require('node:path');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');
const { backfillProcessingCameraPositions, undoStatements } = require('../server/processingCameraBackfill');

function parseArgs(argv) {
  const options = { apply: false, attemptIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--attempt' && argv[index + 1]) options.attemptIds.push(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.attemptIds.length) throw new Error('pass at least one --attempt <id>');
  if (options.attemptIds.some((id) => !/^[A-Za-z0-9-]{1,128}$/.test(id))) throw new Error('invalid attempt id');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const database = openDatabase(config.databasePath);
  try {
    const results = await backfillProcessingCameraPositions({
      database,
      processing: new ProcessingRepository(database),
      repository: new ViewerRepository(database),
      storage: new StorageManager(config),
      attemptIds: options.attemptIds,
      apply: options.apply,
    });
    for (const result of results) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      const undo = result.status === 'registered' ? undoStatements(result.modelVersionId)
        : result.status === 'photos_linked' ? undoStatements(result.modelVersionId).slice(0, 1) : [];
      for (const statement of undo) process.stdout.write(`  undo: ${statement}\n`);
    }
    if (!options.apply) process.stdout.write('dry run: nothing was written (pass --apply to write)\n');
  } finally {
    database.close();
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${path.basename(__filename)}: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { parseArgs };
