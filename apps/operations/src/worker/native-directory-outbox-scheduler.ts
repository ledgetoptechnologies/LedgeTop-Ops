import { parseDuplicateFreeJson } from "./bounded-json";
import {
  resolveProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2ConnectionEnvironment,
} from "./project-alpha-api-v2-connections";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "./project-alpha-directory-profile-outbox-dispatcher";
import { dispatchProjectAlphaDirectoryRelationshipCommand } from "./project-alpha-directory-relationship-outbox-dispatcher";

const MAX_CONNECTION_BYTES = 256 * 1024;
const MAX_SOURCES = 64;
const MAX_COMMANDS = 12;
const MAX_RUNTIME_MS = 20_000;
const ROTATION_INTERVAL_MS = 5 * 60_000;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

type Environment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{
  OPS_DB: D1Database;
  NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED?: string;
}>;
type QueueKind = "profile" | "relationship";
type Candidate = Readonly<{
  queue_kind: QueueKind;
  command_id: string;
  source_id: string;
  position: number;
}>;
type Clock = () => number;

export type NativeDirectoryOutboxDrainResult = Readonly<{
  status: "disabled" | "unavailable" | "drained";
  attempted: number;
  acknowledged: number;
  conflicted: number;
  uncertain: number;
  blocked: number;
  failed: number;
  exhausted: boolean;
}>;

type Options = Readonly<{
  now?: Clock;
  rotationTime?: number;
  maxCommands?: number;
  maxRuntimeMs?: number;
  send?: typeof fetch;
}>;

