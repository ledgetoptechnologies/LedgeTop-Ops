import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { auditStatement } from "./request-security";
import type { Env, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
export const STAGING_DIRECTORY_OWNER_VIEW_GRANT_ROUTE = "/api/admin/staging/directory/owner-profile-view-grant";
const bodySchema = z.object({ confirm: z.literal(true) }).strict();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function stagingDirectoryOwnerViewGrantEnabled(env: Pick<Env, "ENVIRONMENT" | "STAGING_DIRECTORY_PROFILE_VIEW_GRANT_ENABLED">): boolean {
  return env.ENVIRONMENT === "staging" && env.STAGING_DIRECTORY_PROFILE_VIEW_GRANT_ENABLED === "true";
}

/** A one-purpose, default-off staging repair: the protected owner can grant only their own global Directory profile-view permission. */
export function registerStagingDirectoryOwnerViewGrantRoute(app: App): void {
  app.post(STAGING_DIRECTORY_OWNER_VIEW_GRANT_ROUTE, async c => {
    if (!stagingDirectoryOwnerViewGrantEnabled(c.env)
      || new URL(c.req.url).origin !== "https://ops-staging.ledgetopdroneservices.com"
      || c.env.EXPECTED_HOST !== "ops-staging.ledgetopdroneservices.com")
      throw new HTTPException(404, { message: "Not found" });
    const principal = c.get("principal");
    if (!c.get("administrator") || principal.id !== "staff-beau-koltz")
      throw new HTTPException(403, { message: "Protected owner access required" });
    const management = await sqlScope(c.env, principal, "integrations.manage");
    if (!management.global || management.deniedGlobal)
      throw new HTTPException(403, { message: "Global integrations.manage permission required" });
    const nativeRole = await c.env.OPS_DB.prepare(`SELECT 1 ok FROM staff_role_assignments
      WHERE staff_id=? AND role_id='role-owner' AND scope='global' LIMIT 1`).bind(principal.id).first();
    if (!nativeRole) throw new HTTPException(403, { message: "Protected owner role required" });

    let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
    try {
      authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, {
        enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD,
      });
    } catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
    if (authenticated.identity.staffId !== principal.id || authenticated.identity.email !== principal.email
      || authenticated.identity.verifiedAccessSubject !== principal.accessSubject)
      throw new HTTPException(403, { message: "Operations and native staff identities do not match" });

    const parsed = bodySchema.safeParse(await readBoundedJson(c.req.raw, 128, "Staging Directory owner view grant"));
    if (!parsed.success) throw new HTTPException(400, { message: "Explicit grant confirmation is required" });
    const commandId = c.req.header("Idempotency-Key") ?? "";
    if (!UUID.test(commandId)) throw new HTTPException(400, { message: "A UUID Idempotency-Key is required" });
    c.header("Cache-Control", "no-store");

    const deny = await c.env.OPS_DB.prepare(`SELECT 1 ok FROM native_directory_grants WHERE staff_id=?
      AND permission='directory.profile.view' AND effect='deny' AND scope_kind='global' AND active=1 LIMIT 1`).bind(principal.id).first();
    if (deny) throw new HTTPException(409, { message: "An active global deny exists; no grant was added" });
    const active = await c.env.OPS_DB.prepare(`SELECT id FROM native_directory_grants WHERE staff_id=?
      AND permission='directory.profile.view' AND effect='allow' AND scope_kind='global' AND active=1 LIMIT 1`).bind(principal.id).first<{ id: string }>();
    if (active) return c.json({ status: "already_granted", permission: "directory.profile.view", scope: "global" });

    const grantId = crypto.randomUUID();
    const grant = c.env.OPS_DB.prepare(`INSERT OR IGNORE INTO native_directory_grants
      (id,staff_id,permission,effect,scope_kind,active,granted_by)
      SELECT ?,?,'directory.profile.view','allow','global',1,?
      WHERE EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=? AND active=1 AND bound_access_subject=? AND version=?)
        AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=? AND login_email=? AND version=?)
        AND julianday(?)>julianday('now')
        AND EXISTS(SELECT 1 FROM staff_role_assignments a JOIN role_permissions p ON p.role_id=a.role_id
          WHERE a.staff_id=? AND a.role_id='role-owner' AND a.scope='global' AND p.permission_key='integrations.manage')
        AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides WHERE staff_id=? AND permission_key='integrations.manage'
          AND effect='deny' AND scope='global')
        AND NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=? AND permission='directory.profile.view'
          AND effect='deny' AND scope_kind='global' AND active=1)`)
      .bind(grantId, principal.id, principal.id, principal.id, authenticated.identity.verifiedAccessSubject, authenticated.admissionVersion,
        principal.id, authenticated.identity.email, authenticated.identity.profileVersion, authenticated.verifiedUntil,
        principal.id, principal.id, principal.id);
    const audit = await auditStatement(c.env, c.req.raw, principal,
      "staging.directory_owner_profile_view_grant_command", "native_directory_grant_command", commandId, null,
      { permission: "directory.profile.view", effect: "allow", scope: "global", operation: "ensure" });
    const results = await c.env.OPS_DB.batch([grant, audit]);
    if (results[0]?.meta?.changes !== 1) {
      const current = await c.env.OPS_DB.prepare(`SELECT id FROM native_directory_grants WHERE staff_id=?
        AND permission='directory.profile.view' AND effect='allow' AND scope_kind='global' AND active=1 LIMIT 1`).bind(principal.id).first();
      if (current) return c.json({ status: "already_granted", permission: "directory.profile.view", scope: "global" });
      throw new HTTPException(409, { message: "Owner authority changed; no grant was added" });
    }
    return c.json({ status: "granted", permission: "directory.profile.view", scope: "global" }, 201);
  });
}
