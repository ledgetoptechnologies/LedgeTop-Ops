import type { InviteDestinationBinding } from "./client-onboarding-invite-destinations";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

type SourceIdentity = Readonly<{ instance: string; application: string; epoch: string }>;
export type InviteTargetLookup = Readonly<{ kind: "client" | "organization"; publicId: string }>;
type Pin = { recordId: string; recordVersion: number; mappingId: string; enrollmentId: string };
type Result = Pin & { organizationId: string | null; relationshipVersion: number | null };
export type TargetChoiceContext = Readonly<{
  origin: string;
  auth: AuthenticatedNativeStaffWithAdmissionVersion;
  binding: InviteDestinationBinding;
  source: SourceIdentity;
  lookup: InviteTargetLookup;
}>;
export type TargetSearchContext = Omit<TargetChoiceContext, "lookup"> & Readonly<{
  kind: InviteTargetLookup["kind"]; query: string; cursor: string | null;
}>;
export type VerifiedInviteTarget = Readonly<{ context: TargetChoiceContext; pin: readonly [Result, Pin | null] }>;
type Sign = (message: string) => Promise<string>;

export async function currentInviteTargetChoice(db: D1Database, context: TargetChoiceContext, sign: Sign) {
  const { origin, auth, binding, source, lookup } = context;
  const pin = await readInviteTargetChoice(db, auth, binding, source, lookup);
  if (!pin) return null;
  const { staffId, verifiedAccessSubject, profileVersion } = auth.identity;
  const reference = await sign(JSON.stringify(["client-onboarding-target-choice-v1", origin, staffId, verifiedAccessSubject,
    auth.admissionVersion, profileVersion, auth.verifiedUntil, binding, source.instance, source.application, source.epoch,
    lookup.kind, lookup.publicId, pin]));
  return Date.parse(auth.verifiedUntil) > Date.now() ? { reference, pin } : null;
}

/** Fresh lookup and exact equality for a future issuer. A write must still check
 * these pins in its own transaction before it can accept a target. */
export async function verifyInviteTargetChoice(db: D1Database, context: TargetChoiceContext, reference: unknown, sign: Sign) {
  if (typeof reference !== "string" || !/^[0-9a-f]{64}$/.test(reference)) return null;
  const current = await currentInviteTargetChoice(db, context, sign);
  return current && timingSafeEqual(Buffer.from(reference, "hex"), Buffer.from(current.reference, "hex")) ? current.pin : null;
}

