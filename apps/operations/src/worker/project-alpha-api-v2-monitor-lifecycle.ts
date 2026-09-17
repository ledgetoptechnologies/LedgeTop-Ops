import {
  observeProjectAlphaApiV2Incident,
  type ProjectAlphaApiV2IncidentIdentity,
} from "./project-alpha-api-v2-incident-policy";

const LIFECYCLE_ID = 1;
const MAX_IDENTITIES = 16;
const MAX_IDENTITIES_BYTES = 128 * 1024;
const DENIED = "project_alpha_api_v2_monitor_lifecycle_unavailable";
const CONFLICT = "project_alpha_api_v2_monitor_lifecycle_conflict";

export type ProjectAlphaApiV2MonitorLifecycleIdentity = ProjectAlphaApiV2IncidentIdentity;

export type ProjectAlphaApiV2MonitorLifecycleSnapshot = Readonly<{
  revision: number;
  enabled: boolean;
  identities: readonly ProjectAlphaApiV2MonitorLifecycleIdentity[];
}>;

export class ProjectAlphaApiV2MonitorLifecycleError extends Error {
  constructor() { super(DENIED); this.name = "ProjectAlphaApiV2MonitorLifecycleError"; }
}

export class ProjectAlphaApiV2MonitorLifecycleConflict extends Error {
  constructor() { super(CONFLICT); this.name = "ProjectAlphaApiV2MonitorLifecycleConflict"; }
}

type Row = { lifecycle_id: number; revision: number; enabled: number; identities_json: string };
export type ProjectAlphaApiV2MonitorLifecycleDesired = Readonly<{
  expectedRevision: number; enabled: boolean;
  identities: readonly ProjectAlphaApiV2MonitorLifecycleIdentity[];
  identitiesJson: string;
}>;

function invalid(): never { throw new ProjectAlphaApiV2MonitorLifecycleError(); }

function snapshotRecord(raw: unknown): Record<string, unknown> | null {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.some(key => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const entries: Array<[string, unknown]> = [];
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (!descriptor?.enumerable || !("value" in descriptor)) return null;
      entries.push([key as string, descriptor.value]);
    }
    return Object.fromEntries(entries);
  } catch { return null; }
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && keys.every(key => required.includes(key))
    && required.every(key => Object.hasOwn(value, key));
}

function identity(raw: unknown): ProjectAlphaApiV2MonitorLifecycleIdentity {
  const value = snapshotRecord(raw);
  if (!value || !exactKeys(value,
    ["sourceId", "applicationId", "baseUrl", "expectedSourceInstanceId", "expectedHistoryEpoch"])) invalid();
  if (Object.values(value).some(item => typeof item !== "string")) invalid();
  try {
    // This pure policy validator also snapshots the identity and enforces the
    // canonical source, UUID-v4, and HTTPS-origin rules.
    return observeProjectAlphaApiV2Incident(null, value as ProjectAlphaApiV2IncidentIdentity,
      { kind: "disabled", startedAt: 0 }).identity;
  } catch { invalid(); }
}

function identityKey(value: ProjectAlphaApiV2MonitorLifecycleIdentity): string {
  return JSON.stringify([value.sourceId, value.applicationId, value.baseUrl,
    value.expectedSourceInstanceId, value.expectedHistoryEpoch]);
}

function snapshotArray(raw: unknown): readonly unknown[] {
  if (!Array.isArray(raw)) invalid();
  try {
    const keys = Reflect.ownKeys(raw);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_IDENTITIES) invalid();
    const length = lengthDescriptor.value as number;
    if (keys.length !== length + 1 || keys.some(key => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)))) invalid();
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof ProjectAlphaApiV2MonitorLifecycleError) throw error;
    invalid();
  }
}

