import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import {
  STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID,
  STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID,
  STAGING_EMPTY_ENROLLMENT_FIXTURE_PROFILE,
  STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID,
  writeStagingEmptyEnrollmentOrganizationFixture,
  type NativeDirectoryScope,
  type NativeDirectoryWriterActor,
} from "./native-directory-profile-writer";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ROUTE =
  "/api/admin/native-directory/staging-empty-enrollment-fixture";
const MAX_BODY_BYTES = 1024;
const emptyBody = z.object({}).strict();

export function nativeDirectoryStagingEmptyEnrollmentFixtureEnabled(env: Pick<Env,
  "ENVIRONMENT" | "NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ENABLED" |
  "NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_BUSINESS_AREA_ID">): boolean {
  return env.ENVIRONMENT === "staging"
    && env.NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ENABLED === "true"
    && typeof env.NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_BUSINESS_AREA_ID === "string"
    && /^[^\p{C}]{1,191}$/u.test(env.NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_BUSINESS_AREA_ID);
}

async function nativeActor(c: AppContext): Promise<Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">> {
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try {
    authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, {
      enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD,
    });
  } catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
  const principal = c.get("principal"), identity = authenticated.identity;
  if (identity.staffId !== principal.id || identity.email !== principal.email
    || identity.verifiedAccessSubject !== principal.accessSubject)
    throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
  return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject,
    admissionVersion: authenticated.admissionVersion, loginEmail: identity.email, profileVersion: identity.profileVersion };
}

/** Select a current, deny-aware create grant for the one active scope pin. */
async function createGrant(db: D1Database, actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  permission: "directory.profile.edit" | "directory.enrollment.manage", scope: NativeDirectoryScope): Promise<string | null> {
  const scopes = JSON.stringify([scope]);
  const row = await db.withSession("first-primary").prepare(`SELECT grant.id FROM native_directory_grants grant
    JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN staff_users staff ON staff.id=grant.staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id
    WHERE grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1
      AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND staff.status='active' AND staff.access_subject=? AND profile.login_email=? AND profile.version=?
      AND (grant.scope_kind='global' OR (grant.scope_kind='business_area' AND grant.business_area_id=?)
        OR (grant.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(?) s WHERE json_extract(s.value,'$.divisionId')=grant.division_id)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=grant.staff_id
        AND deny.permission=grant.permission AND deny.effect='deny' AND deny.active=1
        AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=?)
          OR (deny.scope_kind='business_area' AND deny.business_area_id=?)
          OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(?) s WHERE json_extract(s.value,'$.divisionId')=deny.division_id))))
    ORDER BY CASE grant.scope_kind WHEN 'division' THEN 1 WHEN 'business_area' THEN 2 ELSE 3 END,grant.id LIMIT 1`)
    .bind(actor.staffId, permission, actor.accessSubject, actor.admissionVersion, actor.accessSubject, actor.loginEmail,
      actor.profileVersion, scope.businessAreaId, scopes, STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID,
      scope.businessAreaId, scopes).first<{ id: string }>();
  return row?.id ?? null;
}

async function exactAdmission(db: D1Database, actor: NativeDirectoryWriterActor, scope: NativeDirectoryScope): Promise<boolean> {
  const scopes = JSON.stringify([scope]), profile = JSON.stringify(STAGING_EMPTY_ENROLLMENT_FIXTURE_PROFILE);
  const existing = await db.withSession("first-primary").prepare(`SELECT id FROM native_directory_create_admissions
    WHERE id=? AND staff_id=? AND bound_access_subject=? AND record_id=? AND record_kind='organization'
      AND ((active=1 AND consumed_mutation_id IS NULL AND consumed_at IS NULL)
        OR (active=0 AND consumed_mutation_id=? AND consumed_at IS NOT NULL))
      AND json(scopes_json)=json(?) AND json(profile_json)=json(?) AND json(destinations_json)=json('[]')`)
    .bind(STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID, actor.staffId, actor.accessSubject,
      STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID, STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID, scopes, profile).first();
  if (existing) return true;
  try {
    await db.withSession("first-primary").prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?, 'organization',?,?, '[]',?) ON CONFLICT DO NOTHING`).bind(
      STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID, actor.staffId, actor.accessSubject,
      STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID, scopes, profile, actor.staffId).run();
  } catch { return false; }
  return !!await db.withSession("first-primary").prepare(`SELECT 1 ok FROM native_directory_create_admissions
    WHERE id=? AND staff_id=? AND bound_access_subject=? AND record_id=? AND record_kind='organization'
      AND ((active=1 AND consumed_mutation_id IS NULL AND consumed_at IS NULL)
        OR (active=0 AND consumed_mutation_id=? AND consumed_at IS NOT NULL))
      AND json(scopes_json)=json(?) AND json(profile_json)=json(?) AND json(destinations_json)=json('[]')`)
    .bind(STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID, actor.staffId, actor.accessSubject,
      STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID, STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID, scopes, profile).first("ok");
}

/**
 * A one-record staging acceptance fixture. Shared /api middleware performs
 * origin and CSRF validation before this handler. It intentionally has no PA
 * source, therefore the normal writer makes zero intents or materializations.
 */
export function registerNativeDirectoryStagingEmptyEnrollmentFixtureRoutes(app: App): void {
  app.post(NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ROUTE, async c => {
    if (!nativeDirectoryStagingEmptyEnrollmentFixtureEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator access required" });
    if (c.req.header("Idempotency-Key") !== STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID)
      throw new HTTPException(400, { message: "Idempotency-Key must match the staging fixture" });
    if (!emptyBody.safeParse(await readBoundedJson(c.req.raw, MAX_BODY_BYTES, "Native staging fixture")).success)
      throw new HTTPException(400, { message: "Native staging fixture request is invalid" });
    const areaId = c.env.NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_BUSINESS_AREA_ID!;
    const scope: NativeDirectoryScope = { businessAreaId: areaId, divisionId: null };
    const baseActor = await nativeActor(c);
    const [profileGrant, enrollmentGrant, activeArea] = await Promise.all([
      createGrant(c.env.OPS_DB, baseActor, "directory.profile.edit", scope),
      createGrant(c.env.OPS_DB, baseActor, "directory.enrollment.manage", scope),
      c.env.OPS_DB.withSession("first-primary").prepare("SELECT 1 ok FROM native_business_areas WHERE id=? AND active=1").bind(areaId).first("ok"),
    ]);
    if (!profileGrant || !enrollmentGrant || !activeArea)
      throw new HTTPException(403, { message: "Current native fixture authority is required" });
    const actor: NativeDirectoryWriterActor = { ...baseActor, selectedGrantId: profileGrant, selectedIdentityGrantId: profileGrant };
    if (!await exactAdmission(c.env.OPS_DB, actor, scope))
      return c.json({ status: "conflict", reason: "fixture_admission_unavailable" }, 409);
    const outcome = await writeStagingEmptyEnrollmentOrganizationFixture(c.env.OPS_DB, {
      operation: "create", mutationId: STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID,
      recordId: STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID, expectedLocalVersion: 0, kind: "organization",
      profile: STAGING_EMPTY_ENROLLMENT_FIXTURE_PROFILE, scopes: [scope], destinations: [],
      createAdmissionId: STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID, actor,
    });
    c.header("Cache-Control", "no-store");
    return c.json(outcome, outcome.status === "conflict" ? 409 : outcome.status === "written" ? 200 : 403);
  });
}
