import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { verifyAgentService, AGENT_STAGING_HOST } from '../src/worker/agent-service-auth';
import { handleAgentRead } from '../src/worker/agent-read-routes';
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from '../src/worker/native-directory-profile-writer';

const issuer = 'https://example.cloudflareaccess.com', audience = 'agent-audience-1234567890';
const sourceId = 'project-alpha:staging', projectionSource = 'project-alpha:primary';
const instance = '11111111-1111-4111-8111-111111111111', application = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333', origin = 'https://pa.example.test';
let privateKey: CryptoKey, keyResolver: ReturnType<typeof createLocalJWKSet>, sequence = 0;
const uuid = () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const configuration = { environment: 'staging', enabled: 'true', issuer, audience };
async function assertion(clientId: string, claims: Record<string, unknown> = {}, wrongSignature = false) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', sub: '', common_name: clientId, iss: issuer, aud: [audience], iat: now, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'agent-test' }).sign(wrongSignature ? (await generateKeyPair('RS256')).privateKey : privateKey);
}
async function request(path = '/connection', client = 'machine.access', claims = {}, method = 'GET') {
  return new Request(`https://${AGENT_STAGING_HOST}/api/agent/v1${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': await assertion(client, claims) } });
}
beforeAll(async () => {
  const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey;
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'agent-test', alg: 'RS256' }] });
});

describe('independent signed Access service identity', () => {
  it('accepts documented service claims without get-identity-only fields', async () => {
    expect(await verifyAgentService(await request(), configuration, keyResolver)).toMatchObject({ accessClientId: 'machine.access' });
  });
  it.each([
    { sub: 'human-subject' }, { sub: undefined }, { email: 'owner@example.test' }, { type: 'org' },
    { aud: ['wrong-audience'] }, { aud: [audience, 'second'] }, { iss: 'https://wrong.cloudflareaccess.com' },
    { common_name: '' }, { common_name: undefined }, { common_name: 'bad client' },
    { iat: 0.5 }, { iat: 9999999999 }, { iat: undefined }, { exp: 1 }, { exp: undefined },
  ])('denies malformed or human claims %j', async claims => {
    await expect(verifyAgentService(await request('/connection', 'machine.access', claims), configuration, keyResolver)).rejects.toThrow();
  });
  it('rejects an actually invalid cryptographic signature', async () => {
    const r = new Request(`https://${AGENT_STAGING_HOST}/api/agent/v1/connection`, { headers: { 'Cf-Access-Jwt-Assertion': await assertion('machine.access', {}, true) } });
    await expect(verifyAgentService(r, configuration, keyResolver)).rejects.toThrow();
  });
});

