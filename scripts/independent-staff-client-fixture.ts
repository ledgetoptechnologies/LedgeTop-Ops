import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { createProjectAlphaSourceContext } from '../apps/operations/src/worker/project-alpha-source';
import type { Env } from '../apps/ops-sync/src/types';

export async function loadIndependentStaffClientDataset() {
  return JSON.parse(await readFile(new URL('./fixtures/independent-staff-client-dataset.json', import.meta.url), 'utf8'));
}

export async function seedNativeEmployee(db:D1Database, input:{id:string;email:string;displayName:string;subject:string}) {
  if (!input.id.startsWith('synthetic-') || !input.email.endsWith('.invalid') || !input.subject.startsWith('synthetic-'))
    throw new Error('synthetic_employee_required');
  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,status,provisioning_source) VALUES(?,?,?,'active','local')`).bind(input.id,input.email,input.displayName),
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'staff-beau-koltz')`).bind(input.id,input.subject),
    db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)`).bind(input.id,input.email,input.displayName),
  ]);
}

// Explicit invocation only: importing this helper does not allocate a runtime,
// access credentials, seed records or contact a PA/Cloudflare endpoint.
export async function createIndependentStaffClientFixture() {
  const dataset = await loadIndependentStaffClientDataset();
  const sources = Object.fromEntries(Object.entries(dataset.sources).map(([name, source]) => [name, createProjectAlphaSourceContext(source)]));
  let runtime: Miniflare, db: D1Database, delivery: D1Database, environment: Env;
  try {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-08-06',
    script: 'export default {fetch(){return new Response("synthetic acceptance")}}', d1Databases: ['OPS_DB', 'DELIVERY_DB'] });
  db = await runtime.getD1Database('OPS_DB') as D1Database;
  delivery = await runtime.getD1Database('DELIVERY_DB') as D1Database;
  for (const [application, database] of [['operations', db], ['client', delivery]] as const) {
    const migrations = new URL(`../apps/${application}/migrations/`, import.meta.url);
    for (const filename of (await readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()) {
      const statements = unstable_splitSqlQuery((await readFile(new URL(filename, migrations), 'utf8')).replace(/\r\n/g, '\n'))
        .map(sql => sql.trim()).filter(sql => sql && !/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(sql));
      if (statements.length) await database.batch(statements.map(sql => database.prepare(sql)));
    }
  }
  environment = { OPS_DB: db, DELIVERY_DB: delivery } as Env;
  await seedNativeEmployee(db,{...dataset.opsEmployee,subject:'synthetic-employee-subject'});
  await db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key)
    VALUES('synthetic-ops-role',?,'role-operator','assigned','assigned')`).bind(dataset.opsEmployee.id).run();
  await seedNativeEmployee(db,{id:'synthetic-admin',email:'admin@ops-isolation.invalid',displayName:'Synthetic Admin',subject:'synthetic-admin-subject'});
  for (const capability of ['staff.profile.edit','staff.admission.enable','staff.admission.disable']) await db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,target_staff_id,granted_by)
    VALUES(?,'synthetic-admin',?,'allow','exact_staff',?,'synthetic-admin')`)
    .bind(`synthetic:${capability}`,capability,dataset.opsEmployee.id).run();
  // Keep a complete synthetic control-plane candidate alive. The canonical
  // admission triggers correctly refuse a disable without a surviving candidate.
  const adminCapabilities=['staff.onboarding.create','staff.onboarding.approve','staff.admission.disable','staff.membership.manage','staff.directory_grant.manage','staff.admin_delegation.manage'];
  const directoryCapabilities=['directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage','directory.portal_access.manage'];
  for (const capability of adminCapabilities) await db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,'synthetic-admin',?,'allow','global','synthetic-admin')`)
    .bind(`synthetic:global:${capability}`,capability).run();
  for (const [domain,capabilities,parent] of [['directory',directoryCapabilities,'staff.directory_grant.manage'],['staff_admin',adminCapabilities,'staff.admin_delegation.manage']] as const)
    for (const capability of capabilities) await db.prepare(`INSERT INTO native_staff_delegation_ceilings
      (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
      VALUES(?,?,?,?,'allow',1,1,1,1,'global')`)
      .bind(`synthetic:ceiling:${domain}:${capability}`,`synthetic:global:${parent}`,domain,capability).run();
    return { runtime, db, delivery, environment, dataset, sources };
  } catch (error) {
    await runtime?.dispose();
    throw error;
  }
}
