// Offline tests for the pinned disposable "copied-226" rehearsal profile. No Cloudflare resource is contacted.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  OPS_COPIED_226_PINS_PATH, OPS_COPIED_226_REQUIRED_PROBES, buildOpsCopied226File, buildOpsCopied226Pins, loadOpsCopied226Pins,
  serializeOpsCopied226Pins, verifyOpsCopied226File,
} from './production-ops-0227-0244-copied-226-fixture.mjs';
import {
  OPS_0227_0244_PRE_READ_QUERY, OPS_0227_0244_PRIOR_LEDGER, OPS_0227_0244_SCHEMA_ROWS_SQL, OPS_0244_CATALOG_PERMISSION_KEYS,
  isOps0227To0244ReadQuery, loadVerifiedOps0227To0244Plan, parseOps0227To0244SnapshotResult, runOps0227To0244Ordered,
} from './production-ops-0227-0244-ordered-once.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-copied-226-test-'));
let built;
let counter = 0;

before(() => {
  built = path.join(tmp, 'copied-226.sqlite');
  const result = buildOpsCopied226File(built);
  assert.deepEqual(result.mismatches, []);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function copy() {
  const file = path.join(tmp, `copy-${++counter}.sqlite`);
  fs.copyFileSync(built, file);
  return file;
}
const mutate = (file, sql) => { const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); } };
const names = result => result.mismatches.map(item => item.name);

test('the committed pins equal a fresh derivation from the source tree', () => {
  const committed = fs.readFileSync(OPS_COPIED_226_PINS_PATH, 'utf8');
  assert.equal(serializeOpsCopied226Pins(buildOpsCopied226Pins({ tmpDir: tmp })), committed);
});

test('pins list exactly migrations 0001..0226 with their source SHA-256, matching the operator prior ledger', () => {
  const pins = loadOpsCopied226Pins();
  const source = fs.readdirSync(path.join(ROOT, 'apps/operations/migrations')).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(0, 226);
  assert.equal(pins.migrations.length, 226);
  assert.deepEqual(pins.migrations.map(item => item.name), source);
  assert.deepEqual(pins.migrations.map(item => item.id), source.map((_, index) => index + 1));
  for (const item of pins.migrations) assert.equal(item.sha256, hash(fs.readFileSync(path.join(ROOT, 'apps/operations/migrations', item.name))));
  assert.equal(pins.ledger.count, OPS_0227_0244_PRIOR_LEDGER.count);
  assert.equal(pins.ledger.lastMigration, OPS_0227_0244_PRIOR_LEDGER.lastMigration);
  assert.equal(pins.ledger.namesSha256, OPS_0227_0244_PRIOR_LEDGER.namesSha256);
  assert.equal(pins.ledger.sequence, 226);
  assert.equal(pins.ledger.idsContiguous, true);
  // At 226 none of the ten planned files' objects exist, so the whole schema is the "existing" schema.
  assert.deepEqual(pins.existingSchema, pins.schema);
  assert.deepEqual(pins.requiredProbes, { ...OPS_COPIED_226_REQUIRED_PROBES });
  for (const [key, value] of Object.entries(pins.requiredProbes)) assert.equal(pins.probes[key], value, key);
  assert.deepEqual(pins.catalogPermissionKeysPresent, [...OPS_0244_CATALOG_PERMISSION_KEYS].sort());
});

test('build refuses to overwrite an existing file', () => {
  assert.throws(() => buildOpsCopied226File(built), /ops_copied_226:output_exists/u);
});

test('build refuses when a source migration differs from its pin', () => {
  const pins = structuredClone(loadOpsCopied226Pins());
  pins.migrations[99].sha256 = '0'.repeat(64);
  assert.throws(() => buildOpsCopied226File(path.join(tmp, 'never.sqlite'), { pins }),
    new RegExp(`source_migration_sha256_mismatch:${pins.migrations[99].name}`, 'u'));
  assert.equal(fs.existsSync(path.join(tmp, 'never.sqlite')), false);
});

test('verify flags a missing catalog permission key', () => {
  const file = copy();
  mutate(file, "PRAGMA foreign_keys=OFF; DELETE FROM role_permissions WHERE permission_key='sops.assign'; DELETE FROM permissions WHERE key='sops.assign';");
  const result = verifyOpsCopied226File(file);
  assert.equal(result.ok, false);
  assert.ok(names(result).includes('required_probe:catalogPermissionKeys'));
  assert.ok(names(result).includes('catalog_permission_keys_present'));
});

test('verify flags an extra ledger row, a ledger past 226 and a schema object outside the pins', () => {
  const ahead = copy();
  mutate(ahead, "INSERT INTO d1_migrations(name) VALUES ('0227_owner_intel_reads.sql')");
  const a = verifyOpsCopied226File(ahead);
  assert.ok(names(a).includes('ledger') && names(a).includes('required_probe:ledgerSequence'));
  const drift = copy();
  mutate(drift, 'CREATE TABLE rehearsal_drift(x INTEGER)');
  const d = verifyOpsCopied226File(drift);
  assert.deepEqual(names(d).sort(), ['existing_schema', 'schema']);
});

test('verify flags the native sign-in switch turned on', () => {
  const file = copy();
  mutate(file, 'UPDATE native_staff_access_reconciliation SET enabled=1 WHERE singleton=1');
  assert.ok(names(verifyOpsCopied226File(file)).includes('required_probe:nativeStaffReconciliationEnabled'));
});

test('the operator dry run passes every preflight against the built copy and writes nothing', async () => {
  const file = copy();
  const before = fs.readFileSync(file);
  const provider = {
    async readSnapshot({ query }) {
      assert.ok(isOps0227To0244ReadQuery(query));
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const meta = { rows_written: 0, changed_db: false, served_by_primary: true };
        return parseOps0227To0244SnapshotResult([{ success: true, results: [{ ...db.prepare(query).get() }], meta },
          { success: true, results: db.prepare(OPS_0227_0244_SCHEMA_ROWS_SQL).all().map(row => ({ ...row })), meta }],
        { observedAt: new Date().toISOString() });
      } finally { db.close(); }
    },
  };
  assert.ok(isOps0227To0244ReadQuery(OPS_0227_0244_PRE_READ_QUERY));
  const result = await runOps0227To0244Ordered({ plan: loadVerifiedOps0227To0244Plan(), provider, mode: 'dry-run' });
  assert.equal(result.status, 'dry-run-passed', JSON.stringify(result.stop));
  assert.equal(result.writesPerformed, 0);
  assert.deepEqual(result.existingSchema, loadOpsCopied226Pins().existingSchema);
  assert.ok(fs.readFileSync(file).equals(before));
});
