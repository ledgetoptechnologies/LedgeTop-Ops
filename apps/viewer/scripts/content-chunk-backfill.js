#!/usr/bin/env node
'use strict';

// Shows or holds the worker's content-chunk backfill. Prints counts only.
//
//   node scripts/content-chunk-backfill.js status
//   node scripts/content-chunk-backfill.js pause
//   node scripts/content-chunk-backfill.js resume
//
// A pause takes effect within about a second, also in the middle of a file,
// and survives restarts. It never migrates or opens anything but the database.

const { DatabaseSync } = require('node:sqlite');
const { config } = require('../server/config');
const { contentChunkReport, setPaused } = require('../server/contentChunkBackfill');

function main(command) {
  if (!['status', 'pause', 'resume'].includes(command)) throw new Error('use: status | pause | resume');
  const database = new DatabaseSync(config.databasePath, { readOnly: command === 'status' });
  try {
    database.exec('PRAGMA busy_timeout=5000');
    if (command !== 'status') setPaused(database, command === 'pause');
    console.log(JSON.stringify(contentChunkReport(database), null, 2));
  } finally { database.close(); }
}

try { main(process.argv[2]); }
catch (error) { console.error(error.message); process.exitCode = 1; }