function targetEligibilitySql(search: boolean) {
  // Count collisions once per source slice, before names or cursors can hide a conflicting mapping.
  // The view exposes three non-null, binary-collated identity keys. Each group includes the row itself.
  const mappingTable = search ? "source_mappings" : "project_alpha_active_directory_mappings";
  return `WITH parameters AS (
    SELECT ? staff,? subject,? admission,? profile,? email,? deadline,? area,? division,? source,? instance,? application,? epoch,? kind,? publicId,? needsIdentityLink
      ${search ? ", ? query, ? afterId" : ""}
  ), actor AS (
    SELECT p.* FROM parameters p JOIN native_staff_admissions a ON a.staff_id=p.staff AND a.active=1
      AND a.bound_access_subject=p.subject AND a.version=p.admission
    JOIN native_staff_profiles f ON f.staff_id=p.staff AND f.version=p.profile AND f.login_email=p.email
    JOIN staff_users staff ON staff.id=p.staff AND staff.status='active' AND staff.access_subject=p.subject
    JOIN native_business_areas area ON area.id=p.area AND area.active=1
    JOIN native_business_divisions division ON division.id=p.division AND division.business_area_id=area.id AND division.active=1
    WHERE p.deadline>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=p.staff AND grant_row.active=1
        AND grant_row.permission='directory.profile.edit' AND grant_row.effect='allow' AND (grant_row.scope_kind='global'
          OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=p.area)
          OR (grant_row.scope_kind='division' AND grant_row.division_id=p.division)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants denied WHERE denied.staff_id=p.staff AND denied.active=1
        AND denied.permission='directory.profile.edit' AND denied.effect='deny' AND (denied.scope_kind='global'
          OR (denied.scope_kind='business_area' AND denied.business_area_id=p.area)
          OR (denied.scope_kind='division' AND denied.division_id=p.division)))
  )${search ? `, source_mappings AS MATERIALIZED (
    SELECT mapping.*,
      count(*) OVER (PARTITION BY mapping.resource_type,mapping.project_alpha_public_id) publicIdCount,
      count(*) OVER (PARTITION BY mapping.resource_type,mapping.record_id) recordCount,
      count(*) OVER (PARTITION BY mapping.resource_type,mapping.external_id) externalCount
    FROM actor p JOIN project_alpha_active_directory_mappings mapping ON mapping.source_id=p.source
      AND mapping.source_instance_id=p.instance AND mapping.application_id=p.application AND mapping.history_epoch_id=p.epoch
  )` : ""}, requested AS (
    SELECT mapping.record_id FROM actor p JOIN ${mappingTable} mapping ON mapping.source_id=p.source
      AND mapping.source_instance_id=p.instance AND mapping.application_id=p.application AND mapping.history_epoch_id=p.epoch
      AND mapping.resource_type=p.kind
    ${search ? `JOIN operations_directory_records record ON record.record_id=mapping.record_id
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      WHERE length(mapping.project_alpha_public_id)=32 AND mapping.project_alpha_public_id NOT GLOB '*[^0-9a-f]*'
        AND mapping.project_alpha_public_id COLLATE BINARY > p.afterId
        AND json_type(revision.profile_json,'$.name')='text'
        AND length(trim(json_extract(revision.profile_json,'$.name'))) BETWEEN 1 AND 200
        AND instr(lower(trim(json_extract(revision.profile_json,'$.name'))),lower(p.query))>0`
    : "AND mapping.project_alpha_public_id=p.publicId LIMIT 2"}
  ), mapped AS (
    SELECT mapping.*,enrollment.provenance_id enrollmentId
    FROM actor p JOIN ${mappingTable} mapping ON mapping.source_id=p.source AND mapping.source_instance_id=p.instance
      AND mapping.application_id=p.application AND mapping.history_epoch_id=p.epoch
    JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=mapping.record_id
    JOIN json_each(enrollment.destinations_json) destination ON json_extract(destination.value,'$.sourceId')=p.source
      AND json_extract(destination.value,'$.sourceInstanceUUID')=p.instance AND json_extract(destination.value,'$.applicationUUID')=p.application
      AND json_extract(destination.value,'$.historyEpoch')=p.epoch
      AND json_extract(destination.value,'$.externalCanonicalId')=mapping.external_id
    WHERE ${search ? "" : "(SELECT count(*) FROM requested)=1 AND "} (mapping.record_id IN (SELECT record_id FROM requested)
      OR (p.kind='client' AND mapping.resource_type='organization' AND mapping.record_id IN (
        SELECT relation.organization_record_id FROM operations_directory_client_organizations relation JOIN requested
          ON requested.record_id=relation.client_record_id)))
  ), available AS (
    SELECT record.record_id recordId,record.current_version recordVersion,mapped.provenance_id mappingId,mapped.enrollmentId,
      mapped.resource_type kind,mapped.project_alpha_public_id publicId
    FROM actor p JOIN mapped ON 1=1
    JOIN operations_directory_records record ON record.record_id=mapped.record_id AND record.record_kind=mapped.resource_type
    JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=record.record_id AND lifecycle.status='active'
    WHERE EXISTS(SELECT 1 FROM operations_directory_revisions revision WHERE revision.record_id=record.record_id AND revision.version=record.current_version)
      AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=record.record_id AND scope.active=1
        AND scope.business_area_id=p.area AND scope.division_id=p.division)
      AND NOT EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        LEFT JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
        LEFT JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=area.id AND division.active=1
        WHERE scope.record_id=record.record_id AND scope.active=1 AND (area.id IS NULL OR (scope.division_id IS NOT NULL AND division.id IS NULL)))
      AND NOT EXISTS(SELECT 1 FROM (SELECT 'directory.profile.view' permission UNION ALL SELECT 'directory.profile.edit'
        UNION ALL SELECT 'directory.identity.link') required
        WHERE (required.permission<>'directory.identity.link' OR p.needsIdentityLink=1)
          AND NOT EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=p.staff
          AND grant_row.permission=required.permission AND grant_row.active=1 AND grant_row.effect='allow'
          AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='resource' AND grant_row.resource_id=record.record_id)
            OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=p.area)
            OR (grant_row.scope_kind='division' AND grant_row.division_id=p.division))))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants denied WHERE denied.staff_id=p.staff AND denied.active=1 AND denied.effect='deny'
        AND (denied.permission IN ('directory.profile.view','directory.profile.edit') OR (p.needsIdentityLink=1 AND denied.permission='directory.identity.link'))
        AND (denied.scope_kind='global'
          OR (denied.scope_kind='resource' AND denied.resource_id=record.record_id)
          OR (denied.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.staff_id=p.staff AND assignment.record_id=record.record_id AND assignment.active=1))
          OR EXISTS(SELECT 1 FROM native_directory_resource_scopes scope WHERE scope.record_id=record.record_id AND scope.active=1
            AND ((denied.scope_kind='business_area' AND denied.business_area_id=scope.business_area_id)
              OR (denied.scope_kind='division' AND denied.division_id=scope.division_id)))))
      AND ${search ? "mapped.publicIdCount=1 AND mapped.recordCount=1 AND mapped.externalCount=1"
        : `(SELECT count(*) FROM project_alpha_active_directory_mappings other WHERE other.source_id=p.source
        AND other.source_instance_id=p.instance AND other.application_id=p.application AND other.history_epoch_id=p.epoch
        AND other.resource_type=mapped.resource_type
        AND (other.project_alpha_public_id=mapped.project_alpha_public_id OR other.record_id=mapped.record_id OR other.external_id=mapped.external_id))=1`}
  )`;
}

