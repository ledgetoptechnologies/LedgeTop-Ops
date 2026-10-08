import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { readBoundedJson } from "./bounded-json";
import { readConfiguredProjectAlphaDirectoryProfile,
  type ProjectAlphaDirectoryProfileObservation } from "./project-alpha-directory-read-api-v2";
import { projectAlphaApiV2ReadAcceptanceEnabled } from "./project-alpha-api-v2-read-acceptance-routes";
import { readNativeDirectoryClientProfileSnapshot, selectGrant } from "./native-directory-profile-routes";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import type { Env, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
export const STAGING_DIRECTORY_DESTINATION_READBACK_ROUTE = "/api/admin/staging/directory/replay-destination-readback";
const RECORD_ID = "614ed50f-8800-4ab3-aa69-009d8e5cefa9";
const SOURCE_ID = "project-alpha:staging";
const AREA_ID = "staging-native-only-portal-acceptance-20261008-window-1";
const HOST = "ops-staging.ledgetopdroneservices.com";
const bodySchema = z.object({ expectedLocalVersion: z.number().int().positive().safe() }).strict();
const revision = (value: unknown, zero = false): value is string => typeof value === "string"
  && (zero ? /^(?:0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(value);
const publicId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

type Proof = { sourceInstanceId: string; applicationId: string; historyEpoch: string; projectAlphaPublicId: string;
  projectAlphaRevision: string; authorizationGeneration: string; destinationOrigin: string };

export function expectedStagingDirectoryDestinationProfile(p: Record<string, string>) {
  if (p.clientType !== "unknown" || p.name === "") return null;
  const nullable = (field: string) => p[field] === "" ? null : p[field];
  return { name: p.name, email: nullable("email"), phone: nullable("phone"), clientType: p.clientType,
    organizationPublicId: null, address: { line1: nullable("addressLine1"), line2: nullable("addressLine2"),
      city: nullable("city"), state: nullable("state"), postalCode: nullable("postalCode"), country: nullable("country") } };
}

export function evaluateStagingDirectoryDestinationReadback(expected: Proof,
  localProfile: NonNullable<ReturnType<typeof expectedStagingDirectoryDestinationProfile>>,
  observation: ProjectAlphaDirectoryProfileObservation) {
  const exactIdentity = observation.sourceId === SOURCE_ID
    && observation.sourceInstanceId === expected.sourceInstanceId
    && observation.applicationId === expected.applicationId && observation.historyEpoch === expected.historyEpoch
    && observation.resource.type === "client" && observation.resource.id === expected.projectAlphaPublicId
    && observation.profile.publicId === expected.projectAlphaPublicId;
  const exactVersion = observation.resource.revision === expected.projectAlphaRevision;
  const exactGeneration = observation.authorizationGeneration === expected.authorizationGeneration;
  const remote = observation.profile;
  const exactProfile = remote.name === localProfile.name && remote.email === localProfile.email
    && remote.phone === localProfile.phone && remote.clientType === localProfile.clientType
    && remote.organizationPublicId === null && remote.address.line1 === localProfile.address.line1
    && remote.address.line2 === localProfile.address.line2 && remote.address.city === localProfile.address.city
    && remote.address.state === localProfile.address.state && remote.address.postalCode === localProfile.address.postalCode
    && remote.address.country === localProfile.address.country;
  return { exactIdentity, exactVersion, exactGeneration, exactProfile };
}

export async function stagingDirectoryDestinationProof(db: D1Database, expectedLocalVersion: number): Promise<Proof | null> {
  const mappings = await db.withSession("first-primary").prepare(`SELECT mapping.source_instance_id sourceInstanceId,
      mapping.application_id applicationId,mapping.history_epoch_id historyEpoch,
      mapping.project_alpha_public_id projectAlphaPublicId
    FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind='client'
      AND record.current_version=?
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=?
    WHERE mapping.source_id=? AND mapping.resource_type='client' AND mapping.record_id=?
      AND 1=(SELECT count(*) FROM native_directory_resource_scopes scope WHERE scope.record_id=record.record_id
        AND scope.business_area_id=? AND scope.division_id IS NULL AND scope.active=1)
      AND 1=(SELECT count(*) FROM native_directory_resource_scopes scope WHERE scope.record_id=record.record_id AND scope.active=1)
      AND 1=(SELECT count(*) FROM operations_directory_client_organizations relationship
        WHERE relationship.client_record_id=record.record_id AND relationship.organization_record_id IS NULL
          AND relationship.relationship_version>=1)
    LIMIT 2`).bind(expectedLocalVersion, expectedLocalVersion, SOURCE_ID, RECORD_ID, AREA_ID)
    .all<Omit<Proof,"projectAlphaRevision"|"authorizationGeneration"|"destinationOrigin">>();
  if (mappings.results.length !== 1) return null;
  const mapping = mappings.results[0]!;
  if (!publicId(mapping.projectAlphaPublicId)) return null;
  const receipts = await db.withSession("first-primary").prepare(`SELECT
      json_extract(outbox.outcome_json,'$.response.result.resource.revision') projectAlphaRevision,
      json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') authorizationGeneration,
      intent.destination_origin destinationOrigin
    FROM operations_directory_intents intent
    JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
    JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
    WHERE intent.record_id=? AND intent.record_version=? AND intent.state='acknowledged'
      AND intent.source_id=? AND intent.source_instance_uuid=? AND intent.application_uuid=?
      AND intent.expected_history_epoch_id=? AND intent.external_canonical_id=?
      AND outbox.state='acknowledged' AND outbox.source_id=intent.source_id
      AND outbox.expected_source_instance_id=intent.source_instance_uuid AND outbox.application_id=intent.application_uuid
      AND outbox.expected_history_epoch_id=intent.expected_history_epoch_id
      AND materialization.history_epoch_id=intent.expected_history_epoch_id
      AND json(outbox.command_json)=json(materialization.command_json)
      AND outbox.destination_base_url=intent.destination_origin
      AND outbox.resource_type='client' AND outbox.external_id=intent.external_canonical_id
      AND json_extract(outbox.command_json,'$.operation')='update'
      AND json_extract(outbox.command_json,'$.expectedProjectAlphaPublicId')=?
      AND json_type(outbox.command_json,'$.fields.organizationPublicId')='null'
      AND json_remove(json_extract(outbox.command_json,'$.fields'),'$.organizationPublicId')
        =json((SELECT profile_json FROM operations_directory_revisions
          WHERE record_id=intent.record_id AND version=intent.record_version))
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=intent.application_uuid
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=intent.expected_history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='client'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=?
    ORDER BY outbox.created_at DESC,outbox.command_id DESC LIMIT 2`)
    .bind(RECORD_ID, expectedLocalVersion, SOURCE_ID, mapping.sourceInstanceId, mapping.applicationId,
      mapping.historyEpoch, RECORD_ID, mapping.projectAlphaPublicId, mapping.projectAlphaPublicId)
    .all<{ projectAlphaRevision: string; authorizationGeneration: string; destinationOrigin: string }>();
  if (receipts.results.length !== 1 || !revision(receipts.results[0]!.projectAlphaRevision)
    || !revision(receipts.results[0]!.authorizationGeneration, true)) return null;
  return { ...mapping, ...receipts.results[0]! };
}

export function registerStagingDirectoryDestinationReadbackRoute(app: App): void {
  app.post(STAGING_DIRECTORY_DESTINATION_READBACK_ROUTE, async c => {
    if (!projectAlphaApiV2ReadAcceptanceEnabled(c.env) || c.env.ENVIRONMENT !== "staging"
      || c.env.EXPECTED_HOST !== HOST || new URL(c.req.url).origin !== `https://${HOST}`)
      throw new HTTPException(404, { message: "Not found" });
    const principal = c.get("principal");
    if (!c.get("administrator") || principal.id !== "staff-beau-koltz")
      throw new HTTPException(403, { message: "Protected owner access required" });
    const management = await sqlScope(c.env, principal, "integrations.manage");
    if (!management.global || management.deniedGlobal)
      throw new HTTPException(403, { message: "Global integrations.manage permission required" });
    let native: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
    try { native = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, {
      enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD,
    }); } catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
    if (native.identity.staffId !== principal.id || native.identity.email !== principal.email
      || native.identity.verifiedAccessSubject !== principal.accessSubject)
      throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
    const owner = await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT 1 ok FROM staff_role_assignments
      WHERE staff_id=? AND role_id='role-owner' AND scope='global' LIMIT 1`).bind(principal.id).first();
    const viewGrant = await selectGrant(c.env.OPS_DB, principal.id, "directory.profile.view", RECORD_ID, [], false);
    if (!owner || !viewGrant)
      throw new HTTPException(403, { message: "Protected owner Directory profile view required" });
    const parsed = bodySchema.safeParse(await readBoundedJson(c.req.raw, 128, "Staging Directory destination readback"));
    if (!parsed.success) throw new HTTPException(400, { message: "Destination readback request is invalid" });
    c.header("Cache-Control", "no-store");
    const expected = await stagingDirectoryDestinationProof(c.env.OPS_DB, parsed.data.expectedLocalVersion);
    if (!expected) return c.json({ status: "blocked", exactIdentity: false, exactVersion: false, exactGeneration: false, exactProfile: false });
    const snapshot = await readNativeDirectoryClientProfileSnapshot(c.env.OPS_DB, RECORD_ID);
    const localProfile = snapshot?.version === parsed.data.expectedLocalVersion
      ? expectedStagingDirectoryDestinationProfile(snapshot.profile) : null;
    if (!localProfile) return c.json({ status: "blocked", exactIdentity: false, exactVersion: false, exactGeneration: false, exactProfile: false });
    let configuredBaseUrl: string;
    try { configuredBaseUrl = resolveProjectAlphaApiV2Connection(c.env, SOURCE_ID).connection.baseUrl; }
    catch { return c.json({ status: "blocked", exactIdentity: false, exactVersion: false, exactGeneration: false, exactProfile: false }); }
    if (expected.destinationOrigin !== configuredBaseUrl)
      return c.json({ status: "blocked", exactIdentity: false, exactVersion: false, exactGeneration: false, exactProfile: false });
    const outcome = await readConfiguredProjectAlphaDirectoryProfile(c.env, SOURCE_ID, "client", expected.projectAlphaPublicId);
    if (outcome.status !== "observed") return c.json({ status: "unavailable", exactIdentity: false, exactVersion: false, exactGeneration: false, exactProfile: false });
    const { exactIdentity, exactVersion, exactGeneration, exactProfile }
      = evaluateStagingDirectoryDestinationReadback(expected, localProfile, outcome.observation);
    const current = await stagingDirectoryDestinationProof(c.env.OPS_DB, parsed.data.expectedLocalVersion);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected))
      return c.json({ status: "blocked", exactIdentity: false, exactVersion: false, exactGeneration: false, exactProfile: false });
    return c.json({ status: exactIdentity && exactVersion && exactGeneration && exactProfile ? "verified" : "mismatch",
      exactIdentity, exactVersion, exactGeneration, exactProfile });
  });
}
