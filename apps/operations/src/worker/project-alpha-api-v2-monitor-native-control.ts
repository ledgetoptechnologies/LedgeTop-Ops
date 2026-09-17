import { isNativeAccessSubject } from "./native-access-subject";
import { evaluateNativeIntegrationControlPolicy } from "./native-integration-control-policy";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import {
  ProjectAlphaApiV2MonitorLifecycleConflict,
  readProjectAlphaApiV2MonitorLifecycleSession,
  snapshotProjectAlphaApiV2MonitorLifecycleDesired,
  type ProjectAlphaApiV2MonitorLifecycleIdentity,
  type ProjectAlphaApiV2MonitorLifecycleSnapshot,
} from "./project-alpha-api-v2-monitor-lifecycle";

const DENIED = "native_monitor_control_denied";
export class NativeMonitorControlDenied extends Error {
  constructor() { super(DENIED); this.name = "NativeMonitorControlDenied"; }
}
export class NativeMonitorControlOutcomeUnknown extends Error {
  constructor() { super("native_monitor_control_outcome_unknown"); this.name = "NativeMonitorControlOutcomeUnknown"; }
}
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export type NativeMonitorControlInput = Readonly<{
  authenticatedNativeStaff: AuthenticatedNativeStaffWithAdmissionVersion;
  expectedRevision: number;
  enabled: boolean;
  identities: readonly ProjectAlphaApiV2MonitorLifecycleIdentity[];
}>;

type Actor = Readonly<{
  staffId: string;
  accessSubject: string;
  admissionVersion: number;
  profileVersion: number;
  email: string;
  verifiedUntil: string;
}>;
type AuthorityRow = {
  bound_access_subject: unknown; active: unknown; admission_version: unknown;
  profile_version: unknown; login_email: unknown;
  grant_id: unknown; grant_version: unknown; grant_capability: unknown;
  grant_effect: unknown; grant_scope_kind: unknown; grant_active: unknown;
};
type HeadAttribution = { operator_command_id: string | null; audited: number };

function values(raw: unknown, expected: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) throw new NativeMonitorControlDenied();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== expected.length || keys.some(key => typeof key !== "string" || !expected.includes(key))) throw new NativeMonitorControlDenied();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const item = descriptors[key];
    if (!item?.enumerable || !('value' in item)) throw new NativeMonitorControlDenied();
    result[key] = item.value;
  }
  return result;
}

function actorSnapshot(raw: unknown): Actor {
  const auth = values(raw, ["identity", "admissionVersion", "verifiedUntil"]);
  const identity = values(auth.identity, ["kind", "staffId", "verifiedAccessSubject", "email", "displayName", "profileVersion"]);
  if (identity.kind !== "native" || typeof identity.staffId !== "string" || !STAFF_ID.test(identity.staffId)
    || !isNativeAccessSubject(identity.verifiedAccessSubject)
    || typeof identity.email !== "string" || identity.email.length < 3 || identity.email.length > 254
    || identity.email !== identity.email.trim() || identity.email !== identity.email.toLowerCase()
    || !EMAIL.test(identity.email) || /\p{C}/u.test(identity.email)
    || typeof identity.profileVersion !== "number" || !Number.isSafeInteger(identity.profileVersion)
    || identity.profileVersion < 1 || typeof auth.admissionVersion !== "number"
    || !Number.isSafeInteger(auth.admissionVersion) || auth.admissionVersion < 1
    || typeof auth.verifiedUntil !== "string" || auth.verifiedUntil.length !== 24
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(auth.verifiedUntil)
    || !Number.isFinite(Date.parse(auth.verifiedUntil))
    || new Date(auth.verifiedUntil).toISOString() !== auth.verifiedUntil
    || Date.parse(auth.verifiedUntil) <= Date.now()) throw new NativeMonitorControlDenied();
  return Object.freeze({ staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject,
    admissionVersion: auth.admissionVersion, profileVersion: identity.profileVersion,
    email: identity.email, verifiedUntil: auth.verifiedUntil });
}

