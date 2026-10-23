import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { executeOperationsStaffLifecycleCommand as execute } from "../src/worker/native-staff-management-command";
import { handleOperationsNativeStaffLifecycleHttp as handle, OPERATIONS_NATIVE_STAFF_LIFECYCLE_BASE as BASE } from "../src/worker/operations-native-staff-lifecycle-http";
import { authenticateStaff, authenticateBoundStaffForViewerRenewal } from "../src/worker/auth";
import { authenticateNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import { resolveEmployeeReadAuthority, recheckEmployeeReadAuthority } from "../src/worker/employee-read-authority";
import { handleAgentRead } from "../src/worker/agent-read-routes";
import type { Env } from "../src/worker/types";
import worker from "../src/worker/index";
import { readNativeStaffCutoverReadiness, canonicalStaffReadiness, NATIVE_STAFF_READINESS_SNAPSHOT_QUERY as READINESS_QUERY,
  NATIVE_STAFF_PRODUCTION_TARGET } from "../../../scripts/native-staff-cutover-readiness.mjs";

const keys = vi.hoisted(() => ({ getKey: undefined as unknown }));
vi.mock("jose", async importOriginal => ({ ...await importOriginal<typeof import("jose")>(), createRemoteJWKSet: () => keys.getKey }));
// Node route acceptance does not instantiate RPC/workflow/container platform
// classes. The exported fetch dispatcher and all authentication/ACL/CSRF/D1
// implementations remain real; only their otherwise-unused base classes stub.
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
const issuer = "https://synthetic-staff.cloudflareaccess.com", audience = "synthetic-staff-audience", origin = "https://ops.example.test";
const actions = ["staff.onboarding.create", "staff.onboarding.approve", "staff.admission.disable", "staff.membership.manage", "staff.directory_grant.manage", "staff.admin_delegation.manage"];
const directoryCaps = ["directory.profile.view", "directory.profile.edit", "directory.identity.link", "directory.enrollment.manage", "directory.portal_access.manage"];
let runtime: Miniflare, db: D1Database, signingKey: CryptoKey, sequence = 0, seedAdmin: Person;
type Person = { id: string; email: string; subject: string };
const uuid = () => `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
async function staff(): Promise<Person> {
  const id = `lifecycle-${++sequence}`, email = `${id}@example.test`, subject = `access|${id}`;
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(id, email, id, subject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, subject, id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, email, id),
  ]);
  return { id, email, subject };
}
async function administrator(person: Person) {
  await db.batch([...actions, "staff.admission.enable", "staff.profile.edit", "staff.profile.read"].map(capability => db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`).bind(`${person.id}:${capability}`, person.id, capability, person.id)));
  await db.batch([
    ...directoryCaps.map(capability => db.prepare(`INSERT INTO native_staff_delegation_ceilings
      (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
      VALUES(?,?,'directory',?,'allow',1,1,1,1,'global')`).bind(`${person.id}:directory:${capability}`, `${person.id}:staff.directory_grant.manage`, capability)),
    ...actions.map(capability => db.prepare(`INSERT INTO native_staff_delegation_ceilings
      (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
      VALUES(?,?,'staff_admin',?,'allow',1,1,1,1,'global')`).bind(`${person.id}:admin:${capability}`, `${person.id}:staff.admin_delegation.manage`, capability)),
  ]);
}
const authority = (admissionVersion = 1, profileVersion = 1) => ({ admissionVersion, profileVersion, verifiedUntil: new Date(Date.now() + 600_000).toISOString() });
const command = (actor: Person, target: Person, capability = "staff.admission.disable", expectedVersion = 1) => ({ commandId: uuid(),
  contractVersion: 1, capability, actor: { staffId: actor.id, verifiedAccessSubject: actor.subject }, targetStaffId: target.id,
  expectedVersion, reason: "Synthetic joined lifecycle acceptance" });
async function token(person: Person, extras: Record<string, unknown> = {}) {
  return new SignJWT({ email: person.email, type: "app", ...extras }).setProtectedHeader({ alg: "RS256", kid: "synthetic" })
    .setIssuer(issuer).setAudience(audience).setSubject(person.subject).setIssuedAt().setExpirationTime("10m").sign(signingKey);
}
const env = () => ({ OPS_DB: db, TEAM_DOMAIN: issuer, OPERATIONS_AUD: audience }) as Env;
const deps = () => ({ enabledFlag: "true", expectedHost: "ops.example.test", database: db,
  configuration: { enabled: true, issuer, staffAudience: audience, origin, csrfSecret: "synthetic-csrf-secret-only-for-local-fixtures-123" } });