const currentTargetSql = `${targetEligibilitySql(false)}
  SELECT target.recordId,target.recordVersion,target.mappingId,target.enrollmentId,
    relation.organization_record_id organizationId,relation.relationship_version relationshipVersion,
    organization.recordId orgRecordId,organization.recordVersion orgRecordVersion,
    organization.mappingId orgMappingId,organization.enrollmentId orgEnrollmentId
  FROM actor p JOIN available target ON target.kind=p.kind AND target.publicId=p.publicId
  LEFT JOIN operations_directory_client_organizations relation ON target.kind='client' AND relation.client_record_id=target.recordId
  LEFT JOIN available organization ON organization.kind='organization' AND organization.recordId=relation.organization_record_id
  LIMIT 2`;

const TARGET_PAGE_SIZE = 12;
const searchTargetSql = `${targetEligibilitySql(true)}
  SELECT target.publicId,trim(json_extract(revision.profile_json,'$.name')) displayName
  FROM actor p JOIN available target ON target.kind=p.kind
  JOIN operations_directory_revisions revision ON revision.record_id=target.recordId AND revision.version=target.recordVersion
  LEFT JOIN operations_directory_client_organizations relation ON target.kind='client' AND relation.client_record_id=target.recordId
  LEFT JOIN available organization ON organization.kind='organization' AND organization.recordId=relation.organization_record_id
  WHERE target.recordId IN (SELECT record_id FROM requested)
    AND (p.kind='organization' OR (typeof(relation.relationship_version)='integer'
      AND relation.relationship_version BETWEEN 1 AND 9007199254740991
      AND (relation.organization_record_id IS NULL OR organization.recordId IS NOT NULL)))
  GROUP BY target.publicId HAVING count(*)=1
  ORDER BY target.publicId COLLATE BINARY
  LIMIT ${TARGET_PAGE_SIZE + 1}`;

function targetBindings({ auth, binding, source, lookup }: Omit<TargetChoiceContext, "origin">, needsIdentityLink: boolean) {
  const { staffId, verifiedAccessSubject, profileVersion, email } = auth.identity;
  return [staffId, verifiedAccessSubject, auth.admissionVersion, profileVersion, email, auth.verifiedUntil,
    binding.businessAreaId, binding.divisionId, binding.sourceId, source.instance, source.application, source.epoch,
    lookup.kind, lookup.publicId, Number(needsIdentityLink)];
}

export async function searchInviteTargets(db: D1Database, context: TargetSearchContext, sign: Sign) {
  const { origin, auth, binding, source, kind, query, cursor } = context;
  const cursorTag = (publicId: string) => sign(JSON.stringify(["client-onboarding-target-search-v1", origin,
    auth.identity.staffId, auth.identity.verifiedAccessSubject, auth.admissionVersion, auth.identity.profileVersion,
    auth.verifiedUntil, binding, source, kind, query, publicId]));
  let afterId = "";
  if (cursor !== null) {
    const match = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(cursor);
    const id = match?.[1], tag = match?.[2];
    if (!id || !tag) return null;
    if (!timingSafeEqual(Buffer.from(tag, "hex"), Buffer.from(await cursorTag(id), "hex"))) return null;
    afterId = id;
  }
  const { results } = await db.withSession("first-primary").prepare(searchTargetSql)
    .bind(...targetBindings({ auth, binding, source, lookup: { kind, publicId: "" } }, false), query, afterId)
    .all<{ publicId: string; displayName: string }>();
  const page = results.slice(0, TARGET_PAGE_SIZE);
  const last = page.at(-1)?.publicId;
  const nextCursor = last && results.length > TARGET_PAGE_SIZE ? `${last}.${await cursorTag(last)}` : null;
  return Date.parse(auth.verifiedUntil) > Date.now()
    ? { targets: page.map(({ publicId, displayName }) => ({ sourceId: binding.sourceId, kind, publicId, displayName })), nextCursor } : null;
}

