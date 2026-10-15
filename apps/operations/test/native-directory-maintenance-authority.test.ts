import { describe, expect, it } from "vitest";
import { runCanonicalPortalResourceAcceptance } from "./helpers/operations-native-portal-resource-acceptance-fixture";
import {
  compileNativeDirectoryMaintenanceAuthorityPlan,
  executeNativeDirectoryMaintenanceAuthority,
  NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET,
  readFrozenNativeDirectoryMaintenanceApproval,
  type NativeDirectoryMaintenanceAuthorityPlan,
  type NativeDirectoryMaintenancePlanInput,
} from "../src/worker/native-directory-maintenance-authority";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

const target = NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET;
const syntheticIssuer = { staffId: "acceptance-owner", accessSubject: "access|acceptance-owner" };
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(",")}}`;
};
const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(value)))).map(byte => byte.toString(16).padStart(2, "0")).join("");

describe("native directory maintenance authority on the canonical D1 chain", { timeout: 300_000 }, () => {
  it("requires a preinstalled exact approval, fences current state, and never restores revoked authority", async () => {
    await runCanonicalPortalResourceAcceptance(async context => {
      const { operations: db, owner: originalOwner } = context;
      expect(await db.prepare("SELECT count(*) count FROM d1_migrations").first<number>("count")).toBe(203);

      // A new admitted/profiled owner in the already-populated staging fixture
      // has other normal Directory grants but lacks portal_access.manage.
      // The canonical fixture owner is intentionally untouched (and already
      // has that permission, so it is not an eligible maintenance target).
      const targetOwners = new Map<string, AuthenticatedNativeStaffWithAdmissionVersion>();
      async function seedTargetOwner(staffId: string): Promise<AuthenticatedNativeStaffWithAdmissionVersion> {
        const subject = `access|${staffId}`;
        const email = `${staffId}@example.test`;
        await db.batch([
          db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
            VALUES(?,?,?,?,'active')`).bind(staffId, email, staffId, subject),
          db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
            VALUES(?,?,1,?)`).bind(staffId, subject, originalOwner.identity.staffId),
          db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
            VALUES(?,?,?)`).bind(staffId, email, staffId),
          db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
            VALUES(?,?,'role-owner','global',NULL,'global',?)`).bind(id("role"), staffId, originalOwner.identity.staffId),
          ...["directory.profile.edit", "directory.enrollment.manage"].map((permission, index) => db.prepare(`
            INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
            VALUES(?,?,?,'allow','global',1,?)`).bind(`${staffId}-grant-${index}`, staffId, permission,
              originalOwner.identity.staffId)),
        ]);
        const actor: AuthenticatedNativeStaffWithAdmissionVersion = {
          identity: { kind: "native", staffId, verifiedAccessSubject: subject, email,
            displayName: staffId, profileVersion: 1 },
          admissionVersion: 1,
          verifiedUntil: iso(60 * 60_000),
        };
        targetOwners.set(staffId, actor);
        return actor;
      }
      function planInput(staffId: string): NativeDirectoryMaintenancePlanInput {
        const subject = `access|${staffId}`;
        return {
          target,
          staffId,
          grantId: id("maintenance-grant"),
          commandId: id("maintenance-command"),
          operator: { staffId, accessSubject: subject },
          approvalIssuer: syntheticIssuer,
          identityEvidence: { staffId, accessSubject: subject, verificationId: id("verification"),
            verifiedAt: iso(-60_000), expiresAt: iso(30 * 60_000), issuer: "independent-verification-fixture" },
        };
      }
      async function compile(staffId: string) {
        return compileNativeDirectoryMaintenanceAuthorityPlan(db, planInput(staffId));
      }
      async function installSyntheticTrustedApproval(plan: NativeDirectoryMaintenanceAuthorityPlan,
        options: { issuedAt?: string; expiresAt?: string; revoked?: boolean } = {}) {
        const planJson = canonical(plan), evidenceJson = canonical(plan.identityEvidence);
        const issuedAt = options.issuedAt ?? iso(-1_000);
        const expiresAt = options.expiresAt ?? iso(20 * 60_000);
        // TEST TRUST BOUNDARY: only this synthetic fixture installs approvals
        // directly. Production has no approval-issuing route in this protocol.
        await db.prepare(`INSERT INTO native_directory_maintenance_authority_approvals(
          approval_id,canonical_plan_json,canonical_plan_sha256,approved_operator_staff_id,
          approved_operator_access_subject,independent_binding_verification_json,
          independent_binding_verification_sha256,issued_by_staff_id,issued_by_access_subject,
          issued_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(id("maintenance-approval"), planJson, await sha256(planJson), plan.operator.staffId,
            plan.operator.accessSubject, evidenceJson, await sha256(evidenceJson), plan.approvalIssuer.staffId,
            plan.approvalIssuer.accessSubject, issuedAt, expiresAt, options.revoked ? iso() : null).run();
        const row = await db.prepare(`SELECT approval_id FROM native_directory_maintenance_authority_approvals
          WHERE canonical_plan_sha256=?`).bind(await sha256(planJson)).first<{ approval_id: string }>();
        if (!row) throw new Error("synthetic fixture approval insert failed");
        return row.approval_id;
      }
      async function execute(plan: NativeDirectoryMaintenanceAuthorityPlan, approvalId: string,
        actor: AuthenticatedNativeStaffWithAdmissionVersion = targetOwners.get(plan.staffId)!) {
        return executeNativeDirectoryMaintenanceAuthority(db, { plan, approvalId, commandId: plan.commandId, actor, target });
      }
      async function noGrant(staffId: string, grantId: string) {
        expect(await db.prepare("SELECT count(*) count FROM native_directory_grants WHERE staff_id=? AND id=?")
          .bind(staffId, grantId).first<number>("count")).toBe(0);
        expect(await db.prepare("SELECT count(*) count FROM native_directory_maintenance_authority_receipts WHERE grant_id=?")
          .bind(grantId).first<number>("count")).toBe(0);
      }

      const owner = await seedTargetOwner("maintenance-positive-owner");
      const compiled = await compile(owner.identity.staffId);
      expect(compiled.plan.snapshot.roles.some(row => row.role_id === "role-owner")).toBe(true);
      expect(compiled.plan.snapshot.grants).toHaveLength(2);
      expect(compiled.plan.snapshot.grants.some(row => row.permission === "directory.portal_access.manage")).toBe(false);
      const approvalId = await installSyntheticTrustedApproval(compiled.plan);
      const frozenBeforeExecution = await readFrozenNativeDirectoryMaintenanceApproval(
        db, approvalId, compiled.plan.commandId, compiled.canonicalPlanSha256);
      expect(frozenBeforeExecution.plan).toEqual(compiled.plan);
      await expect(readFrozenNativeDirectoryMaintenanceApproval(
        db, approvalId, compiled.plan.commandId, "f".repeat(64))).rejects.toThrow(
        "native_directory_maintenance_authority_denied");

      const firstHistory = compiled.plan.snapshot.history[0]!;
      const rejectAlteredPlan = (plan: NativeDirectoryMaintenanceAuthorityPlan) =>
        expect(execute(plan, approvalId, owner)).rejects.toThrow("native_directory_maintenance_authority_denied");
      await rejectAlteredPlan({ ...compiled.plan, snapshot: { ...compiled.plan.snapshot,
        history: [...compiled.plan.snapshot.history, { ...firstHistory, grant_id: id("orphan-history") }] } });
      await rejectAlteredPlan({ ...compiled.plan, snapshot: { ...compiled.plan.snapshot,
        generation: [] } });
      await rejectAlteredPlan({ ...compiled.plan, snapshot: { ...compiled.plan.snapshot,
        history: compiled.plan.snapshot.history.map((row, index) => index === 0
          ? { ...row, grant_version: 2 } : row) } });
      await rejectAlteredPlan({ ...compiled.plan, snapshot: { ...compiled.plan.snapshot,
        history: compiled.plan.snapshot.history.map((row, index) => index === 0
          ? { ...row, grant_generation: Number(compiled.plan.snapshot.generation[0]!.generation) + 1 } : row) } });
      await rejectAlteredPlan({ ...compiled.plan, snapshot: { ...compiled.plan.snapshot,
        history: compiled.plan.snapshot.history.map((row, index) => index === 0
          ? { ...row, active: 0 } : row) } });
      await rejectAlteredPlan({ ...compiled.plan, identityEvidence: { ...compiled.plan.identityEvidence,
        verifiedAt: "not-a-timestamp" } });
      await rejectAlteredPlan({ ...compiled.plan, approvalIssuer: { ...compiled.plan.approvalIssuer,
        accessSubject: "access|different-issuer" } });

      // Owner role, admission, profile and existing grants do not replace the
      // separately trusted exact-plan approval.
      await expect(execute(compiled.plan, id("absent-approval"))).rejects.toThrow(
        "native_directory_maintenance_authority_denied");
      await noGrant(owner.identity.staffId, compiled.plan.grantId);

      const unrelatedBefore = await db.prepare(`SELECT id,permission,effect,scope_kind,active FROM native_directory_grants
        WHERE staff_id=? ORDER BY id`).bind(originalOwner.identity.staffId).all();
      const concurrent = await Promise.all([
        execute(compiled.plan, approvalId),
        execute(compiled.plan, approvalId),
      ]);
      expect(concurrent.map(result => result.status).sort()).toEqual(["applied", "replayed"]);
      const applied = concurrent.find(result => result.status === "applied")!;
      expect(applied).toMatchObject({ commandId: compiled.plan.commandId, approvalId,
        grantId: compiled.plan.grantId, resultingGeneration: 3 });
      // An uncertain HTTP result must still be reconcilable after the first
      // commit, when recompiling today's plan would (correctly) be ineligible.
      const frozenAfterExecution = await readFrozenNativeDirectoryMaintenanceApproval(
        db, approvalId, compiled.plan.commandId, compiled.canonicalPlanSha256);
      expect(frozenAfterExecution.plan).toEqual(compiled.plan);
      const exactReplay = await execute(compiled.plan, approvalId);
      expect(exactReplay).toMatchObject({ status: "replayed", grantId: compiled.plan.grantId });
      expect(await db.prepare(`SELECT count(*) count FROM native_directory_grant_history WHERE grant_id=?`)
        .bind(compiled.plan.grantId).first<number>("count")).toBe(1);
      expect(await db.prepare(`SELECT id,permission,effect,scope_kind,active FROM native_directory_grants
        WHERE staff_id=? ORDER BY id`).bind(originalOwner.identity.staffId).all().then(result => result.results))
        .toEqual(unrelatedBefore.results);

      // These must reject for their own changed authority/input, not merely
      // because the approval has subsequently been revoked.
      const alteredPlan = { ...compiled.plan, identityEvidence: { ...compiled.plan.identityEvidence,
        verificationId: id("changed-verification") } };
      await expect(execute(alteredPlan, approvalId)).rejects.toThrow("native_directory_maintenance_authority_denied");
      await expect(execute(compiled.plan, approvalId, { ...owner,
        identity: { ...owner.identity, verifiedAccessSubject: "access|wrong-operator" } }))
        .rejects.toThrow("native_directory_maintenance_authority_denied");
      await expect(execute(compiled.plan, approvalId, { ...owner, admissionVersion: 2 }))
        .rejects.toThrow("native_directory_maintenance_authority_denied");
      await expect(execute(compiled.plan, approvalId, { ...owner,
        identity: { ...owner.identity, profileVersion: 2 } }))
        .rejects.toThrow("native_directory_maintenance_authority_denied");
      await expect(execute(compiled.plan, approvalId, { ...owner, verifiedUntil: iso(-1_000) }))
        .rejects.toThrow("native_directory_maintenance_authority_denied");
      await expect(executeNativeDirectoryMaintenanceAuthority(db, { plan: compiled.plan, approvalId,
        commandId: id("different-command"), actor: owner, target }))
        .rejects.toThrow("native_directory_maintenance_authority_denied");
      await expect(executeNativeDirectoryMaintenanceAuthority(db, { plan: compiled.plan, approvalId,
        commandId: compiled.plan.commandId, actor: owner,
        target: { ...target, databaseLabel: "wrong-database" } }))
        .rejects.toThrow("native_directory_maintenance_authority_denied");

      // An exact replay is a receipt result only; it must never restore an
      // existing grant whose live state has since been revoked.
      await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").bind(compiled.plan.grantId).run();
      await expect(execute(compiled.plan, approvalId)).resolves.toMatchObject({ status: "replayed" });
      expect(await db.prepare("SELECT active FROM native_directory_grants WHERE id=?")
        .bind(compiled.plan.grantId).first<number>("active")).toBe(0);
      await db.prepare(`UPDATE native_directory_maintenance_authority_approvals SET revoked_at=? WHERE approval_id=?`)
        .bind(iso(), approvalId).run();
      await expect(execute(compiled.plan, approvalId)).rejects.toThrow("native_directory_maintenance_authority_denied");
      expect(await db.prepare("SELECT active FROM native_directory_grants WHERE id=?")
        .bind(compiled.plan.grantId).first<number>("active")).toBe(0);

      // Expired and revoked approvals are distinct closed failures.
      for (const mode of ["expired", "revoked"] as const) {
        const candidate = await seedTargetOwner(`maintenance-${mode}-owner`);
        const plan = (await compile(candidate.identity.staffId)).plan;
        const expired = mode === "expired";
        const approval = await installSyntheticTrustedApproval(plan, expired
          ? { issuedAt: iso(-90 * 60_000), expiresAt: iso(-60 * 60_000) }
          : { revoked: true });
        await expect(execute(plan, approval, candidate)).rejects.toThrow("native_directory_maintenance_authority_denied");
        await noGrant(candidate.identity.staffId, plan.grantId);
      }

      // Each mutable current authority dimension is snapshotted and fenced.
      const staleCases = ["admission", "profile", "role", "grant-generation", "history", "deny"] as const;
      for (const kind of staleCases) {
        const candidate = await seedTargetOwner(`maintenance-stale-${kind}-owner`);
        const plan = (await compile(candidate.identity.staffId)).plan;
        const approval = await installSyntheticTrustedApproval(plan);
        if (kind === "admission") {
          await db.prepare(`UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?`)
            .bind(candidate.identity.staffId).run();
        } else if (kind === "profile") {
          await db.prepare(`UPDATE native_staff_profiles SET display_name=?,version=version+1 WHERE staff_id=?`)
            .bind("Changed after review", candidate.identity.staffId).run();
        } else if (kind === "role") {
          await db.prepare("DELETE FROM staff_role_assignments WHERE staff_id=? AND role_id='role-owner'")
            .bind(candidate.identity.staffId).run();
        } else if (kind === "grant-generation") {
          await db.prepare(`UPDATE native_directory_grant_generations SET generation=generation+1 WHERE staff_id=?`)
            .bind(candidate.identity.staffId).run();
        } else if (kind === "history") {
          const first = plan.snapshot.history[0]!;
          await db.prepare(`INSERT INTO native_directory_grant_history(grant_id,grant_version,staff_id,permission,effect,
            scope_kind,business_area_id,division_id,resource_id,active,grant_generation)
            VALUES(?,2,?,?,?,?,?,?,?,?,?)`).bind(first.grant_id, candidate.identity.staffId, first.permission,
              first.effect, first.scope_kind, first.business_area_id, first.division_id, first.resource_id,
              first.active, first.grant_generation).run();
        } else {
          await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
            VALUES(?,?, 'directory.portal_access.manage','deny','global',1,?)`)
            .bind(`${candidate.identity.staffId}-late-deny`, candidate.identity.staffId, originalOwner.identity.staffId).run();
        }
        await expect(execute(plan, approval, candidate)).rejects.toThrow("native_directory_maintenance_authority_denied");
        await noGrant(candidate.identity.staffId, plan.grantId);
      }

      // Snapshot compiler rejects malformed approval subjects and a role owner
      // alone; it never treats a legacy onboarding/bootstrap artifact as proof.
      const noRoleOwner = await seedTargetOwner("maintenance-no-role-owner");
      await db.prepare("DELETE FROM staff_role_assignments WHERE staff_id=? AND role_id='role-owner'")
        .bind(noRoleOwner.identity.staffId).run();
      await expect(compile(noRoleOwner.identity.staffId)).rejects.toThrow("native_directory_maintenance_authority_denied");

      // Global grant identity is unique and durable. A collision cannot be
      // converted into a receipt or overwrite/revive the preexisting row.
      const collisionOwner = await seedTargetOwner("maintenance-collision-owner");
      const collisionPlan = (await compile(collisionOwner.identity.staffId)).plan;
      const occupiedGrant = compiled.plan.grantId;
      const collisionApproval = await installSyntheticTrustedApproval({ ...collisionPlan, grantId: occupiedGrant });
      const occupiedBefore = await db.prepare("SELECT active FROM native_directory_grants WHERE id=?")
        .bind(occupiedGrant).first<number>("active");
      await expect(execute({ ...collisionPlan, grantId: occupiedGrant }, collisionApproval, collisionOwner))
        .rejects.toThrow("native_directory_maintenance_authority_denied");
      expect(await db.prepare("SELECT active FROM native_directory_grants WHERE id=?")
        .bind(occupiedGrant).first<number>("active")).toBe(occupiedBefore);
      expect(await db.prepare("SELECT count(*) count FROM native_directory_grants WHERE staff_id=? AND id=?")
        .bind(collisionOwner.identity.staffId, occupiedGrant).first<number>("count")).toBe(0);
      expect(await db.prepare("SELECT count(*) count FROM native_directory_maintenance_authority_receipts WHERE command_id=?")
        .bind(collisionPlan.commandId).first<number>("count")).toBe(0);

      // A late receipt failure rolls back the inserted grant, history and
      // generation. This trigger exists only in this synthetic test database.
      const lateOwner = await seedTargetOwner("maintenance-late-receipt-owner");
      const latePlan = (await compile(lateOwner.identity.staffId)).plan;
      const lateApproval = await installSyntheticTrustedApproval(latePlan);
      const generationBefore = await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
        .bind(lateOwner.identity.staffId).first<number>("generation");
      await db.prepare(`CREATE TRIGGER synthetic_fail_maintenance_receipt BEFORE INSERT
        ON native_directory_maintenance_authority_receipts WHEN NEW.command_id='${latePlan.commandId}'
        BEGIN SELECT RAISE(ABORT,'synthetic late receipt failure'); END`).run();
      await expect(execute(latePlan, lateApproval, lateOwner)).rejects.toThrow("native_directory_maintenance_authority_denied");
      await db.prepare("DROP TRIGGER synthetic_fail_maintenance_receipt").run();
      await noGrant(lateOwner.identity.staffId, latePlan.grantId);
      expect(await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
        .bind(lateOwner.identity.staffId).first<number>("generation")).toBe(generationBefore);
      expect(await db.prepare("SELECT count(*) count FROM native_directory_maintenance_authority_guards")
        .first<number>("count")).toBe(0);
    }, { stopAfterReady: true, operationsThroughMigration: "0203_effective_native_directory_enrollment_consumers.sql" });
  });
});
