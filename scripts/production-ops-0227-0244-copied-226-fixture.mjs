// Offline builder, pin generator and verifier for the disposable "copied-226"
// rehearsal profile of the Ops 0227..0244 ordered apply: a local SQLite file at
// exactly ledger 226, built from this repository's own migrations 0001..0226 with
// the same Wrangler splitter the operator uses. It never contacts Cloudflare.
//
//   node scripts/production-ops-0227-0244-copied-226-fixture.mjs                  compare pins with a fresh derivation
//   node scripts/production-ops-0227-0244-copied-226-fixture.mjs --write          rewrite the committed pins
//   node scripts/production-ops-0227-0244-copied-226-fixture.mjs --build <file>   build a new disposable file and verify it
//   node scripts/production-ops-0227-0244-copied-226-fixture.mjs --verify <file>  verify an existing file (read-only)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  OPS_0227_0244_PRE_READ_QUERY, OPS_0227_0244_PRIOR_LEDGER, OPS_0227_0244_SCHEMA_ROWS_SQL, OPS_0244_CATALOG_PERMISSION_KEYS,
  loadVerifiedOps0227To0244Plan, ops0227To0244ExistingSchema, parseOps0227To0244SnapshotResult,
} from './production-ops-0227-0244-ordered-once.mjs';
import { buildOpsChainDatabase, ledgerNamesSha256, migrationNames, schemaRowsSha256 } from './production-ops-0227-0244-wire-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OPS_COPIED_226_PINS_RELATIVE = 'scripts/fixtures/production-ops-copied-226-profile.json';
export const OPS_COPIED_226_PINS_PATH = path.join(ROOT, ...OPS_COPIED_226_PINS_RELATIVE.split('/'));
export const OPS_COPIED_226_CONTRACT = 'production-ops-copied-226-profile-v1';
const COUNT = OPS_0227_0244_PRIOR_LEDGER.count;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(`ops_copied_226:${code}`); };

/** Every 0244 preflight value the rehearsal copy must show at ledger 226 (same keys as the operator's probes). */
export const OPS_COPIED_226_REQUIRED_PROBES = Object.freeze({
  ownerAdminRoles: 2, flightLogsPermissions: 0, flightLogsRolePermissions: 0, claimedOnboarding: 0,
  staffLoginPrerequisiteTables: 3, catalogPermissionKeys: 15, nativeHireOverrides: 0, nativeHires: 0,
  nativeStaffReconciliationRows: 1, nativeStaffReconciliationEnabled: 0, staffUsersViewColumns: 5, ledgerSequence: COUNT,
});

/** Reads one file exactly as the operator reads D1: the pinned snapshot SELECT plus the schema-row SELECT. */
export function readOps226Profile(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = { ...db.prepare(OPS_0227_0244_PRE_READ_QUERY).get() };
    const schemaRows = db.prepare(OPS_0227_0244_SCHEMA_ROWS_SQL).all().map(item => ({ ...item }));
    const meta = { rows_written: 0, changed_db: false, served_by_primary: true };
    const snapshot = parseOps0227To0244SnapshotResult([{ success: true, results: [row], meta },
      { success: true, results: schemaRows, meta }], { observedAt: new Date(0).toISOString() });
    const catalogPresent = db.prepare(`SELECT key FROM permissions WHERE key IN (${OPS_0244_CATALOG_PERMISSION_KEYS.map(() => '?').join(',')}) ORDER BY key`)
      .all(...OPS_0244_CATALOG_PERMISSION_KEYS).map(item => item.key);
    return { snapshot, catalogPresent };
  } finally { db.close(); }
}

/** The profile a file presents, in the same shape as the committed pins (minus the source inventory). */
export function ops226ProfileOf(filename, { plan = loadVerifiedOps0227To0244Plan() } = {}) {
  const { snapshot, catalogPresent } = readOps226Profile(filename);
  const names = snapshot.ledger.map(row => row.name);
  const existing = ops0227To0244ExistingSchema(snapshot, plan);
  return {
    ledger: { count: snapshot.ledger.length, lastMigration: names.at(-1) ?? null, namesSha256: ledgerNamesSha256(names),
      idsContiguous: snapshot.ledger.every((row, index) => row.id === index + 1), sequence: snapshot.probes.ledgerSequence },
    schema: { objectCount: snapshot.schema.length, sha256: schemaRowsSha256(snapshot.schema) },
    existingSchema: existing,
    probes: { ...snapshot.probes },
    catalogPermissionKeysPresent: catalogPresent,
  };
}

