import { prepareApprovedOnboardingCreateGenerationRecovery,hasApprovedOnboardingCreateRecovery } from "./project-alpha-directory-create-generation-recovery";
import {recoverDirectoryProfileGeneration,profileGenerationRecoverySchema} from './project-alpha-directory-profile-generation-recovery';
import { enqueueNativeDirectoryCreateObservations, dispatchNativeDirectoryCreateObservation } from './native-directory-create-observations';
import { parseDuplicateFreeJson } from "./bounded-json";
import {
  resolveProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2ConnectionEnvironment,
} from "./project-alpha-api-v2-connections";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "./project-alpha-directory-profile-outbox-dispatcher";
import { dispatchProjectAlphaDirectoryRelationshipCommand } from "./project-alpha-directory-relationship-outbox-dispatcher";
import { materializeResolvedProjectAlphaDirectoryClientIntents } from "./project-alpha-directory-client-intent-materializer";
import { dispatchNativeDirectoryProfileBindingContinuation, profileBindingContinuationEnabled } from './native-directory-profile-binding-continuation';
import { dispatchProjectAlphaDirectoryLifecycleCommand } from "./project-alpha-directory-lifecycle-outbox-dispatcher";
import type { SharedProfilePortalAuthorityBinding } from "../../../../packages/shared/src/shared-business-profile";

const MAX_CONNECTION_BYTES = 256 * 1024;
const MAX_SOURCES = 64;
const MAX_COMMANDS = 12;
// Soft admission/transport budget: stop starting commands at this deadline.
// An already-started dispatch finishes its bounded fresh authority rechecks;
// this does not cancel an RPC or extend its proof lifetime/five-minute lease.
const MAX_RUNTIME_MS = 180_000;
const ROTATION_INTERVAL_MS = 5 * 60_000;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

