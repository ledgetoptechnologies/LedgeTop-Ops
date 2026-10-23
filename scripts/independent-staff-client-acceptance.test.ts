import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { applyEntitlementEventForSource, applyProjectionEventForSource } from '../apps/ops-sync/src/projection';
import { createProjectAlphaSourceContext } from '../apps/operations/src/worker/project-alpha-source';
import { executeNativeStaffManagementCommand } from '../apps/operations/src/worker/native-staff-management-command';
import { desiredAccessEmails } from '../apps/ops-sync/src/access-group';
import type { Env, EntitlementEvent, ProjectionEvent } from '../apps/ops-sync/src/types';

import { createIndependentStaffClientFixture, loadIndependentStaffClientDataset } from './independent-staff-client-fixture';
const dataset = await loadIndependentStaffClientDataset();
let runtime: Miniflare, db: D1Database, delivery: D1Database, environment: Env;
const sources = Object.fromEntries(Object.entries(dataset.sources).map(([name, source]) => [name, createProjectAlphaSourceContext(source)]));
const employeeTables = ['staff_users', 'staff_role_assignments', 'staff_divisions', 'local_staff_role_assignments', 'staff_permission_overrides', 'native_staff_profiles', 'native_staff_admissions'];
async function employeeSnapshot() {
  return Promise.all(employeeTables.map(async table => ({ table, rows: (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results })));
}
function projection(client: {id: string; name: string; email: string}, at: string): ProjectionEvent {
  return {
    event_id: crypto.randomUUID(), event_type: 'projection.changed', occurred_at: at,
    schema_version: 1, application_key: 'ltds_ops',
    projection: { entity_type: 'client', entity_id: client.id, action: 'upsert', source_updated_at: at,
      data: { id: client.id, name: client.name, email: client.email, active: true } },
  };
}
async function projectedClients() {
  return (await db.prepare(`SELECT m.projection_source_id source_id,m.external_id,p.name,p.payload_json
    FROM pa_projection_record_ids m JOIN pa_clients p ON p.id=m.local_id
    WHERE m.record_kind='client' AND m.external_id LIKE 'synthetic-%' ORDER BY source_id,external_id`).all()).results;
}

beforeAll(async () => {
  const fixture = await createIndependentStaffClientFixture();
  ({ runtime, db, delivery, environment } = fixture);
});
afterAll(async () => { await runtime?.dispose(); });

describe.sequential('local synthetic employee isolation and client source projection', () => {
  it('accepts employee changes from neither PA, including a PA email matching an Ops employee', async () => {
    const before = await employeeSnapshot();
    const accessBefore = await desiredAccessEmails(db);
    for (const source of Object.values(sources)) for (const active of [true, false]) {
      const event: EntitlementEvent = {
        event_id: crypto.randomUUID(), event_type: active ? 'application_entitlement.changed' : 'application_entitlement.revoked',
        occurred_at: '2026-10-22T12:00:00Z', schema_version: 1,
        user: { id: 'synthetic-pa-employee', email: dataset.opsEmployee.email, display_name: 'PA must not rename Ops', active },
        entitlement: { application_key: 'ltds_ops', enabled: active, role_key: 'role-admin', business_unit_ids: [] },
      };
      if (source.sourceId === dataset.sources.ltds)
        expect(await applyEntitlementEventForSource(environment, source, event, `synthetic-${event.event_id}`)).toBe('ignored');
      else await expect(applyEntitlementEventForSource(environment, source, event, `synthetic-${event.event_id}`)).rejects.toThrow('projection-source-authority-unsupported');
      expect(await employeeSnapshot()).toEqual(before);
      expect(await desiredAccessEmails(db)).toEqual(accessBefore);
    }
  });

  it('edits and disables/re-enables an Ops employee through native commands without changing PA data', async () => {
    const paTables = ['pa_users', 'pa_application_entitlements', 'pa_clients', 'project_alpha_directory_outbox'];
    const paSnapshot = () => Promise.all(paTables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
    const before = await paSnapshot();
    const command = (commandId:string,capability:string,expectedVersion:number) => ({commandId,contractVersion:1,capability,
      actor:{staffId:'synthetic-admin',verifiedAccessSubject:'synthetic-admin-subject'},targetStaffId:dataset.opsEmployee.id,
      expectedVersion,reason:'Synthetic local employee acceptance'});
    const edit = {...command('synthetic-edit','staff.profile.edit',1),displayName:'Synthetic Ops Employee Updated'};
    expect(await executeNativeStaffManagementCommand(db,edit)).toMatchObject({resultVersion:2,replayed:false});
    expect(await executeNativeStaffManagementCommand(db,edit)).toMatchObject({resultVersion:2,replayed:true});
    await expect(executeNativeStaffManagementCommand(db,{...edit,commandId:'synthetic-stale-edit'})).rejects.toThrow('native_staff_management_command_denied');
    expect(await db.prepare('SELECT display_name FROM native_staff_profiles WHERE staff_id=?').bind(dataset.opsEmployee.id).first('display_name')).toBe(edit.displayName);
    const disable = command('synthetic-disable','staff.admission.disable',1);
    expect(await executeNativeStaffManagementCommand(db,disable)).toMatchObject({resultVersion:2,replayed:false});
    expect(await executeNativeStaffManagementCommand(db,disable)).toMatchObject({resultVersion:2,replayed:true});
    expect(await db.prepare('SELECT active FROM native_staff_admissions WHERE staff_id=?').bind(dataset.opsEmployee.id).first('active')).toBe(0);
    expect(await executeNativeStaffManagementCommand(db,command('synthetic-enable','staff.admission.enable',2))).toMatchObject({resultVersion:3,replayed:false});
    expect(await db.prepare('SELECT active FROM native_staff_admissions WHERE staff_id=?').bind(dataset.opsEmployee.id).first('active')).toBe(1);
    expect(await paSnapshot()).toEqual(before);
  });

  it('projects LTDS-only, LTT-only and explicitly shared client copies into their respective sources', async () => {
    const before = await employeeSnapshot();
    for (const client of dataset.clients) for (const destination of client.destinations) {
      const event = projection(client, '2026-10-22T12:01:00Z');
      expect(await applyProjectionEventForSource(environment, sources[destination], event, `synthetic-${event.event_id}`)).toBe('applied');
    }
    const rows = await projectedClients();
    expect(rows).toHaveLength(4);
    for (const client of dataset.clients) {
      expect(rows.filter(row => row.external_id === client.id).map(row => row.source_id).sort())
        .toEqual(client.destinations.map((name: string) => dataset.sources[name]).sort());
    }
    expect(await employeeSnapshot()).toEqual(before);
  });

  it('keeps identical external client IDs source-isolated until each selected PA reports its update', async () => {
    const shared = dataset.clients.find((client: {destinations: string[]}) => client.destinations.length === 2);
    const first = projection({ ...shared, name: 'Synthetic Shared Client Updated' }, '2026-10-22T12:02:00Z');
    await applyProjectionEventForSource(environment, sources.ltds, first, `synthetic-${first.event_id}`);
    let rows = (await projectedClients()).filter(row => row.external_id === shared.id);
    expect(rows.find(row => row.source_id === dataset.sources.ltds)?.name).toBe('Synthetic Shared Client Updated');
    expect(rows.find(row => row.source_id === dataset.sources.ltt)?.name).toBe(shared.name);
    const second = projection({ ...shared, name: 'Synthetic Shared Client Updated' }, '2026-10-22T12:03:00Z');
    await applyProjectionEventForSource(environment, sources.ltt, second, `synthetic-${second.event_id}`);
    rows = (await projectedClients()).filter(row => row.external_id === shared.id);
    expect(rows.map(row => row.name)).toEqual(['Synthetic Shared Client Updated', 'Synthetic Shared Client Updated']);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
