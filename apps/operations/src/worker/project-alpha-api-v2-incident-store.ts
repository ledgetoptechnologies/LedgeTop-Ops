import type { ProjectAlphaApiV2Probe } from "./project-alpha-api-v2";
import {
  observeProjectAlphaApiV2Incident,
  parseProjectAlphaApiV2IncidentState,
  type ProjectAlphaApiV2IncidentIdentity,
  type ProjectAlphaApiV2IncidentObservation,
  type ProjectAlphaApiV2IncidentState,
} from "./project-alpha-api-v2-incident-policy";

const DENIED = "project_alpha_api_v2_incident_store_denied";
const CONFLICT = "project_alpha_api_v2_incident_store_conflict";

export class ProjectAlphaApiV2IncidentStoreConflict extends Error {
  constructor() { super(CONFLICT); this.name = "ProjectAlphaApiV2IncidentStoreConflict"; }
}

export type ProjectAlphaApiV2IncidentSnapshot = Readonly<{
  revision: number;
  state: ProjectAlphaApiV2IncidentState | null;
}>;

function data(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw Error();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(raw);
    const allowed = new Set([...required, ...optional]);
    if (keys.length < required.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) throw Error();
    for (const key of required) if (!descriptors[key]?.enumerable || !("value" in descriptors[key])) throw Error();
    for (const key of optional) if (key in descriptors
      && (!descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw Error();
    return Object.fromEntries(keys.map(key => [key, descriptors[key as string]!.value]));
  } catch { throw Error(DENIED); }
}

function identity(raw: unknown): ProjectAlphaApiV2IncidentIdentity {
  const value = data(raw, ["sourceId", "applicationId", "baseUrl", "expectedSourceInstanceId", "expectedHistoryEpoch"]);
  if (Object.values(value).some(item => typeof item !== "string")) throw Error(DENIED);
  const initial = observeProjectAlphaApiV2Incident(null, value as ProjectAlphaApiV2IncidentIdentity,
    { kind: "disabled", startedAt: 0 });
  return initial.identity;
}

function observation(raw: unknown): ProjectAlphaApiV2IncidentObservation {
  const outer = data(raw, ["kind", "startedAt"], ["probe"]);
  if (typeof outer.startedAt !== "number" || !Number.isSafeInteger(outer.startedAt)
    || outer.startedAt < 0) throw Error(DENIED);
  if (outer.kind === "disabled" && !("probe" in outer))
    return Object.freeze({ kind: "disabled", startedAt: outer.startedAt });
  if (outer.kind !== "probe" || !("probe" in outer)) throw Error(DENIED);
  const rawProbe = data(outer.probe, ["status"], ["reason", "httpStatus", "requestId", "sourceInstanceId",
    "applicationId", "historyEpoch", "grantedCapabilities"]);
  if (rawProbe.status === "verified") {
    const { sourceInstanceId, applicationId, historyEpoch, requestId, grantedCapabilities } = rawProbe;
    if ("reason" in rawProbe || "httpStatus" in rawProbe || typeof sourceInstanceId !== "string"
      || typeof applicationId !== "string" || typeof historyEpoch !== "string"
      || typeof requestId !== "string" || !Array.isArray(grantedCapabilities)
      || grantedCapabilities.length > 128 || !grantedCapabilities.every(value => typeof value === "string")) throw Error(DENIED);
    const probe: ProjectAlphaApiV2Probe = { status: "verified", sourceInstanceId, applicationId,
      historyEpoch, requestId, grantedCapabilities: [...grantedCapabilities] };
    return Object.freeze({ kind: "probe", startedAt: outer.startedAt, probe });
  }
  if (typeof rawProbe.status !== "string"
    || !["misconfigured", "unavailable", "unauthorized", "incompatible", "rate_limited"].includes(rawProbe.status)
    || typeof rawProbe.reason !== "string" || ["sourceInstanceId", "applicationId", "historyEpoch", "grantedCapabilities"]
      .some(key => key in rawProbe)
    || ("httpStatus" in rawProbe && (typeof rawProbe.httpStatus !== "number"
      || !Number.isInteger(rawProbe.httpStatus) || rawProbe.httpStatus < 100 || rawProbe.httpStatus > 599))
    || ("requestId" in rawProbe && typeof rawProbe.requestId !== "string")) throw Error(DENIED);
  const probe = { status: rawProbe.status, reason: rawProbe.reason } as ProjectAlphaApiV2Probe;
  return Object.freeze({ kind: "probe", startedAt: outer.startedAt, probe });
}

type Row = { revision: number; last_probe_started_at: number; state_json: string };
const WHERE = `source_id=? AND application_id=? AND base_url=?
  AND expected_source_instance_id=? AND expected_history_epoch=?`;
// This predicate is deliberately repeated inside the conditional write. A
// preflight lifecycle read alone would allow an in-flight probe to commit after
// an explicit monitor disable or pin replacement.
const ACTIVE_LIFECYCLE = `EXISTS (SELECT 1
  FROM project_alpha_api_v2_monitor_lifecycle_heads lifecycle, json_each(lifecycle.identities_json) pin
  WHERE lifecycle.lifecycle_id=1 AND lifecycle.revision=? AND lifecycle.enabled=1
    AND json_type(pin.value)='object' AND (SELECT count(*) FROM json_each(pin.value))=5
    AND json_type(pin.value,'$.sourceId')='text'
    AND json_type(pin.value,'$.applicationId')='text'
    AND json_type(pin.value,'$.baseUrl')='text'
    AND json_type(pin.value,'$.expectedSourceInstanceId')='text'
    AND json_type(pin.value,'$.expectedHistoryEpoch')='text'
    AND json_extract(pin.value,'$.sourceId')=?
    AND json_extract(pin.value,'$.applicationId')=?
    AND json_extract(pin.value,'$.baseUrl')=?
    AND json_extract(pin.value,'$.expectedSourceInstanceId')=?
    AND json_extract(pin.value,'$.expectedHistoryEpoch')=?)`;
const RETIRED_LIFECYCLE = `EXISTS (SELECT 1
  FROM project_alpha_api_v2_monitor_lifecycle_heads lifecycle
  WHERE lifecycle.lifecycle_id=1 AND lifecycle.revision=?
    AND (lifecycle.enabled=1 OR json_array_length(lifecycle.identities_json)=0)
    AND NOT EXISTS (SELECT 1 FROM json_each(lifecycle.identities_json) pin
      WHERE json_type(pin.value)='object' AND (SELECT count(*) FROM json_each(pin.value))=5
        AND json_extract(pin.value,'$.sourceId')=?
        AND json_extract(pin.value,'$.applicationId')=?
        AND json_extract(pin.value,'$.baseUrl')=?
        AND json_extract(pin.value,'$.expectedSourceInstanceId')=?
        AND json_extract(pin.value,'$.expectedHistoryEpoch')=?))`;
function binds(value: ProjectAlphaApiV2IncidentIdentity): [string, string, string, string, string] {
  return [value.sourceId, value.applicationId, value.baseUrl,
    value.expectedSourceInstanceId, value.expectedHistoryEpoch];
}

async function read(session: D1DatabaseSession,
  selected: ProjectAlphaApiV2IncidentIdentity): Promise<ProjectAlphaApiV2IncidentSnapshot> {
  const row = await session.prepare(`SELECT revision,last_probe_started_at,state_json
    FROM project_alpha_api_v2_incident_heads WHERE ${WHERE}`).bind(...binds(selected)).first<Row>();
  if (!row) return Object.freeze({ revision: 0, state: null });
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.state_json !== "string") throw Error(DENIED);
  const state = parseProjectAlphaApiV2IncidentState(JSON.parse(row.state_json) as unknown);
  if (state.lastProbeStartedAt !== row.last_probe_started_at
    || binds(state.identity).some((part, index) => part !== binds(selected)[index])) throw Error(DENIED);
  return Object.freeze({ revision: row.revision, state });
}