type Environment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{
  OPS_DB: D1Database;
  DELIVERY_DB?: D1Database;
  NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED?: string;
  CLIENT_ONBOARDING_ADMIN_ENABLED?: string;
  PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED?: string;
  PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED?: string;
  ENVIRONMENT?: string;
  NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED?: string;
  NATIVE_DIRECTORY_LIFECYCLE_ENABLED?: string;
  SHARED_PROFILE_PORTAL_AUTHORITY?: SharedProfilePortalAuthorityBinding;
}>;
type QueueKind = "profile_generation_recovery" | "onboarding_create_recovery" | "profile" | "relationship" | "binding_continuation" | "lifecycle" | "create_observation";
type Candidate = Readonly<{
  queue_kind: QueueKind;
  command_kind: "normal" | "generation_recovery";
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
  maxCommands: number, relationshipRecoveryEnabled: boolean, bindingContinuationEnabled: boolean,
  lifecycleEnabled: boolean, onboardingRecoveryEnabled: boolean,profileRecoveryEnabled=false): Promise<readonly Candidate[]> {
  if (sourceIds.length === 0) return [];
  const placeholders = sourceIds.map(() => "?").join(",");
  const maximumCandidates = MAX_SOURCES * 8 * maxCommands;
  const bindingArm = bindingContinuationEnabled ? `
      UNION ALL
      SELECT 'binding_continuation','normal',j.command_id,j.source_id,
        CASE d.state WHEN 'leased' THEN d.lease_expires_at ELSE d.next_attempt_at END,j.created_at
      FROM native_directory_profile_binding_jobs j JOIN native_directory_profile_binding_dispatch d ON d.command_id=j.command_id
      WHERE (d.state IN('pending','uncertain') AND d.next_attempt_at<=?) OR (d.state='leased' AND d.lease_expires_at<=?)` : '';
  const recoveryArm = relationshipRecoveryEnabled ? `
      UNION ALL
      SELECT 'relationship','generation_recovery',command_id,source_id,
        CASE state WHEN 'leased' THEN lease_expires_at ELSE next_attempt_at END,created_at
      FROM project_alpha_directory_relationship_recovery_outbox
      WHERE (state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?)` : "";
  const lifecycleArm = lifecycleEnabled ? `
      UNION ALL
      SELECT 'lifecycle','normal',command_id,source_id,
        CASE state WHEN 'leased' THEN lease_expires_at ELSE next_attempt_at END,created_at
      FROM project_alpha_directory_lifecycle_outbox lifecycle
      WHERE ((state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?))
        AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_lifecycle_outbox sibling
          WHERE sibling.mutation_id=lifecycle.mutation_id AND sibling.state='terminal')` : "";
  const onboardingRecoveryArm=onboardingRecoveryEnabled?`
      UNION ALL SELECT 'onboarding_create_recovery','normal',outbox.command_id,outbox.source_id,0,outbox.created_at
      FROM operations_directory_effective_materializations materialization
      JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
      JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
      WHERE outbox.state='terminal' AND json_extract(outbox.outcome_json,'$.httpStatus')=409
       AND json_extract(outbox.command_json,'$.operation')='create'
       AND EXISTS(SELECT 1 FROM client_onboarding_decisions decision WHERE decision.outcome='approved'
        AND (decision.client_record_id=intent.record_id OR decision.organization_record_id=intent.record_id
         OR EXISTS(SELECT 1 FROM client_onboarding_shared_company_child_receipts child
          WHERE child.decision_id=decision.decision_id AND child.client_record_id=intent.record_id)))`:"";
  const profileRecoveryArm=profileRecoveryEnabled?` UNION ALL
   SELECT 'profile_generation_recovery','normal',outbox.command_id,outbox.source_id,coalesce(checks.checked_at,0),outbox.created_at
   FROM operations_directory_effective_materializations m JOIN project_alpha_directory_outbox outbox ON outbox.command_id=m.command_id
   JOIN operations_directory_intents intent ON intent.intent_id=m.intent_id JOIN operations_directory_records record ON record.record_id=intent.record_id
   LEFT JOIN project_alpha_directory_profile_recovery_checks checks ON checks.command_id=outbox.command_id
   WHERE outbox.state='terminal' AND json_extract(outbox.outcome_json,'$.httpStatus')=409 AND json_extract(outbox.command_json,'$.operation')='update'
    AND intent.state='materialized' AND record.current_version=intent.record_version AND coalesce(checks.state,'pending')='pending' AND coalesce(checks.next_attempt_at,0)<=?`:'';
  const query = `WITH eligible(queue_kind,command_kind,command_id,source_id,eligible_at,created_at) AS (
      SELECT 'profile','normal',command_id,source_id,
        CASE state WHEN 'leased' THEN lease_expires_at ELSE next_attempt_at END,created_at
      FROM project_alpha_directory_outbox
      WHERE (state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?)
      UNION ALL
      SELECT 'relationship','normal',command_id,source_id,
        CASE state WHEN 'leased' THEN lease_expires_at ELSE next_attempt_at END,created_at
      FROM project_alpha_directory_relationship_outbox
      WHERE (state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?)${recoveryArm}${bindingArm}${lifecycleArm}
      UNION ALL SELECT 'create_observation','normal',j.command_id,j.source_id,
        CASE d.state WHEN 'leased' THEN d.lease_expires_at ELSE d.next_attempt_at END,j.created_at
      FROM native_directory_create_observation_jobs j JOIN native_directory_create_observation_dispatch d ON d.command_id=j.command_id
      WHERE (d.state IN('pending','uncertain') AND d.next_attempt_at<=?) OR (d.state='leased' AND d.lease_expires_at<=?)${onboardingRecoveryArm}${profileRecoveryArm}
    ), ranked AS (
      SELECT queue_kind,command_kind,command_id,source_id,
        row_number() OVER(PARTITION BY source_id,queue_kind,command_kind ORDER BY eligible_at,created_at,command_id) position
      FROM eligible WHERE source_id IN (${placeholders})
    )
    SELECT queue_kind,command_kind,command_id,source_id,position FROM ranked
    WHERE position<=? ORDER BY position,source_id,queue_kind LIMIT ?`;
  const session = db.withSession("first-primary");
  const timing = Array(6 + (relationshipRecoveryEnabled ? 2 : 0) + (bindingContinuationEnabled ? 2 : 0)
    + (lifecycleEnabled ? 2 : 0)).fill(now);
  const rows = (await session.prepare(query)
    .bind(...timing,...(profileRecoveryEnabled?[now]:[]), ...sourceIds, maxCommands, maximumCandidates)
    .all<Candidate>()).results;
  return rows.filter(row => (row.queue_kind === "profile_generation_recovery" || row.queue_kind === "onboarding_create_recovery" || row.queue_kind === "profile" || row.queue_kind === "relationship"
      || row.queue_kind === 'binding_continuation' || row.queue_kind === "lifecycle" || row.queue_kind === "create_observation")
    && (row.command_kind === "normal" || row.command_kind === "generation_recovery")
    && (row.queue_kind === "relationship" || row.command_kind === "normal")
    && typeof row.command_id === "string" && row.command_id.length > 0
    && sourceIds.includes(row.source_id) && Number.isSafeInteger(row.position)
    && row.position >= 1 && row.position <= maxCommands).slice(0, maximumCandidates);
}

