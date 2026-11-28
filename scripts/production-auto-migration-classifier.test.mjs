import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyMigrationSequence, loadWranglerMigrationSplitter, readSourceMigrations, MIGRATION_CLASSIFIER_VERSION,
  PERMISSION_TABLE_PATTERN } from './production-auto-migration-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const split = await loadWranglerMigrationSplitter(ROOT);
const BASE = { name: '0001_base.sql', sql: `PRAGMA foreign_keys = ON;
CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE staff_roles (id TEXT PRIMARY KEY, role TEXT NOT NULL);
INSERT INTO clients (id, name) VALUES ('c1', 'one');` };
const classify = sql => classifyMigrationSequence({ files: [BASE, { name: '0002_change.sql', sql }], split })[1];
const auto = sql => { const r = classify(sql); assert.equal(r.automatic, true, `${sql}\n${r.reasons.join(',')}`); return r; };
const review = (sql, reason) => {
  const r = classify(sql);
  assert.equal(r.additive, false, sql); assert.equal(r.automatic, false, sql);
  if (reason) assert.ok(r.reasons.includes(reason), `${reason} not in ${r.reasons.join(',')}`);
  return r;
};

test('every historical migration keeps its reviewed classification (new files must be added to the pinned table)', async () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/production-auto-migration-classification-expected.json', import.meta.url), 'utf8'));
  assert.equal(expected.classifierVersion, MIGRATION_CLASSIFIER_VERSION);
  for (const app of ['operations', 'client']) {
    const actual = classifyMigrationSequence({ files: await readSourceMigrations(ROOT, app), split })
      .map(r => ({ name: r.name, automatic: r.automatic, additive: r.additive, permission: r.permission, permissionTables: [...r.permissionTables] }));
    assert.deepEqual(actual, expected[app], `${app}: regenerate and review the pinned classification table`);
  }
  // Anchors from the reviewed plan.
  const ops = Object.fromEntries(expected.operations.map(row => [row.name.slice(0, 4), row]));
  const client = Object.fromEntries(expected.client.map(row => [row.name.slice(0, 4), row]));
  assert.equal(ops['0240'].automatic, false); assert.equal(ops['0240'].permission, true, 'Ops 0240 changes permissions');
  assert.equal(client['0243'].additive, false, 'Client 0243 rewrites an existing trigger');
  assert.equal(client['0243'].permission, true, 'Client 0243 touches viewer_direct_client_grants');
});

test('additive forms apply automatically', () => {
  auto('CREATE TABLE audit_notes (id TEXT PRIMARY KEY, body TEXT);');
  auto('CREATE TABLE audit_notes (id TEXT PRIMARY KEY, body TEXT); CREATE UNIQUE INDEX audit_notes_body ON audit_notes(body);');
  auto('CREATE INDEX clients_name ON clients(name);');
  auto('ALTER TABLE clients ADD COLUMN notes TEXT;');
  auto("CREATE TABLE audit_notes (id TEXT PRIMARY KEY); INSERT INTO audit_notes (id) VALUES ('seed');");
  auto('CREATE VIEW client_names AS SELECT name FROM clients;');
  auto("PRAGMA foreign_keys = ON;\nCREATE TABLE audit_notes (id TEXT PRIMARY KEY);");
  // A guard trigger on a table created in the same file whose body only raises.
  auto(`CREATE TABLE audit_notes (id TEXT PRIMARY KEY);
CREATE TRIGGER audit_notes_immutable BEFORE UPDATE ON audit_notes BEGIN SELECT RAISE(ABORT, 'immutable'); END;`);
});

test('anything that can change existing data or objects needs review', () => {
  review('DROP TABLE clients;');
  review('ALTER TABLE clients RENAME TO customers;');
  review('ALTER TABLE clients DROP COLUMN name;');
  review('ALTER TABLE clients ADD COLUMN code TEXT NOT NULL;');
  review("UPDATE clients SET name = 'x';", 'action_update');
  review('DELETE FROM clients;', 'action_delete');
  review("INSERT INTO clients (id, name) VALUES ('c2', 'two');", 'insert_into_existing_table');
  review("INSERT OR REPLACE INTO clients (id, name) VALUES ('c1', 'x');");
  review("CREATE TABLE audit_notes (id TEXT PRIMARY KEY); INSERT INTO audit_notes (id) VALUES ('a') ON CONFLICT DO NOTHING;");
  review('CREATE UNIQUE INDEX clients_name ON clients(name);', 'unique_index_on_existing_table');
  review('CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY);');
  review('CREATE TABLE client_copy AS SELECT * FROM clients;');
  review('CREATE TRIGGER clients_guard BEFORE DELETE ON clients BEGIN SELECT RAISE(ABORT, \'no\'); END;', 'trigger_on_existing_table');
  review(`CREATE TABLE audit_notes (id TEXT PRIMARY KEY);
CREATE TRIGGER audit_notes_copy AFTER INSERT ON audit_notes BEGIN UPDATE clients SET name = NEW.id; END;`, 'trigger_not_guard');
  review('PRAGMA foreign_keys = OFF;');
  review('VACUUM;');
  review('CREATE TABLE d1_migrations_shadow (id INTEGER); DROP TABLE d1_migrations_shadow;');
  review('INSERT INTO d1_migrations (name) VALUES (\'0999_fake.sql\');');
  review('');
});