describe('machine read routes against full source219 D1', () => {
  let mf: Miniflare, db: D1Database;
  const record = 'client-one', other = 'client-two', multi = 'multiscope-client', owner = 'agent-owner';
  const identity = JSON.stringify([origin, instance, application, epoch]);
  const profile = { name: 'Test Client', email: 'client@example.test', phone: '', clientType: 'consumer' as const,
    addressLine1: '', addressLine2: '', city: '', state: 'WI', postalCode: '', country: 'US' };
  const envelope = (id: string, apiKey: string) => JSON.stringify({ version: 1, instances: { [id]: {
    sourceId: id, enabled: true, baseUrl: origin, apiKey, sourceInstanceId: instance, applicationId: application, historyEpoch: epoch,
  } } });
  const env = () => ({ OPS_DB: db, ENVIRONMENT: 'staging', TEAM_DOMAIN: issuer, OPERATIONS_AUD: 'human-audience-1234567890',
    OPS_AGENT_READ_ENABLED: 'true', OPS_AGENT_READ_AUD: audience,
    PROJECT_ALPHA_API_V2_CONNECTIONS: envelope(sourceId, 'never-send-directory-credential'),
    PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS: envelope(projectionSource, 'capabilities-only'),
  });
  const probe = vi.fn(async (_environment?: { PROJECT_ALPHA_API_V2_CONNECTIONS?: string }, _source?: string) => ({ status: 'verified' as const, sourceInstanceId: instance, applicationId: application,
    historyEpoch: epoch, requestId: uuid(), grantedCapabilities: ['api.capabilities.read'] }));
  async function machine(selectedProjection = projectionSource) {
    const id = `agent-${++sequence}`, client = `${id}.access`;
    await db.prepare(`INSERT INTO ops_agent_principals(id,access_client_id,owner_staff_id,owner_access_subject,owner_admission_version,status,expires_at)
      SELECT ?,?,?,'access|agent-owner',version,'active',unixepoch()+3600 FROM native_staff_admissions WHERE staff_id=?`).bind(id, client, owner, owner).run();
    const grant = `grant-${id}`;
    await db.prepare(`INSERT INTO ops_agent_read_grants(id,agent_id,source_id,projection_source_id,origin,source_instance_id,application_id,history_epoch_id,effect,scope_kind)
      VALUES(?,?,?,?,?,?,?,?,'allow','source')`).bind(grant, id, sourceId, selectedProjection, origin, instance, application, epoch).run();
    return { id, client, grant };
  }
  async function call(client: string, path: string, changes = {}, hook: NonNullable<Parameters<typeof handleAgentRead>[2]>['probe'] = probe) {
    return handleAgentRead(await request(path, client), { ...env(), ...changes }, { keyResolver, probe: hook });
  }
  async function connector(id: string) {
    const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const base = `/snap/${id}`;
    await db.batch([
      db.prepare(`INSERT INTO pa_connector_signing_keys(fingerprint,source_id,algorithm) VALUES(?,?,'ed25519')`).bind(key, id),
      db.prepare(`INSERT INTO pa_connectors(source_id,producer_binding_id,snapshot_origin,application_key,snapshot_base_path,profile,display_name,read_visible,created_by)
        VALUES(?,?,?,'agent',?,?,'Agent fixture',?,'fixture')`).bind(id, key.slice(0, 20), origin, base, id === projectionSource ? 'primary_legacy' : 'business_data', id === projectionSource ? 1 : 0),
      db.prepare(`INSERT INTO pa_connector_revisions(source_id,revision,credential_ref,snapshot_base_path,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
        VALUES(?,1,'TEST',?,'https://example.cloudflareaccess.com','fixture-audience','fixture-subject','key',?,'fixture')`).bind(id, base, key),
    ]);
    await db.prepare('UPDATE pa_connectors SET read_visible=1,version=version+1 WHERE source_id=?').bind(id).run();
  }
  beforeAll(async () => {
    mf = new Miniflare({ modules: true, compatibilityDate: '2026-08-06', script: 'export default { fetch(){return new Response("ok")} }', d1Databases: ['OPS_DB'] });
    db = await mf.getD1Database('OPS_DB') as D1Database;
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(n => /^\d{4}_.+\.sql$/.test(n) && n.slice(0, 4) <= '0219').sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
    await db.batch([
      db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,'owner@example.test','Owner','access|agent-owner','active')`).bind(owner),
      db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,'access|agent-owner',1,?)`).bind(owner, owner),
      db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,'owner@example.test','Owner')`).bind(owner),
      db.prepare(`INSERT INTO native_business_areas(id,name) VALUES('agent-area','Area')`),
      db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name) VALUES('agent-division','agent-area','Division')`),
      db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name) VALUES('agent-inactive-division','agent-area','Initially active division')`),
      ...['directory.profile.edit', 'directory.identity.link', 'directory.profile.view'].map(permission => db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`).bind(permission, owner, permission, owner)),
    ]);
    for (const recordId of [record, other, multi]) {
      const admissionId = uuid(), mutationId = uuid();
      const scopes: { businessAreaId: string; divisionId: string | null }[] = [{ businessAreaId: 'agent-area', divisionId: 'agent-division' }];
      if (recordId === multi) scopes.push({ businessAreaId: 'agent-area', divisionId: null }, { businessAreaId: 'agent-area', divisionId: 'agent-inactive-division' });
      scopes.sort((a, b) => `${a.businessAreaId}\0${a.divisionId ?? ''}`.localeCompare(`${b.businessAreaId}\0${b.divisionId ?? ''}`));
      const destination = { sourceId, sourceInstanceUUID: instance, applicationUUID: application, historyEpoch: epoch, origin,
        externalCanonicalId: recordId, expectedAuthorizationGeneration: '0' };
      const { expectedAuthorizationGeneration: _, ...admitted } = destination;
      await db.batch([
        db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
          VALUES(?,?,'access|agent-owner',?,'client',?,?,?,?)`).bind(admissionId, owner, recordId, JSON.stringify(scopes), JSON.stringify(profile), JSON.stringify([admitted]), owner),
        db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,organization_record_id,organization_record_version)
          VALUES(?,?,NULL,NULL)`).bind(admissionId, recordId),
      ]);
      const write: NativeDirectoryCreateWrite = { operation: 'create', kind: 'client', mutationId, createAdmissionId: admissionId, recordId,
        expectedLocalVersion: 0, scopes, profile, destinations: [destination], relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 },
        actor: { staffId: owner, accessSubject: 'access|agent-owner', admissionVersion: 1, loginEmail: 'owner@example.test', profileVersion: 1,
          selectedGrantId: 'directory.profile.edit', selectedIdentityGrantId: 'directory.identity.link' } };
      const written = await writeNativeDirectoryProfile(db, write);
      expect(written.status).toBe('written');
      if (written.status !== 'written') throw Error(JSON.stringify(written));
      for (const command of written.commandIds) {
        await db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='test',lease_expires_at=9999999999999 WHERE command_id=?`).bind(command).run();
        await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
          VALUES(?,'client',?,?,?,?,?,?)`).bind(sourceId, recordId, (++sequence).toString(16).padStart(32, '0'), instance, application, epoch, command).run();
      }
    }
    await db.prepare(`INSERT INTO pa_local_division_source_heads(projection_source_id,identity_key,revision,verified_at) VALUES(?,?,1,datetime('now'))`).bind(projectionSource, identity).run();
    await connector(projectionSource);
  }, 180000);
  afterAll(async () => { await mf?.dispose(); });
  it('supports only three reads and never returns endpoint/credential/owner metadata', async () => {
    const m = await machine(), r = await call(m.client, '/connection'); expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ principal: { kind: 'agent', id: m.id }, readOnly: true, tools: ['get_connection', 'find_clients', 'get_client'] });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('reads a source-qualified client through native owner AND machine grants with live observer', async () => {
    const m = await machine(); probe.mockClear();
    const r = await call(m.client, `/clients/${encodeURIComponent(sourceId)}/${record}`); expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ sourceId, recordId: record, kind: 'client', name: 'Test Client', profile: { email: 'client@example.test' } });
    expect(probe).toHaveBeenCalledOnce(); expect(probe.mock.calls[0]?.[0]?.PROJECT_ALPHA_API_V2_CONNECTIONS).toBe(env().PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS);
    expect(probe.mock.calls[0]?.[1]).toBe(projectionSource);
    const list = await call(m.client, `/clients?sourceId=${encodeURIComponent(sourceId)}&limit=1`); expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ clients: [{ recordId: record }], nextCursor: record });
  });
  it('denies production, wrong host, shared human audience, methods and unimplemented paths before auth/observer', async () => {
    const m = await machine(); probe.mockClear();
    expect((await call(m.client, '/connection', { ENVIRONMENT: 'production' })).status).toBe(404);
    expect((await call(m.client, '/connection', { OPS_AGENT_READ_AUD: env().OPERATIONS_AUD })).status).toBe(404);
    const r = await request('/connection', m.client);
    expect((await handleAgentRead(new Request(r.url.replace(AGENT_STAGING_HOST, 'ops.ledgetopdroneservices.com'), r), env(), { keyResolver, probe })).status).toBe(404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await handleAgentRead(await request('/clients', m.client, {}, method), env(), { keyResolver, probe })).status).toBe(405);
    expect((await call(m.client, '/onboarding')).status).toBe(404); expect(probe).not.toHaveBeenCalled();
  });
  it('requires explicit source and bounds query/cursor/limit inputs', async () => {
    const m = await machine();
    for (const path of ['/clients', `/clients?sourceId=${sourceId}&limit=26`, `/clients?sourceId=${sourceId}&q=${'x'.repeat(101)}`, `/clients?sourceId=${sourceId}&sourceId=${sourceId}`, `/clients?sourceId=${sourceId}&url=https://bad.test`]) expect((await call(m.client, path)).status).toBe(403);
  });
  it('owner native view grant is mandatory; role or active admission alone grants no data', async () => {
    const m = await machine();
    await db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by)
      VALUES('agent-owner-admin-role',?,'role-admin','global','global',?)`).bind(owner, owner).run();
    await db.prepare(`UPDATE native_directory_grants SET active=0 WHERE id='directory.profile.view'`).run();
    try { expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(404); }
    finally { await db.prepare(`UPDATE native_directory_grants SET active=1 WHERE id='directory.profile.view'`).run(); }
  });
  it('owner explicit division deny overrides global native allow', async () => {
    const m = await machine(), id = uuid();
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,division_id,granted_by)
      VALUES(?,?,'directory.profile.view','deny','division','agent-division',?)`).bind(id, owner, owner).run();
    try { expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(404); }
    finally { await db.prepare('UPDATE native_directory_grants SET active=0 WHERE id=?').bind(id).run(); }
  });
  it('unknown or inactive division classification retains owner scoped denies', async () => {
    const m = await machine();
    const id = await db.prepare(`SELECT id FROM native_directory_grants WHERE staff_id=? AND permission='directory.profile.view' AND effect='deny' AND division_id='agent-division'`).bind(owner).first<string>('id');
    await db.prepare('UPDATE native_directory_grants SET active=1 WHERE id=?').bind(id).run();
    await db.prepare(`UPDATE native_business_divisions SET active=0 WHERE id='agent-division'`).run();
    try { expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(404); }
    finally { await db.prepare(`UPDATE native_business_divisions SET active=1 WHERE id='agent-division'`).run(); await db.prepare('UPDATE native_directory_grants SET active=0 WHERE id=?').bind(id).run(); }
  });
  it('absent division classification preserves view denies but unrelated edit denies do not block reads', async () => {
    const m = await machine();
    const id = await db.prepare(`SELECT id FROM native_directory_grants WHERE staff_id=? AND permission='directory.profile.view' AND effect='deny' AND division_id='agent-division'`).bind(owner).first<string>('id');
    await db.prepare(`UPDATE native_directory_resource_scopes SET active=0 WHERE record_id=?`).bind(record).run();
    try {
      await db.prepare('UPDATE native_directory_grants SET active=1 WHERE id=?').bind(id).run();
      expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(404);
      await db.prepare('UPDATE native_directory_grants SET active=0 WHERE id=?').bind(id).run();
      await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,division_id,granted_by)
        VALUES('unrelated-edit-deny',?,'directory.profile.edit','deny','division','agent-division',?)`).bind(owner, owner).run();
      expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(200);
    } finally {
      await db.prepare(`UPDATE native_directory_resource_scopes SET active=1 WHERE record_id=?`).bind(record).run();
      await db.prepare('UPDATE native_directory_grants SET active=0 WHERE id=?').bind(id).run();
      await db.prepare(`UPDATE native_directory_grants SET active=0 WHERE id='unrelated-edit-deny'`).run();
    }
  });
  it('resource-only machine grant cannot read siblings or another source', async () => {
    const m = await machine();
    await db.prepare('UPDATE ops_agent_read_grants SET active=0,version=version+1 WHERE id=?').bind(m.grant).run();
    await db.prepare(`INSERT INTO ops_agent_read_grants(id,agent_id,source_id,projection_source_id,origin,source_instance_id,application_id,history_epoch_id,effect,scope_kind,record_id)
      VALUES(?,?,?,?,?,?,?,?,'allow','resource',?)`).bind(uuid(), m.id, sourceId, projectionSource, origin, instance, application, epoch, record).run();
    expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(200);
    expect((await call(m.client, `/clients/${sourceId}/${other}`)).status).toBe(404);
    expect((await call(m.client, `/clients/project-alpha:other/${record}`)).status).toBe(403);
  });
  it('known plus unknown active scopes never erase a relevant division deny', async () => {
    const m = await machine();
    await db.batch([
      db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name) VALUES('agent-denied-division','agent-area','Denied division')`),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,division_id,granted_by)
        VALUES('agent-multiscope-deny',?,'directory.profile.view','deny','division','agent-denied-division',?)`).bind(owner, owner),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,division_id,granted_by)
        VALUES('agent-multiscope-edit-deny',?,'directory.profile.edit','deny','division','agent-denied-division',?)`).bind(owner, owner),
    ]);
    try {
      // Existing valid division A plus unknown area-only scope cannot dismiss a B deny.
      expect((await call(m.client, `/clients/${sourceId}/${multi}`)).status).toBe(404);
      await db.prepare(`UPDATE native_directory_grants SET active=0 WHERE id='agent-multiscope-deny'`).run();
      expect((await call(m.client, `/clients/${sourceId}/${multi}`)).status).toBe(200); // edit deny is unrelated
      await db.prepare(`UPDATE native_directory_grants SET active=1 WHERE id='agent-multiscope-deny'`).run();
      await db.prepare(`UPDATE native_directory_resource_scopes SET active=0 WHERE record_id=? AND scope_kind='business_area'`).bind(multi).run();
      await db.prepare(`UPDATE native_business_divisions SET active=0 WHERE id='agent-inactive-division'`).run();
      // A known division plus an active scope pointing to an inactive division is also unknown.
      expect((await call(m.client, `/clients/${sourceId}/${multi}`)).status).toBe(404);
    } finally {
      await db.prepare(`UPDATE native_business_divisions SET active=1 WHERE id='agent-inactive-division'`).run();
      await db.prepare(`UPDATE native_directory_resource_scopes SET active=1 WHERE record_id=? AND scope_kind='business_area'`).bind(multi).run();
      await db.prepare(`UPDATE native_directory_grants SET active=0 WHERE id IN ('agent-multiscope-deny','agent-multiscope-edit-deny')`).run();
    }
  });
  it('machine resource ceiling and deny override a source allow', async () => {
    const m = await machine();
    await db.prepare(`INSERT INTO ops_agent_read_grants(id,agent_id,source_id,projection_source_id,origin,source_instance_id,application_id,history_epoch_id,effect,scope_kind,record_id)
      VALUES(?,?,?,?,?,?,?,?,'deny','resource',?)`).bind(uuid(), m.id, sourceId, projectionSource, origin, instance, application, epoch, record).run();
    expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(404);
    expect((await call(m.client, `/clients/${sourceId}/${other}`)).status).toBe(200);
  });
  it('denies missing/cleared or replacement epoch head and mismatched source configuration', async () => {
    const m = await machine();
    for (const key of [null, JSON.stringify([origin, instance, application, uuid()])]) {
      await db.prepare('UPDATE pa_local_division_source_heads SET identity_key=?,revision=revision+1 WHERE projection_source_id=?').bind(key, projectionSource).run();
      expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(404);
    }
    await db.prepare('UPDATE pa_local_division_source_heads SET identity_key=?,revision=revision+1 WHERE projection_source_id=?').bind(identity, projectionSource).run();
    expect((await call(m.client, `/clients/${sourceId}/${record}`, { PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS: undefined })).status).toBe(403);
  });
  it('requires explicit projection-alias visibility; absent/hidden projection cannot borrow a visible directory alias', async () => {
    const selected = 'project-alpha:extra', m = await machine(selected);
    await db.prepare(`INSERT INTO pa_local_division_source_heads(projection_source_id,identity_key,revision) VALUES(?,?,1)`).bind(selected, identity).run();
    const changes = { PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS: envelope(selected, 'capabilities-only') };
    await connector(sourceId); // A visible directory alias is never the projection visibility authority.
    expect((await call(m.client, `/clients/${sourceId}/${record}`, changes)).status).toBe(404);
    await connector(selected);
    expect((await call(m.client, `/clients/${sourceId}/${record}`, changes)).status).toBe(200);
    await db.prepare('UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id=?').bind(selected).run();
    expect((await call(m.client, `/clients/${sourceId}/${record}`, changes)).status).toBe(404);
  });
  it('failed/revoked/overprivileged live observer never discloses data', async () => {
    const m = await machine();
    expect((await call(m.client, `/clients/${sourceId}/${record}`, {}, async () => ({ status: 'unauthorized', reason: 'credentials_or_scope' }))).status).toBe(403);
    expect((await call(m.client, `/clients/${sourceId}/${record}`, {}, async () => ({ ...await probe(), grantedCapabilities: ['api.capabilities.read', 'financial.summary.read'] }))).status).toBe(403);
  });
  it('revocation during a delayed capability response is observed before data returns', async () => {
    for (const kind of ['principal', 'grant', 'owner'] as const) {
      const m = await machine();
      const delayed = async () => {
        if (kind === 'principal') await db.prepare(`UPDATE ops_agent_principals SET status='revoked',version=version+1 WHERE id=?`).bind(m.id).run();
        if (kind === 'grant') await db.prepare(`UPDATE ops_agent_read_grants SET active=0,version=version+1 WHERE id=?`).bind(m.grant).run();
        if (kind === 'owner') await db.prepare(`UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?`).bind(owner).run();
        return probe();
      };
      expect([403, 404]).toContain((await call(m.client, `/clients/${sourceId}/${record}`, {}, delayed)).status);
      if (kind === 'owner') await db.prepare(`UPDATE native_staff_admissions SET active=1,version=version+1 WHERE staff_id=?`).bind(owner).run();
    }
  });
  it('registry expiry and revoked identity fail closed, and revoked principals cannot be restored', async () => {
    const m = await machine(); await db.prepare('UPDATE ops_agent_principals SET expires_at=1,version=version+1 WHERE id=?').bind(m.id).run();
    expect((await call(m.client, '/connection')).status).toBe(403);
    await db.prepare(`UPDATE ops_agent_principals SET status='revoked',version=version+1 WHERE id=?`).bind(m.id).run();
    await expect(db.prepare(`UPDATE ops_agent_principals SET status='active',version=version+1 WHERE id=?`).bind(m.id).run()).rejects.toThrow();
  });
  it('rechecks authority after audit and never returns a stale authorized record', async () => {
    const m = await machine();
    await db.prepare(`CREATE TRIGGER agent_test_revoke_after_audit AFTER INSERT ON ops_agent_read_audit
      WHEN NEW.agent_id='${m.id}' AND NEW.outcome='allowed' BEGIN UPDATE ops_agent_principals SET status='revoked',version=version+1 WHERE id=NEW.agent_id; END`).run();
    try {
      expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(403);
      const events = (await db.prepare('SELECT request_id,outcome FROM ops_agent_read_audit WHERE agent_id=? ORDER BY rowid').bind(m.id).all<{ request_id: string; outcome: string }>()).results;
      expect(events.map(e => e.outcome)).toEqual(['allowed', 'denied']);
      expect(new Set(events.map(e => e.request_id)).size).toBe(1);
    }
    finally { await db.prepare('DROP TRIGGER agent_test_revoke_after_audit').run(); }
  });
  it('requires durable audit success and excludes profile/query content from audit', async () => {
    const m = await machine();
    await db.prepare(`CREATE TRIGGER agent_test_fail_audit BEFORE INSERT ON ops_agent_read_audit
      WHEN NEW.agent_id='${m.id}' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`).run();
    try { expect((await call(m.client, `/clients/${sourceId}/${record}`)).status).toBe(503); }
    finally { await db.prepare('DROP TRIGGER agent_test_fail_audit').run(); }
    expect((await call(m.client, `/clients?sourceId=${sourceId}&q=Test`)).status).toBe(200);
    const rows = await db.prepare('SELECT * FROM ops_agent_read_audit WHERE agent_id=?').bind(m.id).all();
    expect(JSON.stringify(rows.results)).not.toContain('Test'); expect(JSON.stringify(rows.results)).not.toContain('client@example.test');
  });
  it('atomically bounds each known machine to60 requests per minute', async () => {
    const m = await machine();
    await db.prepare('INSERT INTO ops_agent_read_rate_windows(agent_id,minute,requests) VALUES(?,unixepoch()/60,60)').bind(m.id).run();
    expect((await call(m.client, '/connection')).status).toBe(429);
    expect(await db.prepare('SELECT requests FROM ops_agent_read_rate_windows WHERE agent_id=?').bind(m.id).first('requests')).toBe(60);
  });
});