const headers = (assertion: string) => ({ "Cf-Access-Jwt-Assertion": assertion, "Sec-Fetch-Site": "same-origin", "X-Native-Staff-Request": "1" });
async function joinedState(person: Person) {
  return db.prepare(`SELECT s.status,s.email,s.access_subject,s.project_alpha_user_id,s.sync_protected,a.active,a.version,p.version profile_version,p.display_name
    FROM staff_users s JOIN native_staff_admissions a ON a.staff_id=s.id JOIN native_staff_profiles p ON p.staff_id=s.id WHERE s.id=?`).bind(person.id).first();
}

describe("Ops-owned joined staff lifecycle against actual full-chain local D1", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= "0225").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    const pair = await generateKeyPair("RS256"); signingKey = pair.privateKey;
    keys.getKey = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "synthetic", alg: "RS256" }] });
    // Synthetic setup is deliberately direct fixture data, not a production
    // bootstrap approval or evidence that a real identity transfer happened.
    // Explicitly complete synthetic legacy seed bridges for readiness coverage;
    // this is test data, never a production transfer/approval operation.
    for (const row of (await db.prepare(`SELECT s.id,s.email,s.display_name,s.access_subject FROM staff_users s
      LEFT JOIN native_staff_admissions a ON a.staff_id=s.id WHERE a.staff_id IS NULL AND s.status='active'`).all<{
        id:string;email:string;display_name:string;access_subject:string|null }>()).results) {
      const subject = row.access_subject ?? `synthetic|${row.id}`;
      await db.batch([
        db.prepare("UPDATE staff_users SET access_subject=? WHERE id=?").bind(subject,row.id),
        db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(row.id,subject,row.id),
        db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(row.id,row.email,row.display_name),
      ]);
    }
    seedAdmin = await staff(); await administrator(seedAdmin);
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it("defaults cutover off and refuses otherwise-valid commands and HTTP", async () => {
    const actor = await staff(), target = await staff(); await administrator(actor);
    expect(await db.prepare("SELECT enabled FROM native_staff_access_reconciliation").first("enabled")).toBe(0);
    await expect(execute(db, command(actor, target), authority())).rejects.toThrow("operations_staff_lifecycle_denied");
    const response = await handle(new Request(`${origin}${BASE}/session`, { headers: headers(await token(actor)) }), deps());
    expect(response.status).toBe(404);
    expect(await joinedState(target)).toMatchObject({ status: "active", active: 1, version: 1 });
    await db.prepare("UPDATE native_staff_access_reconciliation SET enabled=1 WHERE singleton=1").run();
  });

  it("executes the readiness snapshot as one actual local D1 SELECT and refuses changed bridges", async () => {
    const now = Date.now(), date = new Date(now).toISOString(), sourceCommit = "a".repeat(40);
    await db.prepare("UPDATE native_staff_access_reconciliation SET last_success_at=? WHERE singleton=1").bind(date).run();
    const selected = JSON.parse(await db.prepare(READINESS_QUERY).first<string>("readiness_snapshot") ?? "null");
    const cohort = selected.cohort.map((row: Record<string,unknown>) => ({ ...row, active: row.active === 1 }));
    const hash = (value:string) => createHash("sha256").update(value).digest("hex");
    const cohortSha256 = hash(canonicalStaffReadiness([...cohort].sort((a,b)=>a.staffId.localeCompare(b.staffId))));
    const plan = JSON.stringify({ kind:"operations-native-staff-cutover-v1",cohortSha256,controlPlaneStaffIds:selected.controlPlaneStaffIds });
    const evidence = JSON.stringify({ kind:"operations-native-staff-binding-review-v1",cohortSha256,
      operatorStaffId:seedAdmin.id,operatorSubject:seedAdmin.subject });
    const ref = { approvalId: "synthetic-readiness-approval", commandId: "synthetic-readiness-bootstrap", canonicalPlanSha256: hash(plan),
      bindingEvidenceSha256: hash(evidence), operatorStaffId: seedAdmin.id, operatorSubject: seedAdmin.subject };
    await db.batch([
      db.prepare(`INSERT INTO native_staff_bootstrap_approvals(approval_id,canonical_plan_json,canonical_plan_sha256,
        approved_operator_staff_id,approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,
        issued_by_staff_id,issued_by_access_subject,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(ref.approvalId,plan,hash(plan),seedAdmin.id,seedAdmin.subject,evidence,hash(evidence),seedAdmin.id,seedAdmin.subject,
          new Date(now-1000).toISOString(),new Date(now+60_000).toISOString()),
      db.prepare(`INSERT INTO native_staff_bootstrap_receipts(command_id,approval_id,operator_staff_id,operator_access_subject,
        canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,
        result_json,result_sha256,executed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(ref.commandId,ref.approvalId,seedAdmin.id,seedAdmin.subject,plan,hash(plan),evidence,hash(evidence),"{}",hash("{}"),date),
    ]);
    const review = { schemaVersion: 2, sourceCommit, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
      databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId, cohort,
      handoff:{cohort:structuredClone(cohort),controlPlaneStaffIds:[...selected.controlPlaneStaffIds]},
      bootstrapReceipts: [ref], onboardingReceipts:[] };
    let reads = 0;
    const read = async (args:string[]) => { reads++; expect(args[7]).toBe(READINESS_QUERY);
      return [{ success: true, results: (await db.prepare(args[7]!).all()).results }]; };
    expect(await readNativeStaffCutoverReadiness({ review,sourceCommit,read,now:()=>now })).toMatchObject({ staffCount:cohort.length });
    expect(reads).toBe(1);
    await db.prepare("UPDATE staff_users SET display_name='Changed legacy only' WHERE id=?").bind(seedAdmin.id).run();
    await expect(readNativeStaffCutoverReadiness({ review,sourceCommit,read,now:()=>now })).rejects.toThrow();
    await db.prepare("UPDATE staff_users SET display_name=? WHERE id=?").bind(seedAdmin.id,seedAdmin.id).run();
  });

  it("atomically disables ordinary Ops, existing Viewer renewal JWT, native and Windows authority; re-enable never revives old root grants", async () => {
    const actor = await staff(), target = await staff(); await administrator(actor);
    const assertion = await token(target), request = new Request(`${origin}/api/session`, { headers: headers(assertion) });
    expect((await authenticateStaff(request, env())).id).toBe(target.id);
    expect((await authenticateBoundStaffForViewerRenewal(request, env())).principal.id).toBe(target.id);
    const native = await authenticateNativeStaffWithAdmissionVersion(request, db, deps().configuration);
    const agentId = `synthetic-agent-${++sequence}`, clientId = `${agentId}.access`, agentAudience = "synthetic-agent-audience";
    await db.prepare(`INSERT INTO ops_agent_principals(id,access_client_id,owner_staff_id,owner_access_subject,owner_admission_version,status,expires_at)
      VALUES(?,?,?,?,1,'active',?)`).bind(agentId,clientId,target.id,target.subject,Math.floor(Date.now()/1000)+3600).run();
    const serviceAssertion = await new SignJWT({ type:"app",common_name:clientId }).setSubject("").setIssuer(issuer)
      .setAudience(agentAudience).setIssuedAt().setExpirationTime("10m").setProtectedHeader({alg:"RS256",kid:"synthetic"}).sign(signingKey);
    const agentRequest = () => new Request("https://ops-staging.ledgetopdroneservices.com/api/agent/v1/connection",{
      headers:{"Cf-Access-Jwt-Assertion":serviceAssertion} });
    const agentEnv = { OPS_DB:db,ENVIRONMENT:"staging",TEAM_DOMAIN:issuer,OPERATIONS_AUD:audience,
      OPS_AGENT_READ_ENABLED:"true",OPS_AGENT_READ_AUD:agentAudience };
    expect((await handleAgentRead(agentRequest(),agentEnv)).status).toBe(200);
    const rootId = uuid(), gatewayId = uuid(), grantId = uuid();
    await db.batch([
      db.prepare("INSERT INTO ops_employee_read_roots(root_id,gateway_id,root_fingerprint,status) VALUES(?,?,?,'active')").bind(rootId, gatewayId, "a".repeat(64)),
      db.prepare(`INSERT INTO ops_employee_read_grants(grant_id,root_id,root_generation,root_fingerprint,staff_id,access_subject,admission_version,effect,expires_at)
        VALUES(?,?,1,?,?,?,1,'allow',?)`).bind(grantId, rootId, "a".repeat(64), target.id, target.subject, Math.floor(Date.now() / 1000) + 3600),
    ]);
    const proof = await resolveEmployeeReadAuthority(db, native, rootId); expect(proof).not.toBeNull();
    const input = command(actor, target); expect(await execute(db, input, authority())).toMatchObject({ resultVersion: 2, replayed: false });
    await expect(authenticateStaff(request, env())).rejects.toThrow();
    await expect(authenticateBoundStaffForViewerRenewal(request, env())).rejects.toThrow();
    await expect(authenticateNativeStaffWithAdmissionVersion(request, db, deps().configuration)).rejects.toThrow();
    expect(await recheckEmployeeReadAuthority(db, proof!)).toBe(false);
    expect((await handleAgentRead(agentRequest(),agentEnv)).status).toBe(403);
    expect(await execute(db, input, authority())).toMatchObject({ replayed: true, resultVersion: 2 });
    await execute(db, command(actor, target, "staff.admission.enable", 2), authority());
    expect((await authenticateStaff(request, env())).id).toBe(target.id);
    const refreshed = await authenticateNativeStaffWithAdmissionVersion(request, db, deps().configuration);
    expect(refreshed.admissionVersion).toBe(3);
    expect(await resolveEmployeeReadAuthority(db, refreshed, rootId)).toBeNull();
    expect(await recheckEmployeeReadAuthority(db, proof!)).toBe(false);
    expect((await handleAgentRead(agentRequest(),agentEnv)).status).toBe(403);
    expect(await execute(db, input, authority())).toMatchObject({ replayed: true });
    expect(await joinedState(target)).toMatchObject({ status: "active", active: 1, version: 3 });
    expect(await db.prepare("SELECT count(*) n FROM native_staff_access_reconciliation_events WHERE staff_id=?").bind(target.id).first("n")).toBe(2);
  });

  it("commits a unique immutable reconciliation intent and leaves no fences; rolls back every state on a late failure", async () => {
    const actor = await staff(), target = await staff(); await administrator(actor);
    const input = command(actor, target), before = await db.prepare("SELECT generation FROM native_staff_access_reconciliation").first<number>("generation");
    await db.prepare(`CREATE TRIGGER synthetic_lifecycle_event_failure BEFORE INSERT ON native_staff_access_reconciliation_events
      WHEN NEW.command_id='${input.commandId}' BEGIN SELECT RAISE(ABORT,'synthetic late event failure'); END`).run();
    await expect(execute(db, input, authority())).rejects.toThrow();
    expect(await joinedState(target)).toMatchObject({ status: "active", active: 1, version: 1 });
    expect(await db.prepare("SELECT generation FROM native_staff_access_reconciliation").first("generation")).toBe(before);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_management_commands WHERE command_id=?").bind(input.commandId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_lifecycle_fences").first("n")).toBe(0);
    await db.prepare("DROP TRIGGER synthetic_lifecycle_event_failure").run();
    await execute(db, input, authority());
    const event = await db.prepare("SELECT * FROM native_staff_access_reconciliation_events WHERE command_id=?").bind(input.commandId).first();
    expect(event).toMatchObject({ admission_version: 2, desired_active: 0, generation: before! + 1 });
    await expect(db.prepare("DELETE FROM native_staff_access_reconciliation_events WHERE command_id=?").bind(input.commandId).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE native_staff_access_reconciliation_events SET desired_active=1 WHERE command_id=?").bind(input.commandId).run()).rejects.toThrow();
  });

  it("native admission becomes authoritative after cutover even if a legacy bridge is erroneously active", async () => {
    const target = await staff(), request = new Request(`${origin}/api/session`, { headers: headers(await token(target)) });
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?").bind(target.id).run();
    expect(await joinedState(target)).toMatchObject({ status:"active",active:0,version:2 });
    await expect(authenticateStaff(request,env())).rejects.toMatchObject({status:403});
    await expect(authenticateBoundStaffForViewerRenewal(request,env())).rejects.toMatchObject({status:403});
    // Deliberately repair only this synthetic fixture for later test isolation.
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(target.id).run();
  });

  it("rejects stale actor/target versions, conflicting replay and concurrent commands without partial mutations", async () => {
    const actor = await staff(), target = await staff(); await administrator(actor);
    await expect(execute(db, command(actor, target), authority(99))).rejects.toThrow();
    await expect(execute(db, command(actor, target), authority(1, 99))).rejects.toThrow();
    await expect(execute(db, command(actor, target, "staff.admission.disable", 99), authority())).rejects.toThrow();
    const first = command(actor, target), second = command(actor, target);
    const results = await Promise.allSettled([execute(db, first, authority()), execute(db, second, authority())]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await joinedState(target)).toMatchObject({ status: "inactive", active: 0, version: 2 });
    const winner = results[0]!.status === "fulfilled" ? first : second;
    await expect(execute(db, { ...winner, reason: "Changed replay" }, authority())).rejects.toThrow();
  });

  it("preserves reviewed identity and history and rejects mismatched/missing bridges", async () => {
    const actor = await staff(), target = await staff(); await administrator(actor);
    await db.prepare("UPDATE staff_users SET project_alpha_user_id='historical-pa-user' WHERE id=?").bind(target.id).run();
    await execute(db, { ...command(actor, target, "staff.profile.edit"), displayName: "Updated Display" }, authority());
    expect(await joinedState(target)).toMatchObject({ email: target.email, access_subject: target.subject,
      project_alpha_user_id: "historical-pa-user", display_name: "Updated Display", profile_version: 2, version: 1 });
    await db.prepare("UPDATE staff_users SET access_subject='different-synthetic-subject' WHERE id=?").bind(target.id).run();
    await expect(execute(db, command(actor, target), authority())).rejects.toThrow();
    const legacy = await staff();
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(legacy.id).run();
    await expect(execute(db, command(actor, legacy), authority())).rejects.toThrow();
    await expect(execute(db, command(actor, { id: "missing-staff", email: "missing@example.test", subject: "missing" }), authority())).rejects.toThrow();
  });

  it("enforces explicit deny, scoped authority and protected owner without owner-role bypass", async () => {
    const actor = await staff(), target = await staff(); await administrator(actor);
    await db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,target_staff_id,granted_by)
      VALUES(?,?,'staff.admission.disable','deny','exact_staff',?,?)`).bind(uuid(), actor.id, target.id, actor.id).run();
    await expect(execute(db, command(actor, target), authority())).rejects.toThrow();
    const protectedTarget = await db.prepare("SELECT id,email,access_subject AS subject FROM staff_users WHERE id='staff-beau-koltz'").first<Person>();
    expect(protectedTarget).not.toBeNull();
    await expect(execute(db, command(actor, protectedTarget!), authority())).rejects.toThrow();
    const owner = await staff();
    await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-owner','global','global')").bind(uuid(), owner.id).run();
    await expect(execute(db, command(actor, owner), authority())).rejects.toThrow();
    await expect(execute(db, command(owner, protectedTarget!), authority())).rejects.toThrow();
  });

  it("uses real signed human JWT, actor-bound CSRF and exact origin for supported routes", async () => {
    const actor = await staff(), target = await staff(); await administrator(actor);
    const assertion = await token(actor), h = headers(assertion);
    const session = await handle(new Request(`${origin}${BASE}/session`, { headers: h }), deps());
    expect(session.status).toBe(200);
    const { csrfToken } = await session.json() as { csrfToken: string };
    const value = { commandId: uuid(), expectedVersion: 1, reason: "Synthetic HTTP disable" };
    const request = (overrides: Record<string, string> = {}, body = value) => new Request(`${origin}${BASE}/${target.id}/disable`, {
      method: "POST", headers: { ...h, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrfToken, ...overrides }, body: JSON.stringify(body) });
    expect((await handle(request({ Origin: "https://other.example.test" }), deps())).status).toBe(403);
    expect((await handle(request({ "X-CSRF-Token": "" }), deps())).status).toBe(403);
    expect((await handle(request({ "Sec-Fetch-Site": "cross-site" }), deps())).status).toBe(403);
    expect((await handle(request({ "Cf-Access-Jwt-Assertion": await token(target) }), deps())).status).toBe(403);
    expect((await handle(request(), { ...deps(), enabledFlag: "false" })).status).toBe(404);
    expect((await handle(request(), deps())).status).toBe(200);
    expect((await handle(request(), deps())).status).toBe(200);
    expect(await joinedState(target)).toMatchObject({ status: "inactive", active: 0, version: 2 });
    expect((await handle(new Request(`${origin}${BASE}/${target.id}`, { headers: h }), deps())).status).toBe(200);
    expect((await handle(new Request(`${origin}${BASE}/session`, { headers: headers(await token(actor, { type: "service" })) }), deps())).status).toBe(403);
    expect((await handle(new Request(`${origin}${BASE}/session`, { headers: headers("invalid.jwt.bytes") }), deps())).status).toBe(403);
  });

  it("runs the full mounted worker fetch path for staff lifecycle and denies stale normal Ops/Viewer sessions", async () => {
    const actor = await staff(), target = await staff(); await administrator(actor);
    const actorHeaders = headers(await token(actor)), targetAssertion = await token(target);
    const viewerOrigin = "https://viewer-staging.ledgetopdroneservices.com";
    const mountedEnv: Env = { ...env(), ENVIRONMENT:"staging", EXPECTED_HOST:new URL(origin).hostname,
      PUBLIC_BASE_URL:origin, OPERATIONS_ORIGINS:origin, OPERATIONS_SESSION_SECRET:deps().configuration.csrfSecret,
      VIEWER_INTEGRATION_ENABLED:"true",VIEWER_PROCESSING_ENABLED:"true",VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED:"true",
      VIEWER_BASE_URL:viewerOrigin };
    const waitUntil = vi.fn(), executionContext = { waitUntil,passThroughOnException(){} } as unknown as ExecutionContext;
    const fetch = (request:Request) => worker.fetch(request,mountedEnv,executionContext);
    const nativeSession = () => fetch(new Request(`${origin}${BASE}/session`,{headers:actorHeaders}));
    const nativeRead = () => fetch(new Request(`${origin}${BASE}/${target.id}`,{headers:actorHeaders}));
    const ordinarySession = () => fetch(new Request(`${origin}/api/session/status`,{headers:headers(targetAssertion)}));
    const viewerChallenge = () => fetch(new Request(`${origin}/api/viewer/workspace/session-renewal/challenge`,{
      headers:{"Cf-Access-Jwt-Assertion":targetAssertion,Origin:viewerOrigin} }));
    // The mount must itself remain absent before native authentication while
    // cutover is disabled. This is not a direct handler invocation or auth mock.
    await db.prepare("UPDATE native_staff_access_reconciliation SET enabled=0 WHERE singleton=1").run();
    try {
      const disabled = await fetch(new Request(`${origin}${BASE}/session`,{
        headers:{"Sec-Fetch-Site":"same-origin","X-Native-Staff-Request":"1"} }));
      expect(disabled.status).toBe(404); expect(await disabled.json()).toEqual({error:"not_found"});
      expect((await nativeSession()).status).toBe(404);
    } finally { await db.prepare("UPDATE native_staff_access_reconciliation SET enabled=1 WHERE singleton=1").run(); }

    const session = await nativeSession(); expect(session.status).toBe(200);
    expect(session.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    const {csrfToken} = await session.json() as {csrfToken:string};
    expect(csrfToken).toMatch(/^\d+\.[0-9a-f]{64}$/u);
    const read = await nativeRead(); expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({target:{staffId:target.id,admissionVersion:1,profileVersion:1},
      scopedProfile:{loginEmail:target.email,displayName:target.id}});
    const normal = await ordinarySession(); expect(normal.status).toBe(200);
    expect(await normal.json()).toMatchObject({userId:target.id});
    const challenge = await viewerChallenge(); expect(challenge.status).toBe(200);
    expect(await challenge.json()).toMatchObject({protocolVersion:1,challenge:expect.any(String)});

    const mutation = (action:string,value:Record<string,unknown>,overrides:Record<string,string>={}) => fetch(new Request(
      `${origin}${BASE}/${target.id}/${action}`,{method:"POST",headers:{...actorHeaders,Origin:origin,
        "Content-Type":"application/json","X-CSRF-Token":csrfToken,...overrides},body:JSON.stringify(value)}));
    const disable = {commandId:uuid(),expectedVersion:1,reason:"Synthetic mounted-worker disable"};
    expect((await mutation("disable",disable,{Origin:"https://other.example.test"})).status).toBe(403);
    expect((await mutation("disable",disable,{"Sec-Fetch-Site":"cross-site"})).status).toBe(403);
    expect((await mutation("disable",disable,{"X-CSRF-Token":""})).status).toBe(403);
    expect((await mutation("disable",disable,{"Cf-Access-Jwt-Assertion":targetAssertion})).status).toBe(403);
    expect(await joinedState(target)).toMatchObject({status:"active",active:1,version:1,profile_version:1});

    const edit = await mutation("profile",{commandId:uuid(),expectedVersion:1,reason:"Synthetic mounted-worker profile edit",displayName:"Mounted Profile"});
    expect(edit.status).toBe(200); expect(await edit.json()).toMatchObject({receipt:{capability:"staff.profile.edit",resultVersion:2}});
    expect(await joinedState(target)).toMatchObject({display_name:"Mounted Profile",profile_version:2,status:"active",version:1});
    const offboard = await mutation("disable",disable); expect(offboard.status).toBe(200);
    expect(await offboard.json()).toMatchObject({receipt:{capability:"staff.admission.disable",resultVersion:2}});
    // Reuse the exact same still-unexpired signed JWT after offboarding. The
    // normal mounted middleware and separate mounted renewal boundary must deny.
    expect((await ordinarySession()).status).toBe(403);
    expect((await viewerChallenge()).status).toBe(403);
    expect(await joinedState(target)).toMatchObject({status:"inactive",active:0,version:2});

    const enable = await mutation("enable",{commandId:uuid(),expectedVersion:2,reason:"Synthetic mounted-worker re-enable"});
    expect(enable.status).toBe(200); expect(await enable.json()).toMatchObject({receipt:{capability:"staff.admission.enable",resultVersion:3}});
    expect((await ordinarySession()).status).toBe(200);
    expect((await viewerChallenge()).status).toBe(200);
    const finalRead = await nativeRead(); expect(finalRead.status).toBe(200);
    expect(await finalRead.json()).toMatchObject({target:{admissionActive:true,admissionVersion:3,profileVersion:2},scopedProfile:{displayName:"Mounted Profile"}});
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("materializes real fenced 0073/0074 onboarding and can manage PA-sync-protected normal staff without changing their identity", async () => {
    const actor = await staff(); await administrator(actor);
    const target:Person = {id:`onboarded-${++sequence}`,email:`onboarded-${sequence}@example.test`,subject:`access|onboarded-${sequence}`};
    const onboardingId = uuid(), createId = uuid(), approveId = uuid(), reason = "Synthetic SQL onboarding contract acceptance";
    const proposal = {memberships:[],directoryGrants:[],managementGrants:[]}, proposalJson = JSON.stringify(proposal);
    const hash = (value:string) => createHash("sha256").update(value).digest("hex");
    const proposalSha256 = hash(proposalJson), invitationSecretSha256 = hash("synthetic-onboarding-secret-not-a-production-key");
    const createdAt = new Date().toISOString(), expiresAt = new Date(Date.now()+600_000).toISOString();
    const created = {contractVersion:1,capability:"staff.onboarding.create",onboardingId,proposedStaffId:target.id,
      loginEmail:target.email,displayName:target.id,expiresAt,proposal,proposalSha256,invitationSecretSha256,resultVersion:1};
    const createJson = JSON.stringify(created), createResultSha256 = hash(createJson);
    const insertFence = (commandId:string,capability:string,expectedVersion:number,resultJson:string) => db.prepare(`INSERT INTO native_staff_management_fences
      (target_kind,target_onboarding_id,target_proposed_staff_id,command_id,request_sha256,contract_version,capability,
       actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256,created_at)
      VALUES('onboarding',?,?,?,?,1,?,?,?,NULL,?,?,?,NULL,?,?,?)`)
      .bind(onboardingId,target.id,commandId,hash(`${commandId}:${resultJson}`),capability,actor.id,actor.subject,
        expectedVersion,expectedVersion+1,reason,resultJson,hash(resultJson),createdAt);
    const receipt = (commandId:string) => db.prepare(`INSERT INTO native_staff_management_commands
      (target_kind,target_onboarding_id,target_proposed_staff_id,command_id,request_sha256,contract_version,capability,
       actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256)
      SELECT target_kind,target_onboarding_id,target_proposed_staff_id,command_id,request_sha256,contract_version,capability,
       actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256
      FROM native_staff_management_fences WHERE command_id=?`).bind(commandId);
    // Exercise the actual creation triggers and immutable receipt; a pending row
    // or direct staff seed cannot substitute for this fenced reservation.
    await db.batch([
      insertFence(createId,"staff.onboarding.create",0,createJson),
      db.prepare(`INSERT INTO native_staff_pending_onboarding(onboarding_id,proposed_staff_id,login_email,display_name,
        invitation_secret_sha256,expires_at,state,version,proposal_json,proposal_sha256,created_by_staff_id,created_by_subject,reason,created_at)
        VALUES(?,?,?,?,?,?,'pending',1,?,?,?,?,?,?)`).bind(onboardingId,target.id,target.email,target.id,invitationSecretSha256,
          expiresAt,proposalJson,proposalSha256,actor.id,actor.subject,reason,createdAt),
      receipt(createId),
    ]);
    expect(await db.prepare("SELECT result_sha256 FROM native_staff_management_commands WHERE command_id=?").bind(createId).first("result_sha256")).toBe(createResultSha256);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?").bind(target.id).first("n")).toBe(0);
    // The local fixture records a synthetic claim. It does not implement or
    // claim qualification of a new invitation/claim web endpoint.
    const claimEvidenceSha256 = hash(JSON.stringify({syntheticOnly:true,staffId:target.id,email:target.email,subject:target.subject}));
    await db.prepare(`UPDATE native_staff_pending_onboarding SET state='claimed',version=2,claimed_access_subject=?,
      claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),claim_evidence_sha256=? WHERE onboarding_id=? AND state='pending' AND version=1`)
      .bind(target.subject,claimEvidenceSha256,onboardingId).run();
    const approved = {contractVersion:1,capability:"staff.onboarding.approve",targetOnboardingId:onboardingId,
      proposedStaffId:target.id,proposalSha256,claimEvidenceSha256,claimedAccessSubject:target.subject,proposal,resultVersion:3};
    const approvalJson = JSON.stringify(approved);
    // Actual 0074 materialization requires local + sync_protected=1. Native
    // lifecycle must respect that PA guard while managing this ordinary user.
    await db.batch([
      insertFence(approveId,"staff.onboarding.approve",2,approvalJson),
      db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,project_alpha_user_id,status,provisioning_source,sync_protected)
        VALUES(?,?,?,?,NULL,'active','local',1)`).bind(target.id,target.email,target.id,target.subject),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(target.id,target.subject,actor.id),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(target.id,target.email,target.id),
      db.prepare("UPDATE native_staff_management_fences SET mutation_writes=0 WHERE command_id=? AND mutation_writes=1").bind(approveId),
      receipt(approveId),
    ]);
    expect(await db.prepare("SELECT state,version,approval_command_id FROM native_staff_pending_onboarding WHERE onboarding_id=?").bind(onboardingId).first())
      .toEqual({state:"approved",version:3,approval_command_id:approveId});
    const history = (await db.prepare("SELECT command_id,result_json,result_sha256 FROM native_staff_management_commands WHERE command_id IN (?,?) ORDER BY command_id")
      .bind(createId,approveId).all()).results;
    expect(history).toHaveLength(2);
    expect(await joinedState(target)).toMatchObject({sync_protected:1,project_alpha_user_id:null,access_subject:target.subject,active:1,version:1});
    await execute(db,{...command(actor,target,"staff.profile.edit"),displayName:"Onboarded Updated Profile"},authority());
    await execute(db,command(actor,target),authority());
    expect(await joinedState(target)).toMatchObject({sync_protected:1,project_alpha_user_id:null,access_subject:target.subject,
      email:target.email,status:"inactive",active:0,version:2,profile_version:2,display_name:"Onboarded Updated Profile"});
    await execute(db,command(actor,target,"staff.admission.enable",2),authority());
    expect(await joinedState(target)).toMatchObject({sync_protected:1,project_alpha_user_id:null,access_subject:target.subject,
      email:target.email,status:"active",active:1,version:3,profile_version:2});
    expect((await db.prepare("SELECT command_id,result_json,result_sha256 FROM native_staff_management_commands WHERE command_id IN (?,?) ORDER BY command_id")
      .bind(createId,approveId).all()).results).toEqual(history);
    const observed = JSON.parse(await db.prepare(READINESS_QUERY).first<string>("readiness_snapshot") ?? "null") as {
      onboardingReceipts:Array<{commandId:string;createCommandId:string;staffId:string;valid:number;resultSha256:string;createResultSha256:string}>};
    expect(observed.onboardingReceipts.find(row=>row.staffId===target.id)).toMatchObject({commandId:approveId,createCommandId:createId,
      staffId:target.id,valid:1,resultSha256:hash(approvalJson),createResultSha256});
    // An explicit native deny still protects a PA-sync-immune employee.
    await db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,target_staff_id,granted_by)
      VALUES(?,?,'staff.admission.disable','deny','exact_staff',?,?)`).bind(uuid(),actor.id,target.id,actor.id).run();
    await expect(execute(db,command(actor,target,"staff.admission.disable",3),authority())).rejects.toThrow();
    expect(await joinedState(target)).toMatchObject({sync_protected:1,status:"active",active:1,version:3});
  });

  it("cannot disable the last complete native control plane and rolls the bridge back with it", async () => {
    const actor = await staff(); await administrator(actor);
    const unusable = await staff(); await administrator(unusable);
    await db.prepare("UPDATE native_staff_management_delegations SET active=0,version=version+1 WHERE actor_staff_id=? AND capability='staff.admission.enable'").bind(unusable.id).run();
    expect(await db.prepare("SELECT count(*) n FROM native_staff_control_plane_candidates WHERE staff_id=?").bind(unusable.id).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_lifecycle_control_plane_candidates WHERE staff_id=?").bind(unusable.id).first("n")).toBe(0);
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id NOT IN (?,?) AND active=1").bind(actor.id,unusable.id).run();
    await expect(execute(db, command(actor, actor), authority())).rejects.toThrow();
    expect(await joinedState(actor)).toMatchObject({ status: "active", active: 1, version: 1 });
    expect(await db.prepare("SELECT count(*) n FROM native_staff_lifecycle_fences").first("n")).toBe(0);
  });
});