function fairOrder(candidates: readonly Candidate[], sourceIds: readonly string[], rotationTime: number,
  maxCommands: number): readonly Candidate[] {
  if (candidates.length === 0 || sourceIds.length === 0) return [];
  const groups = new Map<string, Map<number, Candidate>>();
  for (const candidate of candidates) {
    const key = `${candidate.source_id}\u0000${candidate.queue_kind}\u0000${candidate.command_kind}`;
    const group = groups.get(key) ?? new Map<number, Candidate>();
    group.set(candidate.position, candidate);
    groups.set(key, group);
  }
  const tick = Math.max(0, Math.floor(rotationTime / ROTATION_INTERVAL_MS));
  const sourceStart = tick % sourceIds.length;
  const queues: readonly Readonly<{ queue: QueueKind; command: Candidate["command_kind"] }>[] = tick % 2 === 0
    ? [{ queue: "profile", command: "normal" }, {queue:'profile_generation_recovery',command:'normal'}, {queue:"onboarding_create_recovery",command:"normal"}, { queue: "relationship", command: "normal" },
      { queue: "relationship", command: "generation_recovery" }, { queue:'binding_continuation',command:'normal' },
      { queue: "lifecycle", command: "normal" }, {queue:"create_observation",command:"normal"}]
    : [{queue:"create_observation",command:"normal"}, { queue: "lifecycle", command: "normal" }, { queue:'binding_continuation',command:'normal' }, { queue: "relationship", command: "normal" }, { queue: "relationship", command: "generation_recovery" },
      { queue: "profile", command: "normal" },{queue:"onboarding_create_recovery",command:"normal"},{queue:'profile_generation_recovery',command:'normal'}];
  const ordered: Candidate[] = [];
  for (let position = 1; position <= maxCommands && ordered.length < maxCommands; position += 1) {
    for (let offset = 0; offset < sourceIds.length && ordered.length < maxCommands; offset += 1) {
      const sourceId = sourceIds[(sourceStart + offset) % sourceIds.length]!;
      for (const lane of queues) {
        const candidate = groups.get(`${sourceId}\u0000${lane.queue}\u0000${lane.command}`)?.get(position);
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
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    let response: Response;
    try { response = await send(input, { ...init, signal }); }
    catch (error) { clearTimeout(timeout); throw error; }
    if (!response.body) { clearTimeout(timeout); return response; }
    const reader = response.body.getReader();
    let finished = false;
    const finish = () => { if (!finished) { finished = true; clearTimeout(timeout); } };
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const part = await reader.read();
          if (part.done) { finish(); reader.releaseLock(); stream.close(); }
          else stream.enqueue(part.value);
        } catch (error) { finish(); reader.releaseLock(); stream.error(error); }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); }
        finally { finish(); reader.releaseLock(); }
      },
    });
    const wrapped = new Response(body, response);
    Object.defineProperties(wrapped, {
      redirected: { value: response.redirected },
      type: { value: response.type },
      url: { value: response.url },
    });
    return wrapped;
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
  const createGenerationRecovery = env.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED;
  const relationshipGenerationRecovery = env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED;
  const portalAuthority = env.SHARED_PROFILE_PORTAL_AUTHORITY;
  const continuationPolicy = { ENVIRONMENT:env.ENVIRONMENT,
    NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED:env.NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED };
  const lifecycleEnabled = env.ENVIRONMENT === "staging" && env.NATIVE_DIRECTORY_LIFECYCLE_ENABLED === "true";
  const sourceIds = configuredSourceIds(connections);
  if (!sourceIds) return empty("unavailable");
  const maxCommands = boundedInteger(options.maxCommands, MAX_COMMANDS, MAX_COMMANDS);
  const maxRuntimeMs = boundedInteger(options.maxRuntimeMs, MAX_RUNTIME_MS, MAX_RUNTIME_MS);
  const deadline = startedAt + maxRuntimeMs;
  const now = options.now ?? Date.now;
  const rotationTime = Number.isSafeInteger(options.rotationTime) && options.rotationTime! >= 0
    ? options.rotationTime! : startedAt;
  // A linked client create is intentionally not an outbox candidate until its
  // pinned parent intent is acknowledged. Materialization is local, bounded,
  // and guarded transactionally by the existing 0132 relationship triggers.
  await materializeResolvedProjectAlphaDirectoryClientIntents(env.OPS_DB, sourceIds, maxCommands, startedAt);
  await enqueueNativeDirectoryCreateObservations(env.OPS_DB,sourceIds,maxCommands);
  const candidates = await eligibleCandidates(env.OPS_DB, sourceIds, startedAt, maxCommands,
    relationshipGenerationRecovery === "true", profileBindingContinuationEnabled(continuationPolicy), lifecycleEnabled,
    env.CLIENT_ONBOARDING_ADMIN_ENABLED==="true"&&createGenerationRecovery==="true",await profileGenerationRecoverySchema(env.OPS_DB));
  const selected = fairOrder(candidates, sourceIds, rotationTime, maxCommands);
  const send = deadlineFetch(options.send ?? fetch, deadline, now);
  const dispatchEnvironment = { OPS_DB: env.OPS_DB, DELIVERY_DB: env.DELIVERY_DB, PROJECT_ALPHA_API_V2_CONNECTIONS: connections,
    SHARED_PROFILE_PORTAL_AUTHORITY: portalAuthority,CLIENT_ONBOARDING_ADMIN_ENABLED:env.CLIENT_ONBOARDING_ADMIN_ENABLED,
    NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:env.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED,
    PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: createGenerationRecovery,
    PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: relationshipGenerationRecovery, ...continuationPolicy,
    ...(lifecycleEnabled ? { PROJECT_ALPHA_DIRECTORY_LIFECYCLE_ENABLED: "true" } : {}) };
  const result = { ...empty("drained") };
  for (const candidate of selected) {
    if (result.attempted >= maxCommands || now() >= deadline) break;
    result.attempted += 1;
    try {
      // Recover and send one approved create before observing a generation for
      // the next one. Successor bytes remain immutable; PA still CAS-checks the
      // fresh generation. Network ambiguity never creates another successor.
      const outcome = candidate.queue_kind==='profile_generation_recovery'
        ?await recoverProfile(dispatchEnvironment,candidate,send)
        :candidate.queue_kind === "onboarding_create_recovery"
        ? await recoverOnboardingCreate(dispatchEnvironment,candidate,send)
        : candidate.queue_kind === "create_observation"
        ? await dispatchNativeDirectoryCreateObservation(dispatchEnvironment,candidate.source_id,candidate.command_id,send)
        : candidate.queue_kind === "lifecycle"
        ? await dispatchProjectAlphaDirectoryLifecycleCommand(dispatchEnvironment, candidate.source_id,
          candidate.command_id, send)
        : candidate.queue_kind === 'binding_continuation'
        ? await dispatchNativeDirectoryProfileBindingContinuation(dispatchEnvironment,candidate.source_id,candidate.command_id,send)
        : candidate.queue_kind === "profile"
        ? await dispatchProjectAlphaDirectoryProfileOutboxCommand(dispatchEnvironment, candidate.source_id, candidate.command_id, send)
        : await dispatchProjectAlphaDirectoryRelationshipCommand(dispatchEnvironment, candidate.source_id, candidate.command_id, send,
          candidate.command_kind);
      account(outcome,result);
      if(candidate.queue_kind==="profile"&&outcome.status==="conflict"
       &&"createGenerationConflict" in outcome&&outcome.createGenerationConflict===true
       &&env.CLIENT_ONBOARDING_ADMIN_ENABLED==="true"&&createGenerationRecovery==="true"
       &&result.attempted<maxCommands&&now()<deadline
       &&await hasApprovedOnboardingCreateRecovery(dispatchEnvironment,candidate.command_id)){
        result.attempted+=1;
        account(await recoverOnboardingCreate(dispatchEnvironment,candidate,send),result);
      }
    } catch { result.failed += 1; }
  }
  result.exhausted = result.attempted >= maxCommands || selected.length > result.attempted || now() >= deadline;
  return result;
}