/** Exact local lookup. A current mapping alone does not authorize directory reads. */
export async function readInviteTargetChoice(db: D1Database, auth: AuthenticatedNativeStaffWithAdmissionVersion,
  binding: InviteDestinationBinding, source: SourceIdentity, lookup: InviteTargetLookup): Promise<readonly [Result, Pin | null] | null> {
  const { results } = await db.withSession("first-primary").prepare(currentTargetSql)
    .bind(...targetBindings({ auth, binding, source, lookup }, false)).all<Result & { orgRecordId: string | null; orgRecordVersion: number | null;
        orgMappingId: string | null; orgEnrollmentId: string | null }>();
  if (results.length !== 1 || !(Date.parse(auth.verifiedUntil) > Date.now())) return null;
  const { orgRecordId, orgRecordVersion, orgMappingId, orgEnrollmentId, ...target } = results[0];
  if (!Number.isSafeInteger(target.recordVersion) || target.recordVersion < 1
    || (lookup.kind === "client" && (!Number.isSafeInteger(target.relationshipVersion) || target.relationshipVersion! < 1))) return null;
  if (target.organizationId === null) return [target, null];
  if (orgRecordId !== target.organizationId || orgRecordVersion === null || orgRecordVersion < 1 || !orgMappingId || !orgEnrollmentId) return null;
  return [target, { recordId: orgRecordId, recordVersion: orgRecordVersion, mappingId: orgMappingId, enrollmentId: orgEnrollmentId }];
}

/** Provisional issuance statement. Append every selected source to the same
 * batch as the invite, issuance command and encrypted handoff. */
export function inviteTargetProofStatement(db: Pick<D1Database, "prepare">, context: TargetChoiceContext,
  pin: readonly [Result, Pin | null], invitationId: string, issuanceSha256: string) {
  const [target, organization] = pin;
  const { binding, source, lookup, auth } = context;
  return db.prepare(`WITH current AS (${currentTargetSql})
    INSERT INTO client_onboarding_target_proofs(invitation_id,source_id,issuance_sha256,proof_json)
    VALUES (?, ?, ?, CASE WHEN (SELECT count(*) FROM current)=1 AND EXISTS (
      SELECT 1 FROM current WHERE recordId IS ? AND recordVersion IS ? AND mappingId IS ? AND enrollmentId IS ?
        AND organizationId IS ? AND relationshipVersion IS ? AND orgRecordId IS ? AND orgRecordVersion IS ?
        AND orgMappingId IS ? AND orgEnrollmentId IS ?
    ) AND EXISTS (SELECT 1 FROM client_onboarding_issuance_commands command
      JOIN client_onboarding_invitations invitation USING(invitation_id)
      JOIN json_each(command.destination_intent_json) destination
      WHERE command.invitation_id=? AND command.request_sha256=? AND invitation.issued_by=? AND invitation.bound_access_subject=?
        AND command.issuer_admission_version=? AND command.issuer_profile_version=?
        AND json_extract(destination.value,'$.sourceId')=? AND json_extract(destination.value,'$.businessAreaId')=?
        AND json_extract(destination.value,'$.divisionId')=?) THEN ? ELSE NULL END)
    ON CONFLICT(invitation_id,source_id) DO UPDATE SET proof_json=NULL
    WHERE client_onboarding_target_proofs.issuance_sha256<>excluded.issuance_sha256
      OR client_onboarding_target_proofs.proof_json<>excluded.proof_json`)
    .bind(...targetBindings(context, true), invitationId, binding.sourceId, issuanceSha256,
      target.recordId, target.recordVersion, target.mappingId, target.enrollmentId, target.organizationId, target.relationshipVersion,
      organization?.recordId ?? null, organization?.recordVersion ?? null, organization?.mappingId ?? null, organization?.enrollmentId ?? null,
      invitationId, issuanceSha256, auth.identity.staffId, auth.identity.verifiedAccessSubject,
      auth.admissionVersion, auth.identity.profileVersion, binding.sourceId, binding.businessAreaId, binding.divisionId,
      JSON.stringify(["client-onboarding-target-proof-v1", binding, source, lookup, pin]));
}
