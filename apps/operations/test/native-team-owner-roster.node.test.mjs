import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('roster ownership includes local/global owners and excludes sync immunity and division roles', () => {
  const source = readFileSync(new URL('../src/worker/index.ts', import.meta.url), 'utf8');
  const roster = source.slice(source.indexOf('app.get("/api/team/staff"'), source.indexOf('app.put("/api/admin/staff/:id/access-controls"'));
  const predicate = roster.match(/(\(EXISTS\(SELECT 1 FROM staff_role_assignments owner_assignment[\s\S]+?\)\)) owner_role,/);
  assert.ok(predicate, 'test the actual roster ownership predicate');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,sync_protected INTEGER);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
      CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
      INSERT INTO staff_users VALUES('native-with-sync-immunity',1),('local-owner',1),('inherited-owner',0),('division-owner',0),('ordinary',0);
      INSERT INTO local_staff_role_assignments VALUES('local-owner','role-owner','global'),('division-owner','role-owner','division');
      INSERT INTO staff_role_assignments VALUES('inherited-owner','role-owner','global');`);
    const result = db.prepare(`SELECT s.id,${predicate[1]} owner_role FROM staff_users s ORDER BY s.id`).all();
    assert.deepEqual(Object.fromEntries(result.map(row => [row.id, row.owner_role])), {
      'division-owner': 0, 'inherited-owner': 1, 'local-owner': 1, 'native-with-sync-immunity': 0, ordinary: 0,
    });
  } finally { db.close(); }
});