async function recoverProfile(env:Environment,candidate:Candidate,send:typeof fetch){
 const result=await recoverDirectoryProfileGeneration(env,candidate.source_id,candidate.command_id,send);
 const now=Date.now();
 const reason='reason'in result?result.reason:result.status;
 const state=['depth','remote_changed','association_changed','identity','onboarding_native_not_noop','onboarding_remote_not_noop'].includes(reason)?'review_required':'pending';
 await env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_profile_recovery_checks(command_id,source_id,next_attempt_at,checked_at,reason,state)
 VALUES(?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,checked_at=excluded.checked_at,reason=excluded.reason,state=excluded.state`)
 .bind(candidate.command_id,candidate.source_id,now+5*60_000,now,reason,state).run();
 return result;
}
async function recoveryUuid(seed:string){
 const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(seed))).slice(0,16);
 bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
 const v=[...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");
 return `${v.slice(0,8)}-${v.slice(8,12)}-${v.slice(12,16)}-${v.slice(16,20)}-${v.slice(20)}`;
}
async function recoverOnboardingCreate(env:Environment,candidate:Candidate,send:typeof fetch){
 const successorCommandId=await recoveryUuid(`onboarding-create-successor:${candidate.command_id}`);
 const prepared=await prepareApprovedOnboardingCreateGenerationRecovery(env,{
  authorizationId:await recoveryUuid(`onboarding-create-recovery:${candidate.command_id}`),
  predecessorCommandId:candidate.command_id,successorCommandId,sourceId:candidate.source_id,
  reason:"Automatic completion of the exact current approved onboarding create"},send);
 if(prepared.status!=="prepared")return prepared;
 return dispatchProjectAlphaDirectoryProfileOutboxCommand(env,candidate.source_id,successorCommandId,send);
}

function account(outcome:{status:string},result:{acknowledged:number;conflicted:number;uncertain:number;blocked:number}){
 if(outcome.status==="acknowledged")result.acknowledged++;
 else if(outcome.status==="conflict")result.conflicted++;
 else if(outcome.status==="uncertain")result.uncertain++;
 else result.blocked++;
}
