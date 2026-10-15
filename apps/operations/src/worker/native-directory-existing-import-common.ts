import { parseDuplicateFreeJson } from "./bounded-json";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { selectGrant } from "./native-directory-profile-routes";
import type { ProjectAlphaDirectoryProfile } from "./project-alpha-directory-read-api-v2";
import type { NativeExistingImportActor, NativeExistingImportEnvironment, NativeExistingImportReview } from "./native-directory-existing-import-types";
import { nativeExistingImportRecordId } from "./native-directory-existing-import-identity";
export const IMPORT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const IMPORT_PERMISSIONS = ["directory.profile.view", "directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"] as const;
export async function importSha(value: unknown): Promise<string> {
    const canonical = (input: unknown): string => {
        if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
        if (input && typeof input === "object") return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical((input as Record<string,unknown>)[key])}`).join(",")}}`;
        return JSON.stringify(input);
    };
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value==="string"?value:canonical(value))))]
        .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function importUuid(value: string): Promise<string> {
    const digest = await importSha(value);
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
export async function nativeExistingImportSchemaReady(db: D1Database): Promise<boolean> {
    const rows = await db.prepare(`SELECT name FROM sqlite_master WHERE name IN (
    'native_directory_existing_import_reviews','native_directory_existing_import_live_reviews',
    'native_directory_existing_import_execution_admissions','native_directory_existing_import_local_receipts',
    'native_directory_existing_import_identity_translations','native_directory_existing_import_source_cursors',
    'native_directory_existing_import_binding_intents','native_directory_existing_import_events',
    'native_directory_existing_import_renewals')`).all<{
        name: string;
    }>();
    return rows.results.length === 9;
}
export function nativeExistingImportAreas(env: NativeExistingImportEnvironment): Readonly<Record<string, string>> {
    if (env.NATIVE_DIRECTORY_EXISTING_IMPORT_ENABLED !== "true")
        return {};
    try {
        const value = parseDuplicateFreeJson(env.NATIVE_DIRECTORY_EXISTING_IMPORT_AREAS ?? "");
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length < 1 || Object.keys(value).length > 64)
            return {};
        for (const [source, area] of Object.entries(value)) {
            if (!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(source) || typeof area !== "string"
                || !area || area.length > 191 || /\p{C}/u.test(area))
                return {};
            if (!resolveProjectAlphaApiV2Connection(env, source).enabled)
                return {};
        }
        return value as Record<string, string>;
    }
    catch {
        return {};
    }
}
export async function nativeExistingImportEnabled(env: NativeExistingImportEnvironment): Promise<boolean> {
    return Object.keys(nativeExistingImportAreas(env)).length > 0 && await nativeExistingImportSchemaReady(env.OPS_DB);
}
export function nativeImportProfile(remote: ProjectAlphaDirectoryProfile, kind: "organization" | "client"): NativeExistingImportReview["profile"] {
    const scalar = (value: string | null | undefined) => (value ?? "").normalize("NFC").trim();
    const address = { addressLine1: scalar(remote.address.line1), addressLine2: scalar(remote.address.line2),
        city: scalar(remote.address.city), state: scalar(remote.address.state), postalCode: scalar(remote.address.postalCode), country: scalar(remote.address.country) };
    return kind === "organization" ? { name: scalar(remote.name), generalEmail: scalar(remote.email).toLowerCase(),
        generalPhone: scalar(remote.phone), ...address } : { name: scalar(remote.name), email: scalar(remote.email).toLowerCase(),
        phone: scalar(remote.phone), clientType: remote.clientType ?? "unknown", ...address };
}
export function validNativeImportProfile(profile: NativeExistingImportReview["profile"], kind: "organization" | "client"): boolean {
    const limits: Record<string, number> = { name: 150, email: 255, generalEmail: 255, phone: 50, generalPhone: 50, addressLine1: 255, addressLine2: 255,
        city: 100, state: kind === "client" ? 2 : 100, postalCode: kind === "client" ? 20 : 32, country: 100, clientType: 8 };
    const email = "generalEmail" in profile ? profile.generalEmail : profile.email;
    return (email===""||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) && profile.name.length > 0
        && Object.entries(profile).every(([key, value]) => typeof value === "string" && value.length <= (limits[key] ?? 0) && !/\p{C}/u.test(value));
}
export function sameImportActor(review: NativeExistingImportReview, actor: NativeExistingImportActor): boolean {
    return ["staffId", "accessSubject", "loginEmail", "admissionVersion", "profileVersion", "grantGeneration"].every(key => review.actor[key as keyof NativeExistingImportActor] === actor[key as keyof NativeExistingImportActor]);
}
export function nativeImportConfiguredReview(env: NativeExistingImportEnvironment, review: NativeExistingImportReview): boolean {
    try {
        const configured = resolveProjectAlphaApiV2Connection(env, review.sourceId);
        return configured.enabled && configured.connection.expectedSourceInstanceId === review.sourceInstanceId
            && configured.connection.expectedApplicationId === review.applicationId && configured.connection.expectedHistoryEpoch === review.historyEpoch
            && new URL(configured.connection.baseUrl).origin === review.origin;
    }
    catch {
        return false;
    }
}
export async function nativeExistingImportAuthority(env: NativeExistingImportEnvironment, actor: NativeExistingImportActor, sourceId: string, kind: "organization" | "client", recordId: string, area: string) {
    if (!Number.isFinite(Date.parse(actor.verifiedUntil)) || Date.parse(actor.verifiedUntil) <= Date.now()
        || nativeExistingImportAreas(env)[sourceId] !== area)
        return null;
    const configured = resolveProjectAlphaApiV2Connection(env,sourceId);
    if (!configured.enabled) return null;
    const current = await env.OPS_DB.withSession("first-primary").prepare(`SELECT 1 ok FROM native_staff_admissions admission
    JOIN staff_users staff ON staff.id=admission.staff_id AND staff.status='active' AND staff.access_subject=admission.bound_access_subject
    JOIN native_staff_profiles profile ON profile.staff_id=staff.id
    JOIN native_directory_grant_generations generation ON generation.staff_id=staff.id
    WHERE staff.id=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.login_email=? AND profile.version=? AND generation.generation=?
      AND EXISTS(SELECT 1 FROM staff_role_assignments owner WHERE owner.staff_id=staff.id AND owner.role_id='role-owner' AND owner.scope='global')
      AND EXISTS(SELECT 1 FROM native_business_areas area WHERE area.id=? AND area.active=1)
      AND EXISTS(SELECT 1 FROM pa_connectors connector WHERE connector.source_id=? AND connector.read_visible=1
        AND connector.state<>'retired' AND connector.snapshot_origin=?)`).bind(actor.staffId, actor.accessSubject, actor.admissionVersion,
        actor.loginEmail, actor.profileVersion, actor.grantGeneration, area, sourceId, configured.connection.baseUrl).first("ok");
    if (!current)
        return null;
    const nativeId = nativeExistingImportRecordId(sourceId, kind, recordId), scopes = [{ businessAreaId: area, divisionId: null }];
    const grants: Array<{
        permission: string;
        id: string;
    }> = [];
    for (const permission of IMPORT_PERMISSIONS) {
        const id = await selectGrant(env.OPS_DB, actor.staffId, permission, nativeId, scopes, true);
        const classicDeny = await env.OPS_DB.prepare(`SELECT 1 denied FROM native_directory_grants WHERE staff_id=?
      AND permission=? AND effect='deny' AND active=1 AND scope_kind='resource' AND resource_id=?`)
            .bind(actor.staffId, permission, recordId).first("denied");
        if (!id || classicDeny)
            return null;
        grants.push({ permission, id });
    }
    return grants;
}
export function importDestination(review: NativeExistingImportReview) {
    return { sourceId: review.sourceId, sourceInstanceUUID: review.sourceInstanceId, applicationUUID: review.applicationId,
        historyEpoch: review.historyEpoch, origin: review.origin, externalCanonicalId: review.nativeRecordId };
}
export async function savedNativeImport(env: NativeExistingImportEnvironment, id: string): Promise<NativeExistingImportReview | null> {
    const row = await env.OPS_DB.prepare("SELECT review_json FROM native_directory_existing_import_reviews WHERE import_id=?")
        .bind(id).first<{
        review_json: string;
    }>();
    return row ? JSON.parse(row.review_json) as NativeExistingImportReview : null;
}