function matchingAllow(rows: readonly AuthorityRow[], actor: Actor): { id: string; version: number } {
  if (rows.length < 1 || rows.length > 2) throw new NativeMonitorControlDenied();
  const first = rows[0]!;
  if (first.bound_access_subject !== actor.accessSubject || first.active !== 1
    || first.admission_version !== actor.admissionVersion
    || first.profile_version !== actor.profileVersion || first.login_email !== actor.email) throw new NativeMonitorControlDenied();
  const grants: Array<{ id: string; actorStaffId: string; capability: "integrations.monitor.manage";
    effect: "allow" | "deny"; scopeKind: "global"; active: boolean }> = [];
  const versions = new Map<string, number>();
  for (const row of rows) {
    if (row.bound_access_subject !== first.bound_access_subject || row.active !== first.active
      || row.admission_version !== first.admission_version || row.profile_version !== first.profile_version
      || row.login_email !== first.login_email) throw new NativeMonitorControlDenied();
    if (row.grant_id === null) continue;
    if (typeof row.grant_id !== "string" || !STAFF_ID.test(row.grant_id)
      || typeof row.grant_version !== "number" || !Number.isSafeInteger(row.grant_version)
      || row.grant_version < 1 || row.grant_capability !== "integrations.monitor.manage"
      || (row.grant_effect !== "allow" && row.grant_effect !== "deny")
      || row.grant_scope_kind !== "global" || (row.grant_active !== 0 && row.grant_active !== 1)) throw new NativeMonitorControlDenied();
    grants.push({ id: row.grant_id, actorStaffId: actor.staffId,
      capability: "integrations.monitor.manage", effect: row.grant_effect,
      scopeKind: "global", active: row.grant_active === 1 });
    versions.set(row.grant_id, row.grant_version);
  }
  const policy = evaluateNativeIntegrationControlPolicy({ actor: { staffId: actor.staffId,
    verifiedAccessSubject: actor.accessSubject, boundAccessSubject: first.bound_access_subject,
    activeNativeAdmission: first.active === 1 }, capability: "integrations.monitor.manage", grants });
  const allowId = policy.matchingAllowGrantIds[0];
  if (!policy.allowed || !allowId || !versions.has(allowId)) throw new NativeMonitorControlDenied();
  return { id: allowId, version: versions.get(allowId)! };
}

/** Authorized operator path. The older raw lifecycle helper remains an
 * internal, unaudited compatibility API and must never be mounted as a route. */
