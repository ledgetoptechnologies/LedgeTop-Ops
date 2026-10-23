import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {assertCanonicalFileRunner} from './windows-files-canonical-runner.mjs';

const require = createRequire(new URL('../apps/client/package.json', import.meta.url));
const forms = ['where', 'case'];
// These are exclusively fixed test-source predicates/messages. This helper
// never accepts captured DDL, reads schema definitions or rewrites migrations.
function conditional(form, predicate, message) {
  assert.ok(forms.includes(form));
  return form === 'where'
    ? `SELECT RAISE(ABORT,'${message}') WHERE ${predicate};`
    : `SELECT CASE WHEN ${predicate} THEN RAISE(ABORT,'${message}') END;`;
}
async function mutation(db, sql, parameters, denied, message) {
  if (denied) await assert.rejects(db.prepare(sql).bind(...parameters).run(), error => {
    assert.ok(error.message.includes(message));
    return true;
  });
  else await db.prepare(sql).bind(...parameters).run();
}
async function rows(db, sql) { return (await db.prepare(sql).all()).results; }

test('fixed synthetic conditional RAISE forms agree in local D1 consistency cases only', async t => {
  assertCanonicalFileRunner();
  const {Miniflare} = require('miniflare');
  let networkAttempts = 0;
  const runtime = new Miniflare({modules:true, compatibilityDate:'2026-08-06', cf:false,
    script:"export default {fetch(){return new Response('synthetic-local-only')}}", d1Databases:['DB'],
    outboundService:() => { networkAttempts++; throw Error('conditional_raise_test_network_denied'); }});
  try {
    const db = await runtime.getD1Database('DB');
    await t.test('true and false numeric predicates, including SQL NULL, preserve rejection and insertion', async () => {
      const observations = [];
      for (const form of forms) {
        await db.prepare(`CREATE TABLE truth_${form}(id INTEGER PRIMARY KEY, flag INTEGER)`).run();
        await db.prepare(`CREATE TRIGGER truth_guard_${form} BEFORE INSERT ON truth_${form} BEGIN
          ${conditional(form, 'NEW.flag', 'synthetic-condition-denied')} END`).run();
        for (const [id, flag, denied] of [[1,1,true],[2,0,false],[3,null,false],[4,-1,true],[5,2,true]]) {
          await mutation(db, `INSERT INTO truth_${form}(id,flag) VALUES(?,?)`, [id,flag], denied, 'synthetic-condition-denied');
          assert.equal((await rows(db, `SELECT id FROM truth_${form} WHERE id=${id}`)).length, denied ? 0 : 1);
        }
        observations.push(await rows(db, `SELECT id,flag FROM truth_${form} ORDER BY id`));
      }
      assert.deepEqual(observations[0], [{id:2,flag:0},{id:3,flag:null}]);
      assert.deepEqual(observations[1], observations[0]);
    });
    await t.test('Ops0066-style staff subject, fence, NULL and length guards agree', async () => {
      const observations = [];
      for (const form of forms) {
        await db.prepare(`CREATE TABLE fence_${form}(mutation_id TEXT,actor_id TEXT,bound_access_subject TEXT)`).run();
        await db.prepare(`CREATE TABLE audit_${form}(id INTEGER PRIMARY KEY,actor_type TEXT,mutation_id TEXT,actor_id TEXT,original_verified_access_subject TEXT)`).run();
        for (const [id,actor,subject] of [['matched','staff-1','subject-1'],['null-fence','staff-1',null],['one','staff-1','x'],['max','staff-1','x'.repeat(191)]])
          await db.prepare(`INSERT INTO fence_${form} VALUES(?,?,?)`).bind(id,actor,subject).run();
        const predicate = `NEW.original_verified_access_subject IS NULL
          OR length(NEW.original_verified_access_subject) NOT BETWEEN 1 AND 191
          OR NOT EXISTS (SELECT 1 FROM fence_${form} fence WHERE fence.mutation_id=NEW.mutation_id
            AND fence.actor_id=NEW.actor_id AND fence.bound_access_subject=NEW.original_verified_access_subject)`;
        await db.prepare(`CREATE TRIGGER audit_guard_${form} BEFORE INSERT ON audit_${form} WHEN NEW.actor_type='staff' BEGIN
          ${conditional(form, predicate, 'synthetic-original-subject-denied')} END`).run();
        const cases = [
          ['staff','matched','staff-1','subject-1',false], ['system','absent','system-1',null,false],
          ['staff','matched','staff-1',null,true], ['staff','matched','staff-1','',true],
          ['staff','matched','staff-1','x'.repeat(192),true], ['staff','matched','staff-1','different',true],
          ['staff','absent','staff-1','subject-1',true], ['staff','null-fence','staff-1',null,true],
          ['staff','matched','different','subject-1',true], ['staff','one','staff-1','x',false],
          ['staff','max','staff-1','x'.repeat(191),false]
        ];
        for (const [index, values] of cases.entries()) {
          const [actorType,mutationId,actorId,subject,denied] = values;
          await mutation(db, `INSERT INTO audit_${form} VALUES(?,?,?,?,?)`, [index,actorType,mutationId,actorId,subject], denied, 'synthetic-original-subject-denied');
          assert.equal((await rows(db, `SELECT id FROM audit_${form} WHERE id=${index}`)).length, denied ? 0 : 1);
        }
        observations.push(await rows(db, `SELECT id,actor_type,mutation_id,actor_id,original_verified_access_subject FROM audit_${form} ORDER BY id`));
      }
      assert.deepEqual(observations[1], observations[0]);
      assert.deepEqual(observations[0].map(row => row.id), [0,1,9,10]);
    });
    await t.test('Ops0074-style AFTER INSERT changes guard rolls back both updates and command insert', async () => {
      const observations = [];
      for (const form of forms) {
        await db.prepare(`CREATE TABLE pending_${form}(id TEXT PRIMARY KEY,target_id TEXT,state TEXT,version INTEGER)`).run();
        await db.prepare(`CREATE TABLE command_${form}(id INTEGER PRIMARY KEY,target_id TEXT)`).run();
        for (const [id,target] of [['one','single'],['two-a','multiple'],['two-b','multiple']])
          await db.prepare(`INSERT INTO pending_${form} VALUES(?,?,'claimed',2)`).bind(id,target).run();
        await db.prepare(`CREATE TRIGGER finish_${form} AFTER INSERT ON command_${form} BEGIN
          UPDATE pending_${form} SET state='approved',version=3 WHERE target_id=NEW.target_id AND state='claimed' AND version=2;
          ${conditional(form, 'changes()<>1', 'synthetic-terminal-transition-failed')} END`).run();
        // Two rows really match the UPDATE. ABORT must undo those writes AND
        // the triggering INSERT, not merely omit the failed command receipt.
        for (const [id,target,denied] of [[1,'missing',true],[2,'multiple',true],[3,null,true],[4,'single',false],[5,'single',true]]) {
          const before = await rows(db, `SELECT * FROM pending_${form} ORDER BY id`);
          await mutation(db, `INSERT INTO command_${form} VALUES(?,?)`, [id,target], denied, 'synthetic-terminal-transition-failed');
          assert.equal((await rows(db, `SELECT id FROM command_${form} WHERE id=${id}`)).length, denied ? 0 : 1);
          if (denied) assert.deepEqual(await rows(db, `SELECT * FROM pending_${form} ORDER BY id`), before);
        }
        observations.push({pending:await rows(db, `SELECT * FROM pending_${form} ORDER BY id`), commands:await rows(db, `SELECT * FROM command_${form} ORDER BY id`)});
      }
      assert.deepEqual(observations[1], observations[0]);
      assert.deepEqual(observations[0].commands, [{id:4,target_id:'single'}]);
      assert.deepEqual(observations[0].pending.map(row => [row.id,row.state,row.version]), [['one','approved',3],['two-a','claimed',2],['two-b','claimed',2]]);
    });
    await t.test('Client0154-style notification EXISTS and action/status/revision mismatch agree', async () => {
      const observations = [];
      for (const form of forms) {
        await db.prepare(`CREATE TABLE batch_${form}(id TEXT,revision INTEGER,status TEXT)`).run();
        await db.prepare(`CREATE TABLE control_${form}(id INTEGER PRIMARY KEY,batch_id TEXT,result_revision INTEGER,result_status TEXT,action TEXT)`).run();
        await db.prepare(`INSERT INTO batch_${form} VALUES('send',2,'pending'),('cancel',3,'cancelled')`).run();
        const predicate = `NOT EXISTS (SELECT 1 FROM batch_${form} batch WHERE batch.id=NEW.batch_id
          AND batch.revision=NEW.result_revision AND batch.status=NEW.result_status
          AND ((NEW.action='cancel' AND NEW.result_status='cancelled') OR (NEW.action='send-now' AND NEW.result_status='pending')))`;
        await db.prepare(`CREATE TRIGGER control_guard_${form} BEFORE INSERT ON control_${form} BEGIN
          ${conditional(form, predicate, 'synthetic-notification-control-mismatch')} END`).run();
        const cases = [['send',2,'pending','send-now',false],['cancel',3,'cancelled','cancel',false],
          ['send',2,'pending','cancel',true],['send',2,'cancelled','cancel',true],['send',3,'pending','send-now',true],
          ['absent',2,'pending','send-now',true],['send',2,'pending',null,true],['send',2,null,'send-now',true],['send',null,'pending','send-now',true]];
        for (const [index, values] of cases.entries()) {
          const [batch,revision,status,action,denied] = values;
          await mutation(db, `INSERT INTO control_${form} VALUES(?,?,?,?,?)`, [index,batch,revision,status,action], denied, 'synthetic-notification-control-mismatch');
          assert.equal((await rows(db, `SELECT id FROM control_${form} WHERE id=${index}`)).length, denied ? 0 : 1);
        }
        observations.push(await rows(db, `SELECT * FROM control_${form} ORDER BY id`));
      }
      assert.deepEqual(observations[1], observations[0]);
      assert.deepEqual(observations[0].map(row => row.id), [0,1]);
    });
    assert.equal(networkAttempts, 0);
  } finally { await runtime.dispose(); }
});
