'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REVISION_HEADER = 'X-LTDS-Viewer-Revision';
const SCHEMA_HEADER = 'X-LTDS-Viewer-Schema-Version';

function readRuntimeRevision(sourcePath = path.resolve(__dirname, '..', 'source-commit.txt')) {
  try {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const revision = fs.readFileSync(sourcePath, 'utf8').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(revision) ? revision : null;
  } catch {
    return null;
  }
}

function readSchemaVersion(database) {
  const version = Number(database.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get()?.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Viewer schema version is unavailable');
  return version;
}

function runtimeIdentity(database) {
  return Object.freeze({
    revision: readRuntimeRevision() || 'unavailable',
    schemaVersion: readSchemaVersion(database),
  });
}

function setRuntimeIdentityHeaders(response, identity) {
  response.setHeader(REVISION_HEADER, identity.revision);
  response.setHeader(SCHEMA_HEADER, String(identity.schemaVersion));
  return response;
}

module.exports = {
  REVISION_HEADER,
  SCHEMA_HEADER,
  readRuntimeRevision,
  readSchemaVersion,
  runtimeIdentity,
  setRuntimeIdentityHeaders,
};