export async function applyNativeProjectAlphaApiV2MonitorLifecycle(database: D1Database,
  rawInput: NativeMonitorControlInput): Promise<ProjectAlphaApiV2MonitorLifecycleSnapshot> {
  let desired: ReturnType<typeof snapshotProjectAlphaApiV2MonitorLifecycleDesired>;
  let actor: Actor;
  try {
    const input = values(rawInput, ["authenticatedNativeStaff", "expectedRevision", "enabled", "identities"]);
    desired = snapshotProjectAlphaApiV2MonitorLifecycleDesired({ expectedRevision: input.expectedRevision,
      enabled: input.enabled, identities: input.identities });
    actor = actorSnapshot(input.authenticatedNativeStaff);
  } catch { throw new NativeMonitorControlDenied(); }

  try {
    const session = database.withSession("first-primary");
    const current = await readProjectAlphaApiV2MonitorLifecycleSession(session);
    if (current.revision !== desired.expectedRevision) throw new ProjectAlphaApiV2MonitorLifecycleConflict();
    const authority = await session.prepare(`SELECT admission.bound_access_subject,admission.active,
        admission.version AS admission_version,profile.version AS profile_version,profile.login_email,
        grant_row.id AS grant_id,grant_row.version AS grant_version,
        grant_row.capability AS grant_capability,grant_row.effect AS grant_effect,
        grant_row.scope_kind AS grant_scope_kind,grant_row.active AS grant_active
      FROM native_staff_admissions admission
      JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      LEFT JOIN native_integration_control_grants grant_row
        ON grant_row.actor_staff_id=admission.staff_id
          AND grant_row.capability='integrations.monitor.manage'
      WHERE admission.staff_id=? LIMIT 3`).bind(actor.staffId).all<AuthorityRow>();
    const allow = matchingAllow(authority.results, actor);
    if (Date.parse(actor.verifiedUntil) <= Date.now()) throw new NativeMonitorControlDenied();

    const head = await session.prepare(`SELECT operator_command_id,
        EXISTS(SELECT 1 FROM project_alpha_api_v2_monitor_operator_audit audit
          WHERE audit.lifecycle_id=head.lifecycle_id AND audit.lifecycle_revision=head.revision
            AND audit.command_id=head.operator_command_id) AS audited
      FROM project_alpha_api_v2_monitor_lifecycle_heads head WHERE lifecycle_id=1`)
      .first<HeadAttribution>();
    if (current.revision === 0 ? head !== null : head === null) throw new NativeMonitorControlDenied();
    if (head && head.operator_command_id !== null && head.audited !== 1) throw new NativeMonitorControlDenied();
    if (current.enabled === desired.enabled && JSON.stringify(current.identities) === desired.identitiesJson
      && head?.operator_command_id) {
      const live = await session.prepare(`SELECT EXISTS(
        SELECT 1 FROM project_alpha_api_v2_monitor_lifecycle_heads head
        JOIN project_alpha_api_v2_monitor_operator_audit audit
          ON audit.lifecycle_id=head.lifecycle_id AND audit.lifecycle_revision=head.revision
            AND audit.command_id=head.operator_command_id
        JOIN native_staff_admissions admission ON admission.staff_id=?
        JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
        JOIN native_integration_control_grants allow_row ON allow_row.id=?
        WHERE head.lifecycle_id=1 AND head.revision=? AND head.enabled=?
          AND head.identities_json=? AND admission.active=1
          AND admission.bound_access_subject=? AND admission.version=?
          AND profile.version=? AND profile.login_email=?
          AND allow_row.actor_staff_id=admission.staff_id
          AND allow_row.capability='integrations.monitor.manage'
          AND allow_row.effect='allow' AND allow_row.scope_kind='global'
          AND allow_row.active=1 AND allow_row.version=?
          AND NOT EXISTS(SELECT 1 FROM native_integration_control_grants deny_row
            WHERE deny_row.actor_staff_id=admission.staff_id
              AND deny_row.capability='integrations.monitor.manage'
              AND deny_row.effect='deny' AND deny_row.scope_kind='global' AND deny_row.active=1)
          AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS allowed`)
        .bind(actor.staffId,allow.id,current.revision,desired.enabled ? 1 : 0,
          desired.identitiesJson,actor.accessSubject,actor.admissionVersion,
          actor.profileVersion,actor.email,allow.version,actor.verifiedUntil)
        .first<{ allowed: number }>();
      if (live?.allowed !== 1 || Date.parse(actor.verifiedUntil) <= Date.now()) throw new NativeMonitorControlDenied();
      return current;
    }

    const nextRevision = current.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) throw new NativeMonitorControlDenied();
    const commandId = crypto.randomUUID();
    const write = current.revision === 0
      ? session.prepare(`INSERT INTO project_alpha_api_v2_monitor_lifecycle_heads
          (lifecycle_id,revision,enabled,identities_json,operator_command_id)
          SELECT 1,1,?,?,? WHERE NOT EXISTS
            (SELECT 1 FROM project_alpha_api_v2_monitor_lifecycle_heads WHERE lifecycle_id=1)`)
        .bind(desired.enabled ? 1 : 0, desired.identitiesJson, commandId)
      : session.prepare(`UPDATE project_alpha_api_v2_monitor_lifecycle_heads
          SET revision=?,enabled=?,identities_json=?,operator_command_id=?
          WHERE lifecycle_id=1 AND revision=?`)
        .bind(nextRevision,desired.enabled ? 1 : 0,desired.identitiesJson,commandId,current.revision);
    const audit = session.prepare(`INSERT INTO project_alpha_api_v2_monitor_operator_audit
      (lifecycle_id,lifecycle_revision,command_id,actor_staff_id,actor_access_subject,
       actor_admission_version,actor_profile_version,actor_email,verified_until,
       capability,allow_grant_id,allow_grant_version,enabled,identities_json)
      VALUES(1,?,?,?,?,?,?,?,?,'integrations.monitor.manage',?,?,?,?)`)
      .bind(nextRevision,commandId,actor.staffId,actor.accessSubject,actor.admissionVersion,
        actor.profileVersion,actor.email,actor.verifiedUntil,allow.id,allow.version,
        desired.enabled ? 1 : 0,desired.identitiesJson);
    const result = await session.batch([write,audit]);
    if (result.length !== 2 || result.some(item => !item.success)) throw new NativeMonitorControlOutcomeUnknown();
    return Object.freeze({ revision: nextRevision, enabled: desired.enabled, identities: desired.identities });
  } catch (error) {
    if (error instanceof ProjectAlphaApiV2MonitorLifecycleConflict
      || error instanceof NativeMonitorControlDenied
      || error instanceof NativeMonitorControlOutcomeUnknown) throw error;
    throw new NativeMonitorControlOutcomeUnknown();
  }
}
