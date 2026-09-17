import { isNativeAccessSubject } from "./native-access-subject";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { snapshotProjectAlphaApiV2MonitorLifecycleDesired } from "./project-alpha-api-v2-monitor-lifecycle";

const DENIED = "native_monitor_control_read_denied";
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ProjectAlphaApiV2MonitorControlReadback = Readonly<{
  revision: number;
  enabled: boolean;
  /** False means the current head is the pre-0091 legacy/unattributed state. */
  attributed: boolean;
}>;

export class ProjectAlphaApiV2MonitorControlReadError extends Error {
  constructor() { super(DENIED); this.name = "ProjectAlphaApiV2MonitorControlReadError"; }
}

/** A primary read could not establish a trustworthy answer. Callers should
 * expose this as a sanitized temporary-unavailable response, never as a
 * denied decision or as the inactive default. */
export class ProjectAlphaApiV2MonitorControlReadUnavailableError extends Error {
  constructor() {
    super("native_monitor_control_read_unavailable");
    this.name = "ProjectAlphaApiV2MonitorControlReadUnavailableError";
  }
}

type ReadRow = {
  bound_access_subject: unknown;
  admission_active: unknown;
  admission_version: unknown;
  profile_version: unknown;
  login_email: unknown;
  grant_id: unknown;
  grant_version: unknown;
  grant_capability: unknown;
  grant_effect: unknown;
  grant_scope_kind: unknown;
  grant_active: unknown;
  lifecycle_id: unknown;
  revision: unknown;
  enabled: unknown;
  identities_json: unknown;
  operator_command_id: unknown;
  audited: unknown;
};

const READ_ROW_KEYS = [
  "bound_access_subject", "admission_active", "admission_version", "profile_version", "login_email",
  "grant_id", "grant_version", "grant_capability", "grant_effect", "grant_scope_kind", "grant_active",
  "lifecycle_id", "revision", "enabled", "identities_json", "operator_command_id", "audited",
] as const;

function invalid(): never { throw new ProjectAlphaApiV2MonitorControlReadError(); }

function snapshotRecord(raw: unknown, expected: readonly string[]): Record<string, unknown> {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) invalid();
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== expected.length || keys.some(key => typeof key !== "string" || !expected.includes(key))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const copy: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
      Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true,
        writable: true, configurable: true });
    }
    return copy;
  } catch (error) {
    if (error instanceof ProjectAlphaApiV2MonitorControlReadError) throw error;
    invalid();
  }
}

type Actor = Readonly<{
  staffId: string;
  accessSubject: string;
  admissionVersion: number;
  profileVersion: number;
  email: string;
  verifiedUntil: string;
}>;

function actor(raw: unknown): Actor {
  const auth = snapshotRecord(raw, ["identity", "admissionVersion", "verifiedUntil"]);
  const identity = snapshotRecord(auth.identity,
    ["kind", "staffId", "verifiedAccessSubject", "email", "displayName", "profileVersion"]);
  if (identity.kind !== "native" || typeof identity.staffId !== "string" || !STAFF_ID.test(identity.staffId)
    || !isNativeAccessSubject(identity.verifiedAccessSubject)
    || typeof identity.email !== "string" || identity.email.length < 3 || identity.email.length > 254
    || identity.email !== identity.email.trim() || identity.email !== identity.email.toLowerCase()
    || !EMAIL.test(identity.email) || /\p{C}/u.test(identity.email)
    || typeof identity.profileVersion !== "number" || !Number.isSafeInteger(identity.profileVersion)
    || identity.profileVersion < 1 || typeof auth.admissionVersion !== "number"
    || !Number.isSafeInteger(auth.admissionVersion) || auth.admissionVersion < 1
    || typeof auth.verifiedUntil !== "string" || !ISO.test(auth.verifiedUntil)
    || !Number.isFinite(Date.parse(auth.verifiedUntil))
    || new Date(auth.verifiedUntil).toISOString() !== auth.verifiedUntil
    || Date.parse(auth.verifiedUntil) <= Date.now()) invalid();
  return Object.freeze({ staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject,
    admissionVersion: auth.admissionVersion, profileVersion: identity.profileVersion,
    email: identity.email, verifiedUntil: auth.verifiedUntil });
}

