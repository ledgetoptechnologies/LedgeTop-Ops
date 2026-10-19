import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { writeNativeDirectoryProfile } from '../src/worker/native-directory-profile-writer';
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import { profileGenerationRecoverySchema, recoverDirectoryProfileGeneration } from '../src/worker/project-alpha-directory-profile-generation-recovery';
import { drainNativeDirectoryOutboxes } from '../src/worker/native-directory-outbox-scheduler';

let runtime: Miniflare, db: D1Database;
let sequence = 1;
const sourceId = 'project-alpha:primary';
const source = '11111111-1111-4111-8111-111111111111';
const application = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const origin = 'https://pa.example.test';
const uuid = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
const actor = { staffId: 'owner', accessSubject: 'access|owner', admissionVersion: 1,
  profileVersion: 1, loginEmail: 'owner@example.test', selectedGrantId: 'edit-owner', selectedIdentityGrantId: 'identity-owner' };
const profile = { name: 'Compatibility company', generalEmail: 'company@example.test', generalPhone: '920-555-0100',
  addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', country: 'US' };
const destination = (recordId: string, generation: string) => ({ sourceId, sourceInstanceUUID: source,
  applicationUUID: application, historyEpoch: epoch, origin, externalCanonicalId: recordId, expectedAuthorizationGeneration: generation });
const env = () => ({ OPS_DB: db, NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: 'true',
  PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [sourceId]: {
    sourceId, enabled: true, baseUrl: origin, apiKey: 'local-test-key', sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
  } } }) });
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Request-ID': requestId } }); }
function transport(conflict = false) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/capabilities')) return json({ apiVersion: '2', sourceInstanceId: source,
      applicationId: application, historyEpoch: epoch, requestId,
      grantedCapabilities: ['api.capabilities.read', 'directory.organizations.create', 'directory.organizations.write'].map(name => ({ name })),
      implementedEndpoints: [{ method: 'GET', path: '/api/v2/capabilities', requiredCapability: 'api.capabilities.read' },
        ...['create', 'write'].map(operation => ({ method: 'POST',
          path: operation === 'create' ? '/api/v2/directory/organizations/commands' : '/api/v2/directory/organizations/{publicId}/profile/commands',
          requiredCapability: `directory.organizations.${operation}`, requiresSourceInstanceId: true,
          requiresApplicationId: true, requiresHistoryEpoch: true, ...(operation === 'write' ? { requiresExpectedRevision: true } : {}) }))] });
    const body = JSON.parse(String(init?.body));
    if (conflict) return json({ apiVersion: '2', sourceInstanceId: source, applicationId: application,
      historyEpoch: epoch, requestId, error: { code: 'authorization_generation_conflict' } }, 409);
    const update = path.endsWith('/profile/commands');
    const publicId = update ? path.split('/')[5]! : String(body.externalId).replaceAll('-', '');
    return json({ sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed: false,
      result: { resource: { type: 'organization', publicId, revision: update ? '2' : '1',
        ...(update ? {} : { id: body.externalId }) }, authorizationGeneration: '1' } }, update ? 200 : 201);
  });
}
async function createAndUpdate() {
  const recordId = uuid(), mutationId = uuid(), admission = 'compat-' + mutationId;
  const input = { operation: 'create' as const, mutationId, recordId, kind: 'organization' as const,
    expectedLocalVersion: 0 as const, createAdmissionId: admission, profile, actor,
    scopes: [{ businessAreaId: 'area', divisionId: null }], destinations: [destination(recordId, '0')] };
  await db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(admission, actor.staffId, actor.accessSubject, recordId, 'organization',
      JSON.stringify(input.scopes), JSON.stringify(profile),
      JSON.stringify(input.destinations.map(({ expectedAuthorizationGeneration: _, ...value }) => value)), actor.staffId).run();
  const created = await writeNativeDirectoryProfile(db, input);
  expect(created.status).toBe('written'); if (created.status !== 'written') throw Error(JSON.stringify(created));
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, created.commandIds[0]!, transport()))
    .toMatchObject({ status: 'acknowledged' });
  const updated = await writeNativeDirectoryProfile(db, { operation: 'update', mutationId: uuid(), recordId,
    expectedLocalVersion: 1, kind: 'organization', profile: { ...profile, name: 'Updated compatibility company' },
    actor, destinations: [destination(recordId, '1')] });
  expect(updated.status).toBe('written'); if (updated.status !== 'written') throw Error(JSON.stringify(updated));
  return updated.commandIds[0]!;
}
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-08-06',
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ['OPS_DB'] });
  db = await runtime.getD1Database('OPS_DB') as D1Database;
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= '0219').sort()) {
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
  }
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')"),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES('owner','access|owner',1,'owner')"),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES('owner','owner@example.test','Owner')"),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('edit-owner','owner','directory.profile.edit','allow','global','owner')"),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)"),
    db.prepare('CREATE TABLE compatibility_public_links(id TEXT PRIMARY KEY, payload BLOB NOT NULL)'),
    db.prepare("INSERT INTO compatibility_public_links VALUES('historical',x'00ff80')"),
  ]);
}, 240_000);
afterAll(async () => { await runtime?.dispose(); });