/** Derives the pins from the source tree: builds a temporary copy, reads it back, deletes it. */
export function buildOpsCopied226Pins({ root = ROOT, tmpDir } = {}) {
  const names = migrationNames(root);
  if (names.length < COUNT || names[COUNT - 1] !== OPS_0227_0244_PRIOR_LEDGER.lastMigration) fail('source_inventory_unexpected');
  const migrations = names.slice(0, COUNT).map((name, index) => ({ id: index + 1, name,
    sha256: hash(fs.readFileSync(path.join(root, 'apps', 'operations', 'migrations', name))) }));
  const dir = fs.mkdtempSync(path.join(tmpDir ?? os.tmpdir(), 'ops-copied-226-'));
  try {
    const file = path.join(dir, 'copied-226.sqlite');
    buildOpsChainDatabase({ root, count: COUNT, filename: file }).close();
    const profile = ops226ProfileOf(file, { plan: loadVerifiedOps0227To0244Plan({ root }) });
    return {
      schemaVersion: 1, contract: OPS_COPIED_226_CONTRACT,
      migrationsDir: 'apps/operations/migrations',
      migrations,
      migrationsContentsSha256: hash(migrations.map(item => `${item.name}\0${item.sha256}`).join('\n')),
      ...profile,
      requiredProbes: { ...OPS_COPIED_226_REQUIRED_PROBES },
      seedRows: 'none beyond the migrations\' own seeds: 0001..0226 already seed the 15 catalog permission keys, the two owner/admin roles '
        + 'and the disabled native_staff_access_reconciliation singleton; staff_permission_overrides and native onboarding are empty',
    };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export const serializeOpsCopied226Pins = pins => `${JSON.stringify(pins, null, 2)}\n`;
export const loadOpsCopied226Pins = (file = OPS_COPIED_226_PINS_PATH) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Compares a file with the committed pins. Returns { ok, mismatches }. Read-only. */
export function verifyOpsCopied226File(filename, { pins = loadOpsCopied226Pins(), plan } = {}) {
  const observed = ops226ProfileOf(filename, plan ? { plan } : undefined);
  const mismatches = [];
  const same = (name, expected, actual) => { if (JSON.stringify(expected) !== JSON.stringify(actual)) mismatches.push({ name, expected, observed: actual }); };
  same('ledger', pins.ledger, observed.ledger);
  same('schema', pins.schema, observed.schema);
  same('existing_schema', pins.existingSchema, observed.existingSchema);
  same('probes', pins.probes, observed.probes);
  for (const [key, value] of Object.entries(pins.requiredProbes)) same(`required_probe:${key}`, value, observed.probes[key]);
  same('catalog_permission_keys_present', [...OPS_0244_CATALOG_PERMISSION_KEYS].sort(), observed.catalogPermissionKeysPresent);
  return { ok: mismatches.length === 0, mismatches, observed };
}

/** Builds a new disposable file (refuses to overwrite) after checking the source files match the pins byte for byte. */
export function buildOpsCopied226File(filename, { root = ROOT, pins = loadOpsCopied226Pins() } = {}) {
  if (fs.existsSync(filename)) fail('output_exists');
  const names = migrationNames(root).slice(0, COUNT);
  if (names.length !== pins.migrations.length) fail('source_migration_count_mismatch');
  for (const [index, pin] of pins.migrations.entries()) {
    if (names[index] !== pin.name) fail(`source_migration_name_mismatch:${pin.id}`);
    if (hash(fs.readFileSync(path.join(root, 'apps', 'operations', 'migrations', pin.name))) !== pin.sha256) fail(`source_migration_sha256_mismatch:${pin.name}`);
  }
  buildOpsChainDatabase({ root, count: COUNT, filename }).close();
  return verifyOpsCopied226File(filename, { pins });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const target = flag => { const value = args[args.indexOf(flag) + 1]; if (!value) fail(`${flag.slice(2)}_path_required`); return path.resolve(value); };
  if (args.includes('--build') || args.includes('--verify')) {
    const build = args.includes('--build');
    const file = target(build ? '--build' : '--verify');
    const result = build ? buildOpsCopied226File(file) : verifyOpsCopied226File(file);
    out({ file, mode: build ? 'build' : 'verify', ok: result.ok, mismatches: result.mismatches,
      ledger: result.observed.ledger, schema: result.observed.schema, existingSchema: result.observed.existingSchema });
    if (!result.ok) process.exitCode = 1;
  } else {
    const text = serializeOpsCopied226Pins(buildOpsCopied226Pins());
    if (args.includes('--write')) fs.writeFileSync(OPS_COPIED_226_PINS_PATH, text);
    const current = fs.existsSync(OPS_COPIED_226_PINS_PATH) ? fs.readFileSync(OPS_COPIED_226_PINS_PATH, 'utf8') : '';
    out({ pinsSha256: hash(Buffer.from(text)), matchesCommitted: current === text });
    if (current !== text) process.exitCode = 1;
  }
}