function plain(value: unknown): value is Record<string, unknown> {
  try {
    return !!value && typeof value === "object" && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch { return false; }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : fallback;
}

function configuredSourceIds(raw: unknown): readonly string[] | null {
  if (typeof raw !== "string" || !raw.trim()
    || new TextEncoder().encode(raw).byteLength > MAX_CONNECTION_BYTES) return null;
  try {
    const envelope = parseDuplicateFreeJson(raw);
    if (!plain(envelope) || Object.keys(envelope).length !== 2 || envelope.version !== 1
      || !plain(envelope.instances)) return null;
    const entries = Object.entries(envelope.instances);
    if (entries.length === 0 || entries.length > MAX_SOURCES) return null;
    const environment = { PROJECT_ALPHA_API_V2_CONNECTIONS: raw };
    // One resolution validates the entire versioned envelope, including
    // disabled siblings, without exposing any credential-bearing object.
    resolveProjectAlphaApiV2Connection(environment, entries[0]![0]);
    const enabled: string[] = [];
    for (const [sourceId, value] of entries) {
      if (!SOURCE_ID.test(sourceId) || !plain(value)) return null;
      if (value.enabled !== true) continue;
      enabled.push(sourceId);
    }
    return enabled.sort();
  } catch { return null; }
}

async function eligibleCandidates(db: D1Database, sourceIds: readonly string[], now: number,
  maxCommands: number): Promise<readonly Candidate[]> {
  if (sourceIds.length === 0) return [];
  const placeholders = sourceIds.map(() => "?").join(",");
  const maximumCandidates = MAX_SOURCES * 2 * maxCommands;
  const query = `WITH eligible(queue_kind,command_id,source_id,eligible_at,created_at) AS (
      SELECT 'profile',command_id,source_id,
        CASE state WHEN 'leased' THEN lease_expires_at ELSE next_attempt_at END,created_at
      FROM project_alpha_directory_outbox
      WHERE (state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?)
      UNION ALL
      SELECT 'relationship',command_id,source_id,
        CASE state WHEN 'leased' THEN lease_expires_at ELSE next_attempt_at END,created_at
      FROM project_alpha_directory_relationship_outbox
      WHERE (state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?)
    ), ranked AS (
      SELECT queue_kind,command_id,source_id,
        row_number() OVER(PARTITION BY source_id,queue_kind ORDER BY eligible_at,created_at,command_id) position
      FROM eligible WHERE source_id IN (${placeholders})
    )
    SELECT queue_kind,command_id,source_id,position FROM ranked
    WHERE position<=? ORDER BY position,source_id,queue_kind LIMIT ?`;
  const session = db.withSession("first-primary");
  const rows = (await session.prepare(query)
    .bind(now, now, now, now, ...sourceIds, maxCommands, maximumCandidates)
    .all<Candidate>()).results;
  return rows.filter(row => (row.queue_kind === "profile" || row.queue_kind === "relationship")
    && typeof row.command_id === "string" && row.command_id.length > 0
    && sourceIds.includes(row.source_id) && Number.isSafeInteger(row.position)
    && row.position >= 1 && row.position <= maxCommands).slice(0, maximumCandidates);
}

function fairOrder(candidates: readonly Candidate[], sourceIds: readonly string[], rotationTime: number,
  maxCommands: number): readonly Candidate[] {
  if (candidates.length === 0 || sourceIds.length === 0) return [];
  const groups = new Map<string, Map<number, Candidate>>();
  for (const candidate of candidates) {
    const key = `${candidate.source_id}\u0000${candidate.queue_kind}`;
    const group = groups.get(key) ?? new Map<number, Candidate>();
    group.set(candidate.position, candidate);
    groups.set(key, group);
  }
  const tick = Math.max(0, Math.floor(rotationTime / ROTATION_INTERVAL_MS));
  const sourceStart = tick % sourceIds.length;
  const queues: readonly QueueKind[] = tick % 2 === 0
    ? ["profile", "relationship"] : ["relationship", "profile"];
  const ordered: Candidate[] = [];
  for (let position = 1; position <= maxCommands && ordered.length < maxCommands; position += 1) {
    for (let offset = 0; offset < sourceIds.length && ordered.length < maxCommands; offset += 1) {
      const sourceId = sourceIds[(sourceStart + offset) % sourceIds.length]!;
      for (const queue of queues) {
        const candidate = groups.get(`${sourceId}\u0000${queue}`)?.get(position);
        if (candidate) ordered.push(candidate);
        if (ordered.length >= maxCommands) break;
      }
    }
  }
  return ordered;
}

function deadlineFetch(send: typeof fetch, deadline: number, now: Clock): typeof fetch {
  return async (input, init) => {
    const remaining = Math.max(0, deadline - now());
    if (remaining === 0) throw new Error("native directory outbox drain deadline exceeded");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    try { return await send(input, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  };
}

const empty = (status: NativeDirectoryOutboxDrainResult["status"]): NativeDirectoryOutboxDrainResult => ({
  status, attempted: 0, acknowledged: 0, conflicted: 0, uncertain: 0, blocked: 0, failed: 0,
  exhausted: false,
});

/**
 * Selects and dispatches a bounded, rotating slice of already-durable commands.
 * Dispatchers retain ownership of claims, expired-lease recovery and retry state.
 */
export async function drainNativeDirectoryOutboxes(env: Environment,
  options: Options = {}): Promise<NativeDirectoryOutboxDrainResult> {
  if (env.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED !== "true") return empty("disabled");
  const startedAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) return empty("unavailable");
  // Pin the deployment-owned envelope before the first await. Dispatchers see
  // the same configuration that was used to choose eligible sources.
  const connections = env.PROJECT_ALPHA_API_V2_CONNECTIONS;
  const sourceIds = configuredSourceIds(connections);
  if (!sourceIds) return empty("unavailable");
  const maxCommands = boundedInteger(options.maxCommands, MAX_COMMANDS, MAX_COMMANDS);
  const maxRuntimeMs = boundedInteger(options.maxRuntimeMs, MAX_RUNTIME_MS, MAX_RUNTIME_MS);
  const deadline = startedAt + maxRuntimeMs;
  const now = options.now ?? Date.now;
  const rotationTime = Number.isSafeInteger(options.rotationTime) && options.rotationTime! >= 0
    ? options.rotationTime! : startedAt;
  const candidates = await eligibleCandidates(env.OPS_DB, sourceIds, startedAt, maxCommands);
  const selected = fairOrder(candidates, sourceIds, rotationTime, maxCommands);
  const send = deadlineFetch(options.send ?? fetch, deadline, now);
  const dispatchEnvironment = { OPS_DB: env.OPS_DB, PROJECT_ALPHA_API_V2_CONNECTIONS: connections };
  const result = { ...empty("drained") };
  for (const candidate of selected) {
    if (result.attempted >= maxCommands || now() >= deadline) break;
    result.attempted += 1;
    try {
      const outcome = candidate.queue_kind === "profile"
        ? await dispatchProjectAlphaDirectoryProfileOutboxCommand(dispatchEnvironment, candidate.source_id, candidate.command_id, send)
        : await dispatchProjectAlphaDirectoryRelationshipCommand(dispatchEnvironment, candidate.source_id, candidate.command_id, send);
      if (outcome.status === "acknowledged") result.acknowledged += 1;
      else if (outcome.status === "conflict") result.conflicted += 1;
      else if (outcome.status === "uncertain") result.uncertain += 1;
      else result.blocked += 1;
    } catch { result.failed += 1; }
  }
  result.exhausted = result.attempted >= maxCommands || selected.length > result.attempted || now() >= deadline;
  return result;
}
