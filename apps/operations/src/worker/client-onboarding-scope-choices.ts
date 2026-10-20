import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

export type ClientOnboardingScopeChoices = Readonly<{ scopes: Array<{
  businessAreaId: string; name: string; allowAreaWide: boolean;
  divisions: Array<{ divisionId: string; name: string }>;
}> }>;
const LIMIT = 512;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const denied = (): never => { throw Error("client_onboarding_scope_choices_denied"); };
const unavailable = (): never => { throw Error("client_onboarding_scope_choices_unavailable"); };

/** Advisory names only. This reads exactly the proposed-scope profile.edit
 * authority used by client_onboarding_live_issuances (0078); issuance still
 * validates all selected values inside its transaction. No grants are inferred
 * from a staff role, PA destination, customer relationship or an email match. */
export async function readClientOnboardingScopeChoices(database: D1Database,
  auth: AuthenticatedNativeStaffWithAdmissionVersion): Promise<ClientOnboardingScopeChoices> {
  const { staffId, verifiedAccessSubject, email, profileVersion } = auth.identity;
  const { admissionVersion, verifiedUntil } = auth;
  if (!Number.isSafeInteger(profileVersion) || profileVersion < 1
    || !Number.isSafeInteger(admissionVersion) || admissionVersion < 1
    || !Number.isFinite(Date.parse(verifiedUntil)) || Date.parse(verifiedUntil) <= Date.now()) return denied();
  // One primary statement checks current identity AND current grants alongside
  // the candidate names. A left-join sentinel distinguishes no authorized scope
  // from a revoked/stale staff admission without enumerating other staff.
  const rows = (await database.withSession("first-primary").prepare(`WITH authority AS (
    SELECT admission.staff_id FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?
      AND admission.version=? AND profile.login_email=? AND profile.version=?
      AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  ), candidates AS (
    SELECT area.id businessAreaId,area.name areaName,NULL divisionId,NULL divisionName
    FROM native_business_areas area WHERE area.active=1
    UNION ALL
    SELECT area.id,area.name,division.id,division.name
    FROM native_business_areas area JOIN native_business_divisions division
      ON division.business_area_id=area.id AND division.active=1 WHERE area.active=1
  ), permitted AS (
    SELECT candidate.* FROM candidates candidate,authority actor
    WHERE EXISTS(SELECT 1 FROM native_directory_grants grant_row
      WHERE grant_row.staff_id=actor.staff_id AND grant_row.permission='directory.profile.edit'
        AND grant_row.active=1 AND grant_row.effect='allow'
        AND (grant_row.scope_kind='global'
          OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=candidate.businessAreaId)
          OR (grant_row.scope_kind='division' AND grant_row.division_id=candidate.divisionId)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants grant_row
        WHERE grant_row.staff_id=actor.staff_id AND grant_row.permission='directory.profile.edit'
          AND grant_row.active=1 AND grant_row.effect='deny'
          AND (grant_row.scope_kind='global'
            OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=candidate.businessAreaId)
            OR (grant_row.scope_kind='division' AND grant_row.division_id=candidate.divisionId)))
  ) SELECT permitted.* FROM authority LEFT JOIN permitted ON 1=1
    ORDER BY areaName,businessAreaId,divisionName,divisionId LIMIT ${LIMIT + 1}`)
    .bind(staffId, verifiedAccessSubject, admissionVersion, email, profileVersion, verifiedUntil)
    .all<{ businessAreaId: string | null; areaName: string | null;
      divisionId: string | null; divisionName: string | null }>()).results;
  if (rows.length === 0 || Date.parse(verifiedUntil) <= Date.now()) return denied();
  if (rows.length > LIMIT) return unavailable();
  const scopes: ClientOnboardingScopeChoices["scopes"] = [];
  const areas = new Map<string, ClientOnboardingScopeChoices["scopes"][number]>();
  for (const row of rows) {
    if (row.businessAreaId === null) {
      if (rows.length !== 1 || row.areaName !== null || row.divisionId !== null || row.divisionName !== null) return unavailable();
      continue;
    }
    if (!ID.test(row.businessAreaId) || typeof row.areaName !== "string" || row.areaName.length < 1
      || row.areaName.length > 300 || (row.divisionId !== null && (!ID.test(row.divisionId)
        || typeof row.divisionName !== "string" || row.divisionName.length < 1 || row.divisionName.length > 300))) return unavailable();
    let area = areas.get(row.businessAreaId);
    if (!area) { area = { businessAreaId: row.businessAreaId, name: row.areaName, allowAreaWide: false, divisions: [] };
      scopes.push(area); areas.set(row.businessAreaId, area); }
    if (area.name !== row.areaName) return unavailable();
    if (row.divisionId === null) area.allowAreaWide = true;
    else area.divisions.push({ divisionId: row.divisionId, name: row.divisionName! });
  }
  return { scopes };
}