function parseCurrent(row: ReadRow): ProjectAlphaApiV2MonitorControlReadback {
  if (row.lifecycle_id === null) return Object.freeze({ revision: 0, enabled: false, attributed: false });
  if (row.lifecycle_id !== 1 || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision)
    || row.revision < 1 || (row.enabled !== 0 && row.enabled !== 1)
    || typeof row.identities_json !== "string" || typeof row.operator_command_id !== "string"
      && row.operator_command_id !== null || (row.operator_command_id !== null && !UUID_V4.test(row.operator_command_id))
    || (row.operator_command_id !== null && row.audited !== 1)
    || (row.operator_command_id === null && row.audited !== 0)) invalid();
  let identities: unknown;
  try { identities = JSON.parse(row.identities_json); } catch { invalid(); }
  snapshotProjectAlphaApiV2MonitorLifecycleDesired({ expectedRevision: row.revision,
    enabled: row.enabled === 1, identities });
  return Object.freeze({ revision: row.revision, enabled: row.enabled === 1,
    attributed: row.operator_command_id !== null });
}

/**
 * Read the current monitor control state for a previously authenticated native
 * staff member. The authority and head are obtained in one first-primary
 * snapshot; this function never writes, parses deployment secrets, or retries
 * a mutation. A legacy head with a null command attribution is returned with
 * attributed=false so an authorized takeover can be deliberate.
 */
export async function readProjectAlphaApiV2MonitorControl(
  database: D1Database, authenticatedNativeStaff: AuthenticatedNativeStaffWithAdmissionVersion,
): Promise<ProjectAlphaApiV2MonitorControlReadback> {
  let input: Actor;
  try { input = actor(authenticatedNativeStaff); } catch { throw new ProjectAlphaApiV2MonitorControlReadError(); }
  let result: D1Result<ReadRow>;
  try {
    const session = database.withSession("first-primary");
    result = await session.prepare(`SELECT admission.bound_access_subject,
        admission.active AS admission_active,admission.version AS admission_version,
        profile.version AS profile_version,profile.login_email,
        allow_row.id AS grant_id,allow_row.version AS grant_version,
        allow_row.capability AS grant_capability,allow_row.effect AS grant_effect,
        allow_row.scope_kind AS grant_scope_kind,allow_row.active AS grant_active,
        head.lifecycle_id,head.revision,head.enabled,head.identities_json,
        head.operator_command_id,
        EXISTS(SELECT 1 FROM project_alpha_api_v2_monitor_operator_audit audit
          WHERE audit.lifecycle_id=head.lifecycle_id AND audit.lifecycle_revision=head.revision
            AND audit.command_id=head.operator_command_id) AS audited
      FROM native_staff_admissions admission
      JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      JOIN native_integration_control_grants allow_row
        ON allow_row.actor_staff_id=admission.staff_id
          AND allow_row.capability='integrations.monitor.manage'
          AND allow_row.effect='allow' AND allow_row.scope_kind='global' AND allow_row.active=1
      LEFT JOIN project_alpha_api_v2_monitor_lifecycle_heads head ON head.lifecycle_id=1
      WHERE admission.staff_id=? AND admission.active=1
        AND admission.bound_access_subject=? AND admission.version=?
        AND profile.version=? AND profile.login_email=? COLLATE BINARY
        AND NOT EXISTS(SELECT 1 FROM native_integration_control_grants deny_row
          WHERE deny_row.actor_staff_id=admission.staff_id
            AND deny_row.capability='integrations.monitor.manage'
            AND deny_row.effect='deny' AND deny_row.scope_kind='global' AND deny_row.active=1)
        AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      LIMIT 2`).bind(input.staffId, input.accessSubject, input.admissionVersion,
        input.profileVersion, input.email, input.verifiedUntil).all<ReadRow>();
  } catch { throw new ProjectAlphaApiV2MonitorControlReadUnavailableError(); }
  if (result.success !== true) throw new ProjectAlphaApiV2MonitorControlReadUnavailableError();
  if (Date.parse(input.verifiedUntil) <= Date.now() || !Array.isArray(result.results)
    || result.results.length !== 1) throw new ProjectAlphaApiV2MonitorControlReadError();
  try {
    const row = snapshotRecord(result.results[0], READ_ROW_KEYS) as ReadRow;
    return parseCurrent(row);
  } catch (error) {
    if (error instanceof ProjectAlphaApiV2MonitorControlReadError) throw error;
    throw new ProjectAlphaApiV2MonitorControlReadError();
  }
}