/** First-primary, complete pinned identity only; no source-name fallback. */
export async function readProjectAlphaApiV2Incident(database: D1Database,
  rawIdentity: ProjectAlphaApiV2IncidentIdentity): Promise<ProjectAlphaApiV2IncidentSnapshot> {
  try { return await read(database.withSession("first-primary"), identity(rawIdentity)); }
  catch { throw Error(DENIED); }
}

export type ProjectAlphaApiV2IncidentRecordResult = Readonly<{
  status: "recorded" | "stale";
  revision: number;
  state: ProjectAlphaApiV2IncidentState;
}>;

/** One observation, one revision. The head's SQL trigger appends immutable history atomically. */
export async function recordProjectAlphaApiV2IncidentObservation(database: D1Database, rawInput: unknown,
): Promise<ProjectAlphaApiV2IncidentRecordResult> {
  let selected: ProjectAlphaApiV2IncidentIdentity, event: ProjectAlphaApiV2IncidentObservation, expectedRevision: number;
  let monitorRevision: number | null = null;
  try {
    const input = data(rawInput, ["identity", "expectedRevision", "observation", "monitorRevision"]);
    selected = identity(input.identity);
    event = observation(input.observation);
    if (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0) throw Error(DENIED);
    expectedRevision = input.expectedRevision;
    if (typeof input.monitorRevision !== "number" || !Number.isSafeInteger(input.monitorRevision)
      || input.monitorRevision < 1) throw Error(DENIED);
    monitorRevision = input.monitorRevision;
  } catch { throw Error(DENIED); }
  try {
    const session = database.withSession("first-primary");
    const current = await read(session, selected);
    if (current.revision !== expectedRevision) throw new ProjectAlphaApiV2IncidentStoreConflict();
    const next = parseProjectAlphaApiV2IncidentState(
      observeProjectAlphaApiV2Incident(current.state, selected, event));
    if (next === current.state || next.lastProbeStartedAt === current.state?.lastProbeStartedAt)
      return Object.freeze({ status: "stale", revision: current.revision, state: next });
    const stateJson = JSON.stringify(next);
    if (new TextEncoder().encode(stateJson).byteLength > 8192) throw Error(DENIED);
    const update = current.revision === 0
      ? session.prepare(`INSERT INTO project_alpha_api_v2_incident_heads
          (source_id,application_id,base_url,expected_source_instance_id,expected_history_epoch,
            revision,last_probe_started_at,state_json)
          SELECT ?,?,?,?,?,1,?,? WHERE NOT EXISTS
            (SELECT 1 FROM project_alpha_api_v2_incident_heads WHERE ${WHERE})
            AND ${event.kind === "probe" ? ACTIVE_LIFECYCLE : RETIRED_LIFECYCLE} RETURNING revision`)
        .bind(...binds(selected), next.lastProbeStartedAt, stateJson, ...binds(selected),
          monitorRevision!, ...binds(selected))
      : session.prepare(`UPDATE project_alpha_api_v2_incident_heads
          SET revision=?,last_probe_started_at=?,state_json=? WHERE ${WHERE} AND revision=?
            AND last_probe_started_at<? AND ${event.kind === "probe" ? ACTIVE_LIFECYCLE : RETIRED_LIFECYCLE} RETURNING revision`)
        .bind(current.revision + 1, next.lastProbeStartedAt, stateJson,
          ...binds(selected), current.revision, next.lastProbeStartedAt,
          monitorRevision!, ...binds(selected));
    let committed: { revision: number } | null;
    try { committed = await update.first<{ revision: number }>(); }
    catch {
      const concurrent = await read(session, selected);
      if (concurrent.revision !== current.revision) throw new ProjectAlphaApiV2IncidentStoreConflict();
      throw Error(DENIED);
    }
    if (committed === null) throw new ProjectAlphaApiV2IncidentStoreConflict();
    if (committed.revision !== current.revision + 1) throw Error(DENIED);
    // RETURNING proves this exact conditional write committed, including its
    // same-statement history trigger. A later writer may already have advanced
    // the head, so a post-write reread would be a false failure.
    return Object.freeze({ status: "recorded", revision: committed.revision, state: next });
  } catch (error) {
    if (error instanceof ProjectAlphaApiV2IncidentStoreConflict) throw error;
    throw Error(DENIED);
  }
}