describe('profile recovery migration compatibility with actual D1', () => {
  it('keeps normal create and update dispatch working on schema219 and leaves recovery off', async () => {
    expect(await profileGenerationRecoverySchema(db)).toBe(false);
    const commandId = await createAndUpdate();
    expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, commandId, transport()))
      .toMatchObject({ status: 'acknowledged', revision: '2' });
    const noSend = vi.fn<typeof fetch>();
    expect(await recoverDirectoryProfileGeneration(env(), sourceId, commandId, noSend))
      .toMatchObject({ status: 'blocked', reason: 'disabled' });
    expect(noSend).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT hex(payload) payload FROM compatibility_public_links').first('payload')).toBe('00FF80');
  }, 180_000);

  it('fails recovery closed before migration220 rewires the effective materialization views', async () => {
    const commandId = await createAndUpdate();
    expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(), sourceId, commandId, transport(true)))
      .toMatchObject({ status: 'conflict', httpStatus: 409 });
    // Use the real migration prefix, including its immutable ledgers and
    // triggers. All named objects exist, but the existing consumer views have
    // not yet been replaced, so new recovery must remain unavailable.
    const directory = new URL('../migrations/', import.meta.url);
    const migration = readdirSync(directory).find(name => name.startsWith('0220_'))!;
    const statements = splitD1MigrationStatements(readFileSync(new URL(migration, directory), 'utf8'));
    const boundary = statements.findIndex(sql => /^DROP VIEW operations_directory_effective_materializations/i.test(sql.trim()));
    expect(boundary).toBeGreaterThan(0);
    await db.batch(statements.slice(0, boundary).map(sql => db.prepare(sql)));
    expect(await profileGenerationRecoverySchema(db)).toBe(false);
    const noSend = vi.fn<typeof fetch>();
    expect(await recoverDirectoryProfileGeneration(env(), sourceId, commandId, noSend))
      .toMatchObject({ status: 'blocked', reason: 'disabled' });
    expect(noSend).not.toHaveBeenCalled();
    // Ordinary create-observation work may still be queued. It must continue
    // safely; the incomplete profile-recovery lane must not query missing SQL.
    const ordinaryRead = vi.fn<typeof fetch>(async () => json({}, 503));
    const drained = await drainNativeDirectoryOutboxes(env(), { send: ordinaryRead, maxCommands: 1 });
    expect(drained).toMatchObject({ attempted: 1, failed: 0 });
    expect(ordinaryRead).toHaveBeenCalled();
    // Inspect outside the callback: the scheduler intentionally catches
    // transport exceptions, which must not swallow an assertion failure.
    expect(ordinaryRead.mock.calls.every(([input, init]) =>
      (input instanceof Request ? input.method : init?.method ?? 'GET').toUpperCase() !== 'POST')).toBe(true);
    expect(await db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id=?').bind(commandId).first('state'))
      .toBe('terminal');
    expect(await db.prepare('SELECT hex(payload) payload FROM compatibility_public_links').first('payload')).toBe('00FF80');
    // Finishing the unchanged migration enables recovery. The gate must not
    // merely reject every schema after becoming more strict.
    await db.batch(statements.slice(boundary).map(sql => db.prepare(sql)));
    expect(await profileGenerationRecoverySchema(db)).toBe(true);
    expect(await db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id=?').bind(commandId).first('state'))
      .toBe('terminal');
    expect(await db.prepare('SELECT hex(payload) payload FROM compatibility_public_links').first('payload')).toBe('00FF80');
  }, 180_000);
});