function identities(raw: unknown): readonly ProjectAlphaApiV2MonitorLifecycleIdentity[] {
  const result = snapshotArray(raw).map(identity).sort((left, right) => {
    const leftKey = identityKey(left), rightKey = identityKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const keys = new Set<string>();
  const sources = new Set<string>();
  const applications = new Set<string>();
  for (const value of result) {
    const key = identityKey(value);
    const application = JSON.stringify([value.expectedSourceInstanceId, value.applicationId]);
    if (keys.has(key) || sources.has(value.sourceId) || applications.has(application)) invalid();
    keys.add(key);
    sources.add(value.sourceId);
    applications.add(application);
  }
  return Object.freeze(result);
}

export function snapshotProjectAlphaApiV2MonitorLifecycleDesired(raw: unknown): ProjectAlphaApiV2MonitorLifecycleDesired {
  const value = snapshotRecord(raw);
  if (!value || !exactKeys(value, ["expectedRevision", "enabled", "identities"])) invalid();
  if (typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision)
    || value.expectedRevision < 0 || typeof value.enabled !== "boolean") invalid();
  const selected = identities(value.identities);
  if (!value.enabled && selected.length !== 0) invalid();
  return Object.freeze({ expectedRevision: value.expectedRevision,
    enabled: value.enabled, identities: selected, identitiesJson: canonicalIdentitiesJson(selected) });
}

function canonicalIdentitiesJson(value: readonly ProjectAlphaApiV2MonitorLifecycleIdentity[]): string {
  const result = JSON.stringify(value);
  if (new TextEncoder().encode(result).byteLength > MAX_IDENTITIES_BYTES) invalid();
  return result;
}

function parseStoredIdentities(raw: string): readonly ProjectAlphaApiV2MonitorLifecycleIdentity[] {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_IDENTITIES_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { invalid(); }
  const selected = identities(value);
  if (canonicalIdentitiesJson(selected) !== raw) invalid();
  return selected;
}

function parseRow(row: Row): ProjectAlphaApiV2MonitorLifecycleSnapshot {
  if (!row || row.lifecycle_id !== LIFECYCLE_ID || !Number.isSafeInteger(row.revision)
    || row.revision < 1 || (row.enabled !== 0 && row.enabled !== 1)) invalid();
  const selected = parseStoredIdentities(row.identities_json);
  if (row.enabled === 0 && selected.length !== 0) invalid();
  return Object.freeze({ revision: row.revision, enabled: row.enabled === 1, identities: selected });
}

function initial(): ProjectAlphaApiV2MonitorLifecycleSnapshot {
  return Object.freeze({ revision: 0, enabled: false, identities: Object.freeze([]) });
}

export async function readProjectAlphaApiV2MonitorLifecycleSession(session: D1DatabaseSession): Promise<ProjectAlphaApiV2MonitorLifecycleSnapshot> {
  const row = await session.prepare(`SELECT lifecycle_id,revision,enabled,identities_json
    FROM project_alpha_api_v2_monitor_lifecycle_heads WHERE lifecycle_id=?`).bind(LIFECYCLE_ID).first<Row>();
  return row ? parseRow(row) : initial();
}

/** Read the explicit lifecycle state; a missing row is the inactive default. */
export async function readProjectAlphaApiV2MonitorLifecycle(database: D1Database): Promise<ProjectAlphaApiV2MonitorLifecycleSnapshot> {
  try { return await readProjectAlphaApiV2MonitorLifecycleSession(database.withSession("first-primary")); }
  catch (error) {
    if (error instanceof ProjectAlphaApiV2MonitorLifecycleError) throw error;
    throw new ProjectAlphaApiV2MonitorLifecycleError();
  }
}

/** Fail-closed exact active-pin check for a later fenced observation write. */
export async function getProjectAlphaApiV2ActiveMonitorIdentity(database: D1Database,
  expectedRevision: number, rawIdentity: unknown): Promise<ProjectAlphaApiV2MonitorLifecycleIdentity | null> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return null;
  let selected: ProjectAlphaApiV2MonitorLifecycleIdentity;
  try { selected = identity(rawIdentity); } catch { return null; }
  try {
    const state = await readProjectAlphaApiV2MonitorLifecycle(database);
    if (!state.enabled || state.revision !== expectedRevision) return null;
    return state.identities.find(value => identityKey(value) === identityKey(selected)) ?? null;
  } catch { return null; }
}

export async function isProjectAlphaApiV2MonitorIdentityActive(database: D1Database,
  expectedRevision: number, rawIdentity: unknown): Promise<boolean> {
  return (await getProjectAlphaApiV2ActiveMonitorIdentity(database, expectedRevision, rawIdentity)) !== null;
}

/** Low-level internal/test lifecycle transition with current-revision CAS.
 * It does not authenticate or audit an operator; routes must use the native
 * attributed control writer instead. */
export async function applyProjectAlphaApiV2MonitorLifecycle(database: D1Database,
  rawInput: unknown): Promise<ProjectAlphaApiV2MonitorLifecycleSnapshot> {
  const desired = snapshotProjectAlphaApiV2MonitorLifecycleDesired(rawInput);
  const identitiesJson = desired.identitiesJson;
  try {
    const session = database.withSession("first-primary");
    const current = await readProjectAlphaApiV2MonitorLifecycleSession(session);
    if (current.revision !== desired.expectedRevision) throw new ProjectAlphaApiV2MonitorLifecycleConflict();
    if (current.enabled === desired.enabled
      && JSON.stringify(current.identities) === identitiesJson) return current;
    const nextRevision = current.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) throw new ProjectAlphaApiV2MonitorLifecycleError();
    const statement = current.revision === 0
      ? session.prepare(`INSERT INTO project_alpha_api_v2_monitor_lifecycle_heads
          (lifecycle_id,revision,enabled,identities_json)
          SELECT ?,1,?,? WHERE NOT EXISTS
            (SELECT 1 FROM project_alpha_api_v2_monitor_lifecycle_heads WHERE lifecycle_id=?)
          RETURNING revision`).bind(LIFECYCLE_ID, desired.enabled ? 1 : 0, identitiesJson, LIFECYCLE_ID)
      : session.prepare(`UPDATE project_alpha_api_v2_monitor_lifecycle_heads
          SET revision=?,enabled=?,identities_json=?
          WHERE lifecycle_id=? AND revision=? RETURNING revision`)
        .bind(nextRevision, desired.enabled ? 1 : 0, identitiesJson, LIFECYCLE_ID, current.revision);
    const committed = await statement.first<{ revision: number }>();
    if (!committed || committed.revision !== nextRevision) throw new ProjectAlphaApiV2MonitorLifecycleConflict();
    return Object.freeze({ revision: nextRevision, enabled: desired.enabled, identities: desired.identities });
  } catch (error) {
    if (error instanceof ProjectAlphaApiV2MonitorLifecycleConflict) throw error;
    if (error instanceof ProjectAlphaApiV2MonitorLifecycleError) throw error;
    throw new ProjectAlphaApiV2MonitorLifecycleError();
  }
}
