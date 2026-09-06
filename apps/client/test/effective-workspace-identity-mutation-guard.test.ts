import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readEffectiveWorkspaceIdentityMutationGuard } from '../src/worker/client-portal/effective-workspace-identity-mutation-guard';
import type { EffectivePortalWorkspaceContext } from '../src/worker/client-portal/workspace-v2';

let runtime: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
const principal = { issuer: 'issuer', subject: 'subject', email: ' Person@Example.com ' };
const context: EffectivePortalWorkspaceContext = {
  workspaceId: 'workspace', identityId: 'global', legacyAccountId: 'account',
  legacyIdentityId: 'direct', rootType: 'organization', rootPublicId: 'org',
  displayName: 'Test', role: 'member', canViewBilling: false,
};

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-08-06',
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ['DB'] });
  db = await runtime.getD1Database('DB');
  // Minimal relational fixture for this identity-only SQL helper; the complete
  // notification mutation tests separately exercise production migrations.
  for (const sql of [
    'CREATE TABLE portal_v2_identities(id TEXT,issuer TEXT,subject TEXT,status TEXT,revoked_at TEXT)',
    'CREATE TABLE client_accounts(id TEXT,status TEXT,project_alpha_source_id TEXT)',
    'CREATE TABLE client_identity_links(id TEXT,account_id TEXT,issuer TEXT,subject TEXT,revoked_at TEXT)',
    'CREATE TABLE client_account_members(account_id TEXT,identity_id TEXT,revoked_at TEXT)',
    "INSERT INTO portal_v2_identities VALUES ('global','issuer','subject','active',NULL)",
    "INSERT INTO client_accounts VALUES ('account','active',NULL)",
    "INSERT INTO client_identity_links VALUES ('direct','account','issuer','subject',NULL),('invited','account','synthetic','invited',NULL),('eligible','account','synthetic','eligible',NULL)",
    "INSERT INTO client_account_members VALUES ('account','direct',NULL),('account','invited',NULL),('account','eligible',NULL)",
  ]) await db.prepare(sql).run();
});
afterAll(async () => runtime.dispose());

it('rechecks ordered bridges, optional schema, revocation and eligibility at execution time', async () => {
  // Miniflare exposes the same D1 methods with its own structural proxy types.
  const env = { DELIVERY_DB: db as D1Database };
  const guardFor = (identity: string) => readEffectiveWorkspaceIdentityMutationGuard(env, principal,
    { ...context, legacyIdentityId: identity });
  const allows = async (guard: Awaited<ReturnType<typeof guardFor>>) =>
    (await db.prepare(`SELECT 1 ok WHERE ${guard.sql}`).bind(...guard.bindings).first('ok')) === 1;
  expect(await allows(await guardFor('direct'))).toBe(true);
  expect(await allows(await guardFor('invited'))).toBe(false);
  for (const table of ['portal_v2_legacy_member_bridges', 'portal_v2_identity_eligibility_legacy_bridges']) {
    await db.prepare(`CREATE TABLE ${table}(workspace_id TEXT,identity_id TEXT,legacy_account_id TEXT,
      legacy_identity_id TEXT,status TEXT,revoked_at TEXT,PRIMARY KEY(workspace_id,identity_id))`).run();
  }
  await db.prepare("INSERT INTO portal_v2_legacy_member_bridges VALUES ('workspace','global','account','invited','active',NULL)").run();
  await db.prepare("INSERT INTO portal_v2_identity_eligibility_legacy_bridges VALUES ('workspace','global','account','eligible','active',NULL)").run();
  const invited = await guardFor('invited');
  const eligible = await guardFor('eligible');
  const direct = await guardFor('direct');
  expect(await allows(invited)).toBe(true);
  expect(await allows(eligible)).toBe(false);
  expect(await allows(direct)).toBe(false);
  await db.prepare("UPDATE portal_v2_legacy_member_bridges SET revoked_at=datetime('now')").run();
  expect(await allows(invited)).toBe(false);
  expect(await allows(eligible)).toBe(true);
  await db.prepare("UPDATE client_account_members SET revoked_at=datetime('now') WHERE identity_id='eligible'").run();
  expect(await allows(eligible)).toBe(false);
  expect(await allows(direct)).toBe(true);
  await db.prepare(`CREATE TABLE portal_v2_identity_eligibility_blocks(status TEXT,valid_from TEXT,
    expires_at TEXT,match_type TEXT,issuer TEXT,subject TEXT,normalized_email TEXT)`).run();
  const blockedGuard = await guardFor('direct');
  expect(await allows(blockedGuard)).toBe(true);
  await db.prepare("INSERT INTO portal_v2_identity_eligibility_blocks VALUES ('active','2000-01-01',NULL,'email',NULL,NULL,'person@example.com')").run();
  expect(await allows(blockedGuard)).toBe(false);
  await db.prepare("UPDATE portal_v2_identity_eligibility_blocks SET expires_at='2001-01-01'").run();
  expect(await allows(blockedGuard)).toBe(true);
  await db.prepare("UPDATE portal_v2_identity_eligibility_blocks SET expires_at=NULL,match_type='issuer_subject',issuer='issuer',subject='subject'").run();
  expect(await allows(blockedGuard)).toBe(false);
  await db.prepare("UPDATE portal_v2_identity_eligibility_blocks SET status='revoked'").run();
  await db.prepare("UPDATE portal_v2_identities SET revoked_at=datetime('now')").run();
  expect(await allows(blockedGuard)).toBe(false);
}, 60_000);