test('a permission-type table makes even an additive file wait for review', () => {
  const created = classify('CREATE TABLE project_grants (id TEXT PRIMARY KEY);');
  assert.equal(created.additive, true); assert.equal(created.permission, true); assert.equal(created.automatic, false);
  assert.deepEqual(created.permissionTables, ['project_grants']);
  const altered = classify('ALTER TABLE staff_roles ADD COLUMN scope TEXT;');
  assert.equal(altered.additive, true); assert.equal(altered.automatic, false); assert.deepEqual(altered.permissionTables, ['staff_roles']);
  for (const name of ['permissions', 'role_permissions', 'staff', 'client_delegations', 'viewer_shares', 'acl', 'memberships', 'bindings'])
    assert.ok(PERMISSION_TABLE_PATTERN.test(name), name);
  for (const name of ['clients', 'invoices', 'staffing_notes_view'.replace('_view', 'x')]) assert.equal(PERMISSION_TABLE_PATTERN.test(name), false, name);
});

test('classification is pure: earlier files are replayed, nothing outside memory is touched', () => {
  const files = [BASE, { name: '0002_a.sql', sql: 'CREATE TABLE a (id TEXT);' }, { name: '0003_b.sql', sql: 'CREATE INDEX a_id ON a(id);' }];
  const first = classifyMigrationSequence({ files, split }), second = classifyMigrationSequence({ files, split });
  assert.deepEqual(first, second);
  assert.equal(first[2].automatic, true, 'the index sees the table created by the earlier file');
  assert.throws(() => classifyMigrationSequence({ files: [{ name: 'x' }], split }), /input_invalid/u);
});

test('review regressions: hidden trigger writes, defaults on existing rows, constraints, dependent triggers, wider permission names', () => {
  // A '--' or '/*' inside a RAISE message must not hide a write that follows.
  review(`CREATE TABLE audit_notes (id TEXT PRIMARY KEY);
CREATE TRIGGER audit_notes_g AFTER INSERT ON audit_notes BEGIN SELECT RAISE(ABORT,'--'); UPDATE staff_roles SET role='admin';
END;`, 'trigger_not_guard');
  review(`CREATE TABLE audit_notes (id TEXT PRIMARY KEY);
CREATE TRIGGER audit_notes_g AFTER INSERT ON audit_notes BEGIN SELECT RAISE(ABORT,'/*'); UPDATE staff_roles SET role='admin'; SELECT '*/'; END;`, 'trigger_not_guard');
  review(`CREATE TABLE audit_notes (id TEXT PRIMARY KEY);
CREATE TRIGGER audit_notes_g BEFORE INSERT ON audit_notes BEGIN SELECT RAISE(IGNORE); END;`, 'trigger_not_guard');
  // A default is written into every existing row.
  review('ALTER TABLE clients ADD COLUMN can_download INTEGER NOT NULL DEFAULT 1;', 'added_column_default_on_existing_rows');
  review("ALTER TABLE clients ADD COLUMN tier TEXT DEFAULT 'basic';", 'added_column_default_on_existing_rows');
  // REFERENCES/CHECK on an added column.
  review('ALTER TABLE clients ADD COLUMN role_id TEXT REFERENCES staff_roles(id) ON DELETE CASCADE;', 'added_column_constraint');
  review("ALTER TABLE clients ADD COLUMN kind TEXT CHECK (kind IN ('a','b'));", 'added_column_constraint');
  // An existing trigger over the altered table.
  const withTrigger = classifyMigrationSequence({ files: [BASE,
    { name: '0002_t.sql', sql: "CREATE TRIGGER clients_ins AFTER INSERT ON clients BEGIN SELECT RAISE(ABORT, 'x') WHERE NEW.name = ''; END;" },
    { name: '0003_c.sql', sql: 'ALTER TABLE clients ADD COLUMN notes TEXT;' }], split })[2];
  assert.ok(withTrigger.reasons.includes('altered_table_has_triggers_or_views'));
  // Authorization tables beyond the original list, and access-named columns.
  for (const name of ['api_keys', 'pa_users', 'portal_v2_identities', 'portal_v2_entitlements', 'portal_v2_invitations',
    'portal_v2_root_access_policies', 'pa_portal_projection_contact_assignments', 'viewer_sessions', 'x_oauth_states', 'enrollments'])
    assert.ok(PERMISSION_TABLE_PATTERN.test(name), name);
  const access = classify('ALTER TABLE clients ADD COLUMN can_view TEXT;');
  assert.equal(access.permission, true); assert.equal(access.automatic, false);
  const view = classify('CREATE VIEW effective_permissions AS SELECT id FROM clients;');
  assert.equal(view.permission, true); assert.equal(view.automatic, false);
});
