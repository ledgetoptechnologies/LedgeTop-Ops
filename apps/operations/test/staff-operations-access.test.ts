// Native staff Operations-access writer (migration 0244) through the real
// mounted Operations worker: real RS256 Access assertions, real auth/CSRF/ACL,
// every current Operations migration in local D1 (Miniflare), hires created by
// the real invitation -> claim -> approval flow. Covers design §8 P1-P6 and
// N1-N16, R2.4 and the Codex GO conditions. Activation (N17/R2.7) and N18 are in
// staff-operations-access-activation.test.ts. Synthetic identities and hosts only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OperationsAccessFixture, origin, issuer, type Person } from "./helpers/staff-operations-access-fixture";
import { authenticateNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import { changeStaffOperationsAccess, openStaffOperationsAccess } from "../src/worker/staff-operations-access";
import { auditStatement, csrfToken } from "../src/worker/request-security";
import { setStaffUsername } from "../src/worker/staff-directory-lookup";
import { claimStaffLoginBindingIntent, createStaffLoginBindingIntent, resolveVerifiedStaffLogin, revokeStaffLoginBinding } from "../src/worker/staff-login-bindings";
import type { StaffPrincipal } from "../src/worker/types";

const keys = vi.hoisted(() => ({ resolver: undefined as unknown }));
vi.mock("../src/worker/access-jwks", () => ({ accessJwksResolver: () => keys.resolver }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

let f: OperationsAccessFixture;
const DIVISION = "division-synthetic-ops-access";
const sql = (text: string, ...values: unknown[]) => f.db.prepare(text).bind(...values).run();
const override = (staffId: string, permission: string, effect: "allow" | "deny", scope: "global" | "division" = "global", id = f.uuid()) =>
  sql(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,?,?,?,?,?,?)`,
    id, staffId, permission, effect, scope, scope === "division" ? DIVISION : null, scope === "division" ? DIVISION : "global", staffId);
const admin = (options: Parameters<OperationsAccessFixture["person"]>[0] = {}) => f.person({ role: "role-admin", ...options });
async function roster(who: Person) {
  return f.fetch(new Request(`${origin}/api/team/staff`, { headers: { "Cf-Access-Jwt-Assertion": await f.token(who.email, who.subject) } }));
}
async function directActor(who: Person, token?: string) {
  return authenticateNativeStaffWithAdmissionVersion(new Request(origin, { headers: {
    "Cf-Access-Jwt-Assertion": token ?? await f.token(who.email, who.subject) } }), f.db, { enabled: true, issuer, staffAudience: "synthetic-ops-access-staff" });
}
async function directAudit(who: Person, targetId: string) {
  const principal: StaffPrincipal = { id: who.id, email: who.email, displayName: who.id, accessSubject: who.subject, projectAlphaUserId: null };
  return auditStatement(f.env(), new Request(origin), principal, "staff.operations_access.granted", "staff", targetId, null);
}

describe("native staff Operations-access writer (full current D1 chain, mounted worker)", { timeout: 180_000 }, () => {
  let fixedOwnerId: string;
  beforeAll(async () => {
    f = await OperationsAccessFixture.create(keys, "a1000000");
    await f.seedOnboarders();
    await sql("INSERT INTO divisions(id,name,code) VALUES(?,?,?)", DIVISION, "Synthetic division", "synthetic-ops-access");
    const owners = await f.db.prepare("SELECT staff_id FROM staff_role_assignments WHERE role_id='role-owner' AND scope='global'").all<{ staff_id: string }>();
    expect(owners.results).toHaveLength(1);
    fixedOwnerId = owners.results[0]!.staff_id;
  }, 300_000);
  afterAll(async () => f?.dispose());

  it("P1/P2: a grant lets the hire's next request pass; a revoke returns it to 403", async () => {
    const actor = await admin(), hire = await f.nativeHire();
    expect((await roster(hire)).status).toBe(403);
    const granted = await f.change(actor, hire.id, "team.view");
    expect(granted.response.status, await granted.response.clone().text()).toBe(200);
    expect(await granted.response.json()).toEqual({ receipt: { commandId: granted.body.commandId, staffId: hire.id,
      permission: "team.view", operation: "grant", revision: 1, replayed: false } });
    expect((await f.overrideRow(hire.id, "team.view")).results).toEqual([{ id: `native-ops-access:${hire.id}:team.view`,
      effect: "allow", scope: "global", created_by: actor.id }]);
    expect((await roster(hire)).status).toBe(200);
    const revoked = await f.change(actor, hire.id, "team.view");
    expect(revoked.body.operation).toBe("revoke");
    expect(revoked.response.status).toBe(200);
    expect(await revoked.response.json()).toMatchObject({ receipt: { operation: "revoke", revision: 2, replayed: false } });
    expect((await f.overrideRow(hire.id, "team.view")).results).toEqual([]);
    expect((await roster(hire)).status).toBe(403);
    expect(await f.db.prepare(`SELECT action FROM audit_events WHERE entity_id=? AND actor_id=? ORDER BY id`).bind(hire.id, actor.id).all())
      .toMatchObject({ results: [{ action: "staff.operations_access.granted" }, { action: "staff.operations_access.revoked" }] });
    expect(await f.db.prepare("SELECT revision FROM staff_operations_access_state WHERE staff_id=?").bind(hire.id).first("revision")).toBe(2);
  });

  it("P3/N9: an exact replay returns the stored receipt; the same commandId with another body is command_conflict", async () => {
    const actor = await admin(), hire = await f.nativeHire();
    const { body, view } = await f.command(actor, hire.id, "delivery.browse");
    expect((await f.post(actor, hire.id, body, { csrf: view.csrfToken })).status).toBe(200);
    const before = await f.totals();
    const replay = await f.post(actor, hire.id, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ receipt: { commandId: body.commandId, revision: 1, replayed: true } });
    expect(await f.totals()).toEqual(before);
    await f.refused(() => f.post(actor, hire.id, { ...body, reason: "A different reason" }), 409, "command_conflict");
    await f.refused(() => f.post(actor, hire.id, { ...body, permission: "team.view" }), 409, "command_conflict");
  });

  it("P4/N3: a scoped actor grants what it holds; a lacking or any-scope denied ceiling refuses (view_all needs an explicit allow)", async () => {
    const scoped = await admin({ deny: ["delivery.share.create"] }), hire = await f.nativeHire();
    await override(scoped.id, "viewer.view", "deny", "division");
    const view = await f.view(scoped, hire.id);
    const entry = (permission: string) => view.permissions.find(item => item.permission === permission)!;
    expect(entry("team.view")).toEqual({ permission: "team.view", state: "none", operation: "grant", editable: true, reason: null });
    expect(entry("delivery.share.create")).toMatchObject({ editable: false, reason: "actor_denied" });
    expect(entry("viewer.view")).toMatchObject({ editable: false, reason: "actor_denied" });
    // role-admin includes operations.view_all, but only an explicit override allow is a ceiling for it.
    expect(entry("operations.view_all")).toMatchObject({ editable: false, reason: "actor_lacks_permission" });
    expect((await f.change(scoped, hire.id, "team.view")).response.status).toBe(200);
    for (const [permission, reason] of [["delivery.share.create", "actor_denied"], ["viewer.view", "actor_denied"],
      ["operations.view_all", "actor_lacks_permission"]] as const) {
      const { body, view: current } = await f.command(scoped, hire.id, permission, "grant");
      await f.refused(() => f.post(scoped, hire.id, body, { csrf: current.csrfToken }), 403, "staff_operations_access_denied", reason);
    }
    const explicit = await admin({ allow: ["operations.view_all"] });
    expect((await f.change(explicit, hire.id, "operations.view_all")).response.status).toBe(200);
    // Revoke also needs the ceiling (review default): the role-only admin cannot revoke it.
    const { body, view: current } = await f.command(scoped, hire.id, "operations.view_all", "revoke");
    expect(current.permissions.find(item => item.permission === "operations.view_all")).toMatchObject({ state: "allow", operation: "revoke", editable: false, reason: "actor_lacks_permission" });
    await f.refused(() => f.post(scoped, hire.id, body, { csrf: current.csrfToken }), 403, "staff_operations_access_denied", "actor_lacks_permission");
    expect((await f.change(explicit, hire.id, "operations.view_all")).response.status).toBe(200);
  });

  it("P5: a hire whose invitation creator approved a different claimant is editable", async () => {
    const both = await f.person({ delegations: ["staff.onboarding.create", "staff.onboarding.approve"] });
    const hire = await f.nativeHire({ creator: both, approver: both });
    expect(hire.id).not.toBe(both.id);
    const actor = await admin();
    expect((await f.view(actor, hire.id)).targetEditable).toBe(true);
    expect((await f.change(actor, hire.id, "sops.assign")).response.status).toBe(200);
  });

  it("P6: the GET editable matrix equals the POST outcome for every catalog permission", async () => {
    const actor = await admin(), hire = await f.nativeHire();
    await override(actor.id, "viewer.view", "deny", "division");
    await f.withoutInsertGuard(async () => {
      await override(hire.id, "viewer.publish", "deny", "division");
      await override(hire.id, "sops.assign", "allow");
    });
    await sql("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-delivery-coordinator','global','global')", f.uuid(), hire.id);
    expect((await f.change(actor, hire.id, "team.view")).response.status).toBe(200);
    const matrix = (await f.view(actor, hire.id)).permissions;
    const reasons = Object.fromEntries(matrix.map(entry => [entry.permission, entry.reason]));
    expect(reasons).toMatchObject({ "viewer.publish": "target_denied", "sops.assign": "not_command_managed", "delivery.browse": "inherited",
      "viewer.view": "actor_denied", "operations.view_all": "actor_lacks_permission", "team.view": null, "administration.view": null });
    expect(matrix.find(entry => entry.permission === "team.view")).toMatchObject({ state: "allow", operation: "revoke", editable: true });
    for (const entry of matrix) {
      const { body, view } = await f.command(actor, hire.id, entry.permission, entry.operation ?? "grant");
      const send = () => f.post(actor, hire.id, body, { csrf: view.csrfToken });
      if (entry.editable) expect((await send()).status, entry.permission).toBe(200);
      else await f.refused(send, ["actor_denied", "actor_lacks_permission"].includes(entry.reason!) ? 403 : 409);
    }
  });

  it("N1/N2: the owner/admin gate and roles.manage are both required; any-scope roles.manage deny refuses", async () => {
    const hire = await f.nativeHire();
    const managerOnly = await f.person({ allow: ["roles.manage", "team.view"] });
    const localAdmin = await f.person({});
    await sql("INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,division_id,created_by) VALUES(?,?,'role-admin','global',NULL,?)", f.uuid(), localAdmin.id, localAdmin.id);
    const plain = await f.person({});
    for (const who of [managerOnly, localAdmin, plain]) {
      await f.refused(() => f.get(who, hire.id), 403, "staff_operations_access_denied", "actor_not_administrator");
      const csrf = await csrfToken(f.env(), { accessSubject: who.subject } as StaffPrincipal);
      await f.refused(() => f.post(who, hire.id, { commandId: crypto.randomUUID(), permission: "team.view", operation: "grant",
        expectedRevision: 0, expectedAdmissionVersion: 1, reason: "Refused" }, { csrf }), 403, "staff_operations_access_denied");
    }
    const globalDeny = await admin({ deny: ["roles.manage"] }), divisionDeny = await admin();
    await override(divisionDeny.id, "roles.manage", "deny", "division");
    for (const who of [globalDeny, divisionDeny]) await f.refused(() => f.get(who, hire.id), 403, "staff_operations_access_denied", "actor_denied");
    // The trigger refuses even a hand-written command from these actors.
    await expect(insertCommand(divisionDeny, hire, "team.view")).rejects.toThrow(/staff_operations_access_denied/);
    await expect(insertCommand(managerOnly, hire, "team.view")).rejects.toThrow(/staff_operations_access_denied/);
  });

  async function insertCommand(actor: Person, target: Person, permission: string, extra: { operation?: string; revision?: number; admission?: number } = {}) {
    return sql(`INSERT INTO staff_operations_access_commands(command_id,request_sha256,actor_staff_id,actor_subject,actor_email,
      actor_admission_version,actor_profile_version,actor_verified_until_ms,actor_login_json,target_staff_id,target_admission_version,
      permission,operation,override_id,expected_revision,result_revision,reason) VALUES(?,?,?,?,?,1,1,?,NULL,?,?,?,?,?,?,?,'Direct SQL')`,
    crypto.randomUUID(), "a".repeat(64), actor.id, actor.subject, actor.email, Date.now() + 600_000, target.id, extra.admission ?? 1,
    permission, extra.operation ?? "grant", `native-ops-access:${target.id}:${permission}`, extra.revision ?? 0, (extra.revision ?? 0) + 1);
  }

  it("N4: non-catalog keys are rejected, and the frozen catalog cannot be modified", async () => {
    const actor = await admin({ allow: ["operations.view_all"] }), hire = await f.nativeHire();
    for (const permission of ["roles.manage", "viewer.storage.purge", "administration.manage", "unknown.synthetic"]) {
      const { body, view } = await f.command(actor, hire.id, "team.view");
      await f.refused(() => f.post(actor, hire.id, { ...body, permission }, { csrf: view.csrfToken }), 400, "permission_not_grantable");
      if (permission !== "unknown.synthetic" && permission !== "administration.manage")
        await expect(insertCommand(actor, hire, permission)).rejects.toThrow(/staff_operations_access_denied/);
    }
    await expect(sql("INSERT INTO staff_operations_access_catalog VALUES('roles.manage',0)")).rejects.toThrow(/staff_operations_access_catalog_frozen/);
    await expect(sql("UPDATE staff_operations_access_catalog SET requires_explicit_actor_allow=0")).rejects.toThrow(/staff_operations_access_catalog_frozen/);
    await expect(sql("DELETE FROM staff_operations_access_catalog")).rejects.toThrow(/staff_operations_access_catalog_frozen/);
    expect(await f.db.prepare("SELECT count(*) n FROM staff_operations_access_catalog").first("n")).toBe(15);
  });

  it("N5/N6: self and owners (either role table) are never editable; the fixed owner is not a native hire", async () => {
    const actor = await admin();
    const hireAdmin = await f.nativeHire();
    await sql("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-admin','global','global')", f.uuid(), hireAdmin.id);
    const ownerHire = await f.nativeHire(), localOwnerHire = await f.nativeHire();
    await sql("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-owner','global','global')", f.uuid(), ownerHire.id);
    await sql("INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,division_id,created_by) VALUES(?,?,'role-owner','global',NULL,?)", f.uuid(), localOwnerHire.id, actor.id);
    for (const [who, target, reason] of [[actor, actor.id, "self"], [hireAdmin, hireAdmin.id, "self"],
      [actor, ownerHire.id, "protected_owner"], [actor, localOwnerHire.id, "protected_owner"], [actor, fixedOwnerId, "not_native_hire"]] as const) {
      const view = await f.view(who, target);
      expect(view).toMatchObject({ targetEditable: false, targetReason: reason });
      expect(view.permissions.every(entry => !entry.editable && entry.reason === reason)).toBe(true);
      await f.refused(() => f.post(who, target, { commandId: crypto.randomUUID(), permission: "team.view", operation: "grant",
        expectedRevision: 0, expectedAdmissionVersion: view.targetAdmissionVersion ?? 1, reason: "Refused" }, { csrf: view.csrfToken }), 409, "not_editable", reason);
    }
    await expect(insertCommand(actor, ownerHire, "team.view")).rejects.toThrow(/staff_operations_access_denied/);
    await expect(insertCommand(hireAdmin, hireAdmin, "team.view")).rejects.toThrow(/staff_operations_access_denied/);
  });

  it("N7: Project Alpha-linked, unprotected or non-native targets are refused; provenance still guards their override rows", async () => {
    const actor = await admin();
    const linked = await f.nativeHire(), unprotected = await f.nativeHire();
    await sql("UPDATE staff_users SET project_alpha_user_id='pa-synthetic-ops-access' WHERE id=?", linked.id);
    await sql("UPDATE staff_users SET sync_protected=0 WHERE id=?", unprotected.id);
    const lookalike = await f.person({ local: true, syncProtected: true }), legacy = await f.person({ native: false });
    for (const target of [linked.id, unprotected.id, lookalike.id, legacy.id]) {
      const view = await f.view(actor, target);
      expect(view).toMatchObject({ targetEditable: false, targetReason: "not_native_hire" });
      await f.refused(() => f.post(actor, target, { commandId: crypto.randomUUID(), permission: "team.view", operation: "grant",
        expectedRevision: 0, expectedAdmissionVersion: 1, reason: "Refused" }, { csrf: view.csrfToken }), 409, "not_editable", "not_native_hire");
    }
    // The guard follows the immutable onboarding provenance, not the mutable flags.
    await expect(override(unprotected.id, "team.view", "allow")).rejects.toThrow(/staff_operations_access_override_requires_command/);
    await override(lookalike.id, "team.view", "allow");
    await sql("DELETE FROM staff_permission_overrides WHERE staff_id=?", lookalike.id);
  });

  it("N8: a stale revision or admission version is state_mismatch", async () => {
    const actor = await admin(), hire = await f.nativeHire();
    const { body, view } = await f.command(actor, hire.id, "team.view");
    expect((await f.change(actor, hire.id, "delivery.share.audit")).response.status).toBe(200);
    await f.refused(() => f.post(actor, hire.id, body, { csrf: view.csrfToken }), 409, "state_mismatch");
    const fresh = await f.command(actor, hire.id, "team.view");
    await f.refused(() => f.post(actor, hire.id, { ...fresh.body, expectedAdmissionVersion: 2 }, { csrf: fresh.view.csrfToken }), 409, "state_mismatch");
    await f.refused(() => f.post(actor, hire.id, { ...fresh.body, operation: "revoke" }, { csrf: fresh.view.csrfToken }), 409, "state_mismatch");
  });

  it("N10: a change between read and write aborts the whole batch (authority, deny, ceiling, owner, archive, subject)", async () => {
    const hire = await f.nativeHire();
    const cases: Array<[string, (actor: Person) => Promise<unknown>, number, string, string?]> = [
      ["loses the admin role and roles.manage", actor => sql("DELETE FROM staff_role_assignments WHERE staff_id=?", actor.id), 403, "team.view"],
      ["gains a division roles.manage deny", actor => override(actor.id, "roles.manage", "deny", "division"), 403, "team.view"],
      ["loses the explicit ceiling", actor => sql("DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key='operations.view_all'", actor.id), 403, "operations.view_all"],
      ["gains a division deny on the permission", actor => override(actor.id, "team.view", "deny", "division"), 403, "team.view"],
      ["actor is archived", actor => f.db.batch([f.db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?").bind(actor.id),
        f.db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(actor.id)]), 403, "team.view"],
      ["actor's subject is rotated", actor => sql("UPDATE staff_users SET access_subject=? WHERE id=?", `${actor.subject}-rotated`, actor.id), 403, "team.view"],
      ["target becomes an owner", () => sql("INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,division_id,created_by) VALUES(?,?,'role-owner','global',NULL,?)", f.uuid(), hire.id, f.creator.id), 409, "team.view", "protected_owner"],
    ];
    for (const [label, change, status, permission] of cases) {
      const actor = await admin({ allow: ["operations.view_all"] });
      const { body, view } = await f.command(actor, hire.id, permission);
      expect(view.permissions.find(entry => entry.permission === permission)?.editable, label).toBe(true);
      f.beforeBatch = async () => { await change(actor); };
      // The race itself writes rows; everything the command would write must be absent.
      const before = { ...await f.totals(), overrides: undefined, target: (await f.overrideRow(hire.id, permission)).results };
      const response = await f.post(actor, hire.id, body, { csrf: view.csrfToken });
      expect(response.status, `${label}: ${await response.text()}`).toBe(status);
      expect(f.beforeBatch, label).toBeUndefined();
      expect({ ...await f.totals(), overrides: undefined, target: (await f.overrideRow(hire.id, permission)).results }, label).toEqual(before);
    }
    expect(await f.db.prepare("SELECT count(*) n FROM staff_operations_access_commands WHERE target_staff_id=?").bind(hire.id).first("n")).toBe(0);
  });

  it("N11/N15: a grant over a target deny, or to an inactive target, is refused; revoke on an inactive target is allowed", async () => {
    const actor = await admin(), hire = await f.nativeHire(), lifecycle = await f.lifecycleManager();
    await f.withoutInsertGuard(() => override(hire.id, "viewer.publish", "deny", "division"));
    const denied = await f.command(actor, hire.id, "viewer.publish", "grant");
    expect(denied.entry).toMatchObject({ state: "deny", editable: false, reason: "target_denied" });
    await f.refused(() => f.post(actor, hire.id, denied.body, { csrf: denied.view.csrfToken }), 409, "not_editable", "target_denied");
    expect((await f.change(actor, hire.id, "team.view")).response.status).toBe(200);
    await sql("UPDATE native_staff_access_reconciliation SET enabled=1 WHERE singleton=1");
    try {
      await lifecycle.run("staff.admission.disable", hire.id, 1);
      const view = await f.view(actor, hire.id);
      expect(view).toMatchObject({ targetAdmissionVersion: 2, targetEditable: true });
      expect(view.permissions.find(entry => entry.permission === "sops.assign")).toMatchObject({ operation: "grant", editable: false, reason: "target_inactive" });
      expect(view.permissions.find(entry => entry.permission === "team.view")).toMatchObject({ operation: "revoke", editable: true });
      const grant = await f.command(actor, hire.id, "sops.assign");
      await f.refused(() => f.post(actor, hire.id, grant.body, { csrf: grant.view.csrfToken }), 409, "not_editable", "target_inactive");
      expect((await f.change(actor, hire.id, "team.view")).response.status).toBe(200);
      await lifecycle.run("staff.admission.enable", hire.id, 2);
      expect((await f.change(actor, hire.id, "sops.assign")).response.status).toBe(200);
      expect(await f.db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id=?").bind(hire.id).first()).toEqual({ active: 1, version: 3 });
    } finally { await sql("UPDATE native_staff_access_reconciliation SET enabled=0 WHERE singleton=1"); }
  });

  it("N12/R2.3: the guard refuses every non-command or mismatched write on native-hire rows; other rows and the legacy writer still work", async () => {
    const actor = await admin(), hire = await f.nativeHire(), ordinary = await f.person({ native: false });
    expect((await f.change(actor, hire.id, "team.view")).response.status).toBe(200);
    const managed = `native-ops-access:${hire.id}:team.view`;
    await override(ordinary.id, "sops.assign", "deny");
    const before = await f.totals();
    const insert = (id: string, permission: string, effect: string, scope: string, createdBy: string) =>
      sql(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,?,?,?,?,?,?)`,
        id, hire.id, permission, effect, scope, scope === "division" ? DIVISION : null, scope === "division" ? DIVISION : "global", createdBy);
    for (const attempt of [
      () => insert(`native-ops-access:${hire.id}:sops.assign`, "sops.assign", "allow", "global", actor.id),
      () => insert(f.uuid(), "sops.assign", "allow", "global", actor.id),
      () => insert(f.uuid(), "sops.assign", "deny", "global", actor.id),
      () => insert(f.uuid(), "sops.assign", "allow", "division", actor.id),
      () => sql("INSERT OR REPLACE INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,'team.view','allow','global',NULL,'global',?)", managed, hire.id, actor.id),
      () => sql("DELETE FROM staff_permission_overrides WHERE id=?", managed),
      () => sql("DELETE FROM staff_permission_overrides WHERE staff_id=?", hire.id),
    ]) await expect(attempt()).rejects.toThrow(/staff_operations_access_override_requires_command/);
    for (const attempt of [
      () => sql("UPDATE staff_permission_overrides SET created_by=? WHERE id=?", hire.id, managed),
      () => sql("UPDATE staff_permission_overrides SET effect='allow' WHERE id=?", managed),
      () => sql("UPDATE staff_permission_overrides SET staff_id=? WHERE staff_id=?", hire.id, ordinary.id),
    ]) await expect(attempt()).rejects.toThrow(/staff_operations_access_override_immutable/);
    // A command-shaped write for a different permission, actor or revision is not the in-flight command.
    await expect(insertCommand(actor, hire, "sops.assign", { revision: 0 })).rejects.toThrow(/staff_operations_access_denied/);
    expect(await f.totals()).toEqual(before);
    // Legacy writer: still 409 for the hire, unchanged for an ordinary row.
    const put = async (targetId: string) => f.fetch(new Request(`${origin}/api/admin/staff/${encodeURIComponent(targetId)}/access-controls`, { method: "PUT",
      body: JSON.stringify(Object.fromEntries(["allOperations", "sopAssignment", "deliveryBrowse", "deliveryLinkCreate", "deliveryLinkRevoke", "deliveryLinkAudit",
        "teamRoster", "administration", "viewerAccess", "viewerDatasets", "viewerProcessing", "viewerPublish", "viewerShareCreate", "viewerShareRevoke",
        "viewerClientAccess", "viewerStoragePurge"].map(key => [key, key === "deliveryBrowse"]))),
      headers: { "Cf-Access-Jwt-Assertion": await f.token(actor.email, actor.subject), Origin: origin, "Content-Type": "application/json",
        "X-CSRF-Token": await csrfToken(f.env(), { accessSubject: actor.subject } as StaffPrincipal) } }));
    expect((await put(hire.id)).status).toBe(409);
    expect(await f.totals()).toEqual(before);
    expect((await put(ordinary.id)).status).toBe(200);
    expect((await put(ordinary.id)).status).toBe(200);
    await override(ordinary.id, "team.view", "deny", "division");
    await sql("UPDATE staff_permission_overrides SET created_by=? WHERE staff_id=?", actor.id, ordinary.id);
    await sql("DELETE FROM staff_permission_overrides WHERE staff_id=? AND scope='division'", ordinary.id);
  });

  it("N13: a username grants nothing", async () => {
    const actor = await admin(), hire = await f.nativeHire();
    await setStaffUsername(f.db, hire.id, "team.view", actor.id).catch(() => undefined);
    await setStaffUsername(f.db, hire.id, `pilot${f.sequence}`, actor.id);
    const view = await f.view(actor, hire.id);
    expect(view.revision).toBe(0);
    expect(view.permissions.every(entry => entry.state === "none")).toBe(true);
    expect((await roster(hire)).status).toBe(403);
  });

  it("N14: bad CSRF, cross-origin, the claimant audience and an expired verifiedUntil are refused", async () => {
    const actor = await admin(), hire = await f.nativeHire();
    const { body, view } = await f.command(actor, hire.id, "team.view");
    await f.refused(() => f.post(actor, hire.id, body, { csrf: "0".repeat(43) }), 403);
    await f.refused(() => f.post(actor, hire.id, body, { csrf: view.csrfToken, origin: "https://attacker.example.test" }), 403);
    const claimant = await f.token(actor.email, actor.subject, { audience: "synthetic-ops-access-claimant" });
    await f.refused(() => f.get(actor, hire.id, claimant), 403);
    await f.refused(() => f.post(actor, hire.id, body, { csrf: view.csrfToken, token: claimant }), 403);
    await f.refused(() => f.post(actor, hire.id, JSON.stringify({ ...body, actor: "forged" }), { csrf: view.csrfToken }), 400);
    // Expired between GET and POST.
    const short = await f.token(actor.email, actor.subject, { expiresAt: Math.floor(Date.now() / 1000) + 2 });
    const early = await f.view(actor, hire.id, short);
    await new Promise(resolve => setTimeout(resolve, 2_200));
    await f.refused(() => f.post(actor, hire.id, { ...body, commandId: crypto.randomUUID() }, { csrf: early.csrfToken, token: short }), 403);
    // Expires inside the write: the trigger's verifiedUntil check aborts the batch.
    const expiry = Math.floor(Date.now() / 1000) + 10;
    const brief = await f.token(actor.email, actor.subject, { expiresAt: expiry });
    const late = await f.command(actor, hire.id, "team.view", "grant", brief);
    f.beforeBatch = () => new Promise(resolve => setTimeout(resolve, Math.max(0, expiry * 1000 - Date.now() + 300)));
    await f.refused(() => f.post(actor, hire.id, late.body, { csrf: late.view.csrfToken, token: brief }), 403);
  });

  it("N16: an audit failure rolls back the command and the override", async () => {
    const actor = await admin(), hire = await f.nativeHire();
    const before = await f.totals();
    await expect(changeStaffOperationsAccess(f.db, await openStaffOperationsAccess(f.db), await directActor(actor), hire.id,
      { commandId: crypto.randomUUID(), permission: "team.view", operation: "grant", expectedRevision: 0, expectedAdmissionVersion: 1, reason: "Audit rollback" },
      f.db.prepare("INSERT INTO audit_events (id) VALUES (NULL)"))).rejects.toMatchObject({ status: 503 });
    expect(await f.totals()).toEqual(before);
  });

  it("R2.4: no dangling replay; a stored receipt never re-applies; replay and GET apply current authority", async () => {
    const actor = await admin(), hire = await f.nativeHire();
    const commandId = crypto.randomUUID();
    const command = { commandId, permission: "team.view", operation: "grant" as const, expectedRevision: 0, expectedAdmissionVersion: 1, reason: "Dangling fixture" };
    await expect(changeStaffOperationsAccess(f.db, await openStaffOperationsAccess(f.db), await directActor(actor), hire.id, command,
      f.db.prepare("INSERT INTO audit_events (id) VALUES (NULL)"))).rejects.toMatchObject({ status: 503 });
    expect(await f.db.prepare("SELECT count(*) n FROM staff_operations_access_commands WHERE command_id=?").bind(commandId).first("n")).toBe(0);
    // The rolled-back command id is not a receipt: a later attempt is a fresh, fully checked command.
    await override(actor.id, "team.view", "deny", "division");
    await f.refused(() => f.post(actor, hire.id, command), 403, "staff_operations_access_denied");
    const other = await admin();
    const granted = await f.change(other, hire.id, "team.view");
    expect(granted.response.status).toBe(200);
    expect((await f.change(other, hire.id, "team.view")).response.status).toBe(200); // revoke
    // Replaying the original grant returns its receipt and writes nothing.
    const before = await f.totals();
    const replay = await f.post(other, hire.id, granted.body);
    expect(await replay.json()).toMatchObject({ receipt: { commandId: granted.body.commandId, revision: 1, replayed: true } });
    expect(await f.totals()).toEqual(before);
    expect((await f.overrideRow(hire.id, "team.view")).results).toEqual([]);
    // Lost acknowledgement: the committed write is recovered as a replay, with one audit.
    const lost = { ...command, commandId: crypto.randomUUID(), expectedRevision: 2 };
    let committed = 0;
    const lossy = new Proxy(f.db, { get(base, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => { await base.batch(statements); committed++; throw new Error("Synthetic transport loss"); };
      const value = Reflect.get(base, key, base); return typeof value === "function" ? value.bind(base) : value;
    } });
    expect(await changeStaffOperationsAccess(lossy, await openStaffOperationsAccess(f.db), await directActor(other), hire.id, lost, await directAudit(other, hire.id)))
      .toMatchObject({ commandId: lost.commandId, revision: 3, replayed: true });
    expect(committed).toBe(1);
    // Current authority: after a deny, replay is 403 (the receipt stays stored) and GET is 403.
    await override(other.id, "roles.manage", "deny", "division");
    await f.refused(() => f.post(other, hire.id, granted.body, { csrf: "0".repeat(43) }), 403);
    const csrf = await csrfToken(f.env(), { accessSubject: other.subject } as StaffPrincipal);
    await f.refused(() => f.post(other, hire.id, granted.body, { csrf }), 403, "staff_operations_access_denied");
    expect(await f.db.prepare("SELECT count(*) n FROM staff_operations_access_commands WHERE command_id=?").bind(granted.body.commandId).first("n")).toBe(1);
    await f.refused(() => f.get(other, hire.id), 403, "staff_operations_access_denied", "actor_denied");
  });

  it("R2.4/rollback: legacy readers and writers keep working with 0244 installed, including lifecycle on hires", async () => {
    const actor = await admin(), hire = await f.nativeHire(), ordinary = await f.person({ native: false });
    expect((await f.change(actor, hire.id, "team.view")).response.status).toBe(200);
    // Pre-0244 code paths (roster, ACL reads, legacy PUT, the 0243 route) against the 0244 schema.
    const flags = await roster(actor);
    expect(flags.status).toBe(200);
    const rows = (await flags.json() as { staff: Array<Record<string, unknown>> }).staff;
    expect(rows.find(row => row.id === hire.id)).toMatchObject({ access_controls_editable: false, localControls: expect.objectContaining({ teamRoster: true }) });
    expect(rows.find(row => row.id === ordinary.id)).toMatchObject({ access_controls_editable: true });
    expect((await roster(hire)).status).toBe(200);
    const eligibility = await f.fetch(new Request(`${origin}/api/staff-device-eligibility/${encodeURIComponent(hire.id)}`, {
      headers: { "Cf-Access-Jwt-Assertion": await f.token(actor.email, actor.subject) } }));
    expect(eligibility.status).toBe(200);
  });

  it("Rotation: an email rotation keeps the staff-id-bound provenance; a primary subject cannot be rotated (fails closed)", async () => {
    const actor = await admin(), hire = await f.nativeHire();
    // Ops has no application path that changes a native hire's login email or
    // primary subject. The only database-permitted email rotation is a
    // versioned profile update with the matching staff_users email.
    const rotated = `rotated-${hire.id}@example.test`;
    await f.db.batch([
      f.db.prepare("UPDATE native_staff_profiles SET login_email=?,version=version+1 WHERE staff_id=?").bind(rotated, hire.id),
      f.db.prepare("UPDATE staff_users SET email=? WHERE id=?").bind(rotated, hire.id)]);
    expect(await f.db.prepare("SELECT login_email FROM native_staff_pending_onboarding WHERE proposed_staff_id=?").bind(hire.id).first("login_email")).toBe(hire.onboardingEmail);
    const view = await f.view(actor, hire.id);
    expect(view).toMatchObject({ targetEditable: true, targetAdmissionVersion: 1 });
    expect((await f.change(actor, hire.id, "team.view")).response.status).toBe(200);
    expect((await roster({ ...hire, email: rotated })).status).toBe(200);
    // Subject: 0123 makes bound_access_subject immutable, so no legitimate rotation exists.
    await expect(sql("UPDATE native_staff_admissions SET bound_access_subject=?,version=version+1 WHERE staff_id=?", `${hire.subject}-new`, hire.id))
      .rejects.toThrow(/native admission update is invalid/);
    // A divergent staff_users subject is not a rotation; the writer fails closed and the guard still holds.
    await sql("UPDATE staff_users SET access_subject=? WHERE id=?", `${hire.subject}-diverged`, hire.id);
    const diverged = await f.view(actor, hire.id);
    expect(diverged).toMatchObject({ targetEditable: false, targetReason: "target_identity_mismatch" });
    const { body } = await f.command(actor, hire.id, "team.view");
    await f.refused(() => f.post(actor, hire.id, body, { csrf: diverged.csrfToken }), 409, "not_editable", "target_identity_mismatch");
    await expect(override(hire.id, "sops.assign", "allow")).rejects.toThrow(/staff_operations_access_override_requires_command/);
  });

  it("Alternate login: parity with the primary login, and revocation or expiry between GET and POST refuses with nothing written", async () => {
    const owner = await f.person({ role: "role-owner" }), hire = await f.nativeHire();
    const alternate = { email: `alternate-${owner.id}@example.test`, subject: `access|alternate-${owner.id}` };
    const claims = (email: string, subject: string) => ({ issuer, email, subject, issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 600 });
    const link = async () => {
      const primary = await resolveVerifiedStaffLogin(f.db, claims(owner.email, owner.subject));
      const intent = await createStaffLoginBindingIntent(f.db, primary!.proof, alternate.email);
      const linked = await claimStaffLoginBindingIntent(f.db, claims(alternate.email, alternate.subject), intent);
      // An alternate sign-in must be issued after the intent (whole seconds).
      await new Promise(resolve => setTimeout(resolve, 1_100));
      return linked;
    };
    const revoke = async (binding: { bindingId: string; version: number }) => {
      const primary = await resolveVerifiedStaffLogin(f.db, claims(owner.email, owner.subject));
      await revokeStaffLoginBinding(f.db, primary!.proof, { bindingId: binding.bindingId, expectedVersion: binding.version });
    };
    const binding = await link();
    const altToken = () => f.token(alternate.email, alternate.subject);
    const viaPrimary = await f.view(owner, hire.id), viaAlternate = await f.view(owner, hire.id, await altToken());
    const strip = ({ csrfToken: _c, verifiedUntil: _v, ...rest }: typeof viaPrimary) => rest;
    expect(strip(viaAlternate)).toEqual(strip(viaPrimary));
    const token = await altToken();
    const done = await f.change(owner, hire.id, "team.view", undefined, token);
    expect(done.response.status, await done.response.clone().text()).toBe(200);
    expect(JSON.parse(await f.db.prepare("SELECT actor_login_json FROM staff_operations_access_commands WHERE command_id=?")
      .bind(done.body.commandId).first<string>("actor_login_json") ?? "null")).toMatchObject({ kind: "alternate", email: alternate.email });
    // Revoked between GET and POST.
    const before = await f.command(owner, hire.id, "sops.assign", "grant", token);
    await revoke(binding);
    await f.refused(() => f.post(owner, hire.id, before.body, { csrf: before.view.csrfToken, token }), 403);
    // Revoked inside the write transaction: the alternate-login block aborts the batch.
    alternate.email = `alternate2-${owner.id}@example.test`; alternate.subject = `access|alternate2-${owner.id}`;
    const second = await link();
    const token2 = await altToken();
    const raced = await f.command(owner, hire.id, "sops.assign", "grant", token2);
    f.beforeBatch = () => revoke(second);
    await f.refused(() => f.post(owner, hire.id, raced.body, { csrf: raced.view.csrfToken, token: token2 }), 403);
    // verifiedUntil of the alternate login expires mid-flight.
    alternate.email = `alternate3-${owner.id}@example.test`; alternate.subject = `access|alternate3-${owner.id}`;
    await link();
    const altExpiry = Math.floor(Date.now() / 1000) + 10;
    const brief = await f.token(alternate.email, alternate.subject, { expiresAt: altExpiry });
    const late = await f.command(owner, hire.id, "sops.assign", "grant", brief);
    f.beforeBatch = () => new Promise(resolve => setTimeout(resolve, Math.max(0, altExpiry * 1000 - Date.now() + 300)));
    await f.refused(() => f.post(owner, hire.id, late.body, { csrf: late.view.csrfToken, token: brief }), 403);
  });
});
