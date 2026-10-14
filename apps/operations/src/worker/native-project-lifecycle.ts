import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";
import {
  resolveProjectAlphaApiV2Connection,
  withEnabledConfiguredProjectAlphaApiV2Connection,
} from "./project-alpha-api-v2-connections";
import {
  readProjectAlphaProject,
  validatedProjectAlphaProjectRead,
} from "./project-alpha-project-read-api-v2";
import { readProjectAlphaProjectBindingStatus } from "./project-alpha-project-binding-status-api-v2";
import {
  sendProjectAlphaProjectLifecycleCommand,
  validatedProjectLifecycleReceipt,
} from "./project-alpha-project-lifecycle-api-v2";
import {
  canonicalProjectAlphaProjectRequest,
  sendProjectAlphaProjectRefreshCommand,
  validatedProjectAlphaProjectAcknowledgement,
  type ProjectAlphaProjectRefreshCommand,
} from "./project-alpha-project-api-v2";
import { externalId, uuid } from "./project-alpha-project-transport";
export type LifecycleActor = Readonly<{
  staffId: string;
  accessSubject: string;
  email: string;
  admissionVersion: number;
  profileVersion: number;
  verifiedUntil: string;
}>;
export type LifecycleContext = Readonly<{
  sourceId: string;
  rootKind: "organization" | "standalone_client";
  rootPublicId: string;
  contextVersion: string;
}>;
type Row = {
  command_id: string;
  external_project_id: string;
  action: "archive" | "restore";
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  destination_origin: string;
  project_alpha_public_id: string;
  context_json: string;
  context_sha256: string;
  body: string;
  request_sha256: string;
  expected_local_version: number;
  expected_projection_sha256: string;
  expected_pa_revision: string;
  prior_head_json: string;
  state: string;
  transmission_count: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  expires_at: string;
};
type Head = {
  external_project_id: string;
  current_version: number;
  canonical_projection_sha256: string;
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  project_alpha_public_id: string;
  pa_revision: string;
  archived: number;
  scopes_json: string;
  organization_record_id: string | null;
  client_record_id: string | null;
  [key: string]: unknown;
};
type Child = {
  command_id: string;
  parent_command_id: string;
  body: string;
  request_sha256: string;
  expected_revision: string;
  expected_projection_sha256: string;
  state: string;
  lease_token: string | null;
  lease_expires_at: number | null;
  expires_at: string;
};
function refused(message: string, code: 403 | 409 = 409): never {
  throw new HTTPException(code, { message });
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export async function lifecycleHash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
const assertChanged = (db: D1Database) =>
  db.prepare(
    "SELECT CASE WHEN changes()=1 THEN 1 ELSE json('native-lifecycle-cas-failed') END verified",
  );
function connection(env: Env, context: LifecycleContext, row?: Row) {
  const selected = resolveProjectAlphaApiV2Connection(env, context.sourceId);
  const c = selected.connection;
  if (!selected.enabled || !c.expectedHistoryEpoch)
    refused("Native lifecycle source is unavailable");
  if (
    row &&
    (row.source_id !== context.sourceId ||
      row.source_instance_id !== c.expectedSourceInstanceId ||
      row.application_id !== c.expectedApplicationId ||
      row.history_epoch_id !== c.expectedHistoryEpoch ||
      row.destination_origin !== new URL(c.baseUrl).origin)
  )
    refused("Native lifecycle destination changed");
  return c;
}
async function transport<T>(
  env: Env,
  context: LifecycleContext,
  run: (c: ProjectAlphaApiV2Connection) => Promise<T>,
): Promise<T> {
  const result = await withEnabledConfiguredProjectAlphaApiV2Connection(
    env,
    context.sourceId,
    run,
  );
  if (result.status !== "enabled")
    refused("Native lifecycle connection is unavailable");
  return result.value;
}
async function head(db: D1Database, id: string) {
  const h = await db
    .prepare(
      "SELECT * FROM operations_shared_projects WHERE external_project_id=?",
    )
    .bind(id)
    .first<Head>();
  if (!h) refused("Exact native project is required");
  return h;
}
async function command(db: D1Database, id: string) {
  const row = await db
    .prepare(
      "SELECT * FROM native_project_lifecycle_commands WHERE command_id=?",
    )
    .bind(id)
    .first<Row>();
  if (!row) refused("Native lifecycle command is unavailable");
  return row;
}
async function owned(db: D1Database, context: LifecycleContext, h: Head) {
  const kind = context.rootKind === "organization" ? "organization" : "client";
  const record =
    context.rootKind === "organization"
      ? h.organization_record_id
      : h.client_record_id;
  if (
    context.rootKind === "standalone_client" &&
    (h.organization_record_id !== null ||
      !(await db
        .prepare(
          "SELECT 1 ok FROM operations_directory_client_organizations WHERE client_record_id=? AND organization_record_id IS NULL",
        )
        .bind(h.client_record_id)
        .first()))
  )
    refused("Native project client is no longer standalone", 403);
  if (
    h.source_id !== context.sourceId ||
    !record ||
    !(await db
      .prepare(
        `SELECT 1 verified FROM project_alpha_active_directory_mappings m WHERE m.source_id=? AND m.source_instance_id=? AND m.application_id=? AND m.history_epoch_id=? AND m.resource_type=? AND m.record_id=? AND m.record_id=?`,
      )
      .bind(
        h.source_id,
        h.source_instance_id,
        h.application_id,
        h.history_epoch_id,
        kind,
        record,
        context.rootPublicId,
      )
      .first())
  )
    refused(
      "Native lifecycle project is outside this exact owner context",
      403,
    );
}
function proof(db: D1Database, id: string, h: Head, actor: LifecycleActor) {
  return db
    .prepare(
      `INSERT INTO native_project_command_proofs(command_id,external_project_id,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,grant_generation,scopes_json)
   SELECT ?,?,?,?,?,?,?,?,generation,? FROM native_project_grant_generations WHERE staff_id=?`,
    )
    .bind(
      id,
      h.external_project_id,
      actor.staffId,
      actor.accessSubject,
      actor.admissionVersion,
      actor.profileVersion,
      actor.email,
      actor.verifiedUntil,
      h.scopes_json,
      actor.staffId,
    );
}
async function requireAuthority(env: Env, actor: LifecycleActor, h: Head) {
  if (
    !Number.isFinite(Date.parse(actor.verifiedUntil)) ||
    new Date(actor.verifiedUntil).toISOString() !== actor.verifiedUntil
  )
    refused("Current native authentication expiry is required", 403);
  const allowed = await env.OPS_DB.prepare(
    `SELECT 1 verified FROM staff_users s
 JOIN native_staff_admissions a ON a.staff_id=s.id AND a.active=1 AND a.bound_access_subject=? AND a.version=?
 JOIN native_staff_profiles p ON p.staff_id=s.id AND p.login_email=? AND p.version=?
 WHERE s.id=? AND s.status='active' AND s.email=? AND s.access_subject=?
 AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND NOT EXISTS(SELECT 1 FROM json_each(?) scope LEFT JOIN native_business_areas area ON area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1 LEFT JOIN native_business_divisions division ON division.id=json_extract(scope.value,'$.divisionId') AND division.business_area_id=area.id AND division.active=1 WHERE area.id IS NULL OR json_extract(scope.value,'$.scopeKind') NOT IN ('business_area','division') OR json_extract(scope.value,'$.scopeKind')='division' AND division.id IS NULL)
 AND NOT EXISTS(SELECT 1 FROM json_each(?) scope WHERE NOT EXISTS(
 SELECT 1 FROM native_project_grants g WHERE g.staff_id=s.id AND g.capability='project.shared.sync' AND g.active=1 AND g.effect='allow'
 AND (g.scope_kind='global' OR g.scope_kind='exact_project' AND g.external_project_id=?
 OR g.scope_kind='business_area' AND g.business_area_id=json_extract(scope.value,'$.businessAreaId')
 OR g.scope_kind='division' AND g.business_area_id=json_extract(scope.value,'$.businessAreaId') AND g.division_id=json_extract(scope.value,'$.divisionId'))))
 AND (json_array_length(?)>0 OR EXISTS(SELECT 1 FROM native_project_grants g WHERE g.staff_id=s.id AND g.capability='project.shared.sync' AND g.active=1 AND g.effect='allow' AND (g.scope_kind='global' OR g.scope_kind='exact_project' AND g.external_project_id=?)))
 AND NOT EXISTS(SELECT 1 FROM native_project_grants g WHERE g.staff_id=s.id AND g.capability='project.shared.sync' AND g.active=1 AND g.effect='deny'
 AND (g.scope_kind='global' OR g.scope_kind='exact_project' AND g.external_project_id=? OR EXISTS(SELECT 1 FROM json_each(?) scope WHERE g.scope_kind='business_area' AND g.business_area_id=json_extract(scope.value,'$.businessAreaId') OR g.scope_kind='division' AND g.business_area_id=json_extract(scope.value,'$.businessAreaId') AND g.division_id=json_extract(scope.value,'$.divisionId'))))`,
  )
    .bind(
      actor.accessSubject,
      actor.admissionVersion,
      actor.email,
      actor.profileVersion,
      actor.staffId,
      actor.email,
      actor.accessSubject,
      actor.verifiedUntil,
      h.scopes_json,
      h.scopes_json,
      h.external_project_id,
      h.scopes_json,
      h.external_project_id,
      h.external_project_id,
      h.scopes_json,
    )
    .first();
  if (!allowed)
    refused("Current explicit native project authority is required", 403);
}
async function current(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  row: Row,
) {
  connection(env, context, row);
  const h = await head(env.OPS_DB, row.external_project_id);
  await owned(env.OPS_DB, context, h);
  await requireAuthority(env, actor, h);
  if (
    row.context_json !== JSON.stringify(context) ||
    h.current_version !== row.expected_local_version ||
    h.canonical_projection_sha256 !== row.expected_projection_sha256 ||
    h.source_instance_id !== row.source_instance_id ||
    h.application_id !== row.application_id ||
    h.history_epoch_id !== row.history_epoch_id ||
    h.project_alpha_public_id !== row.project_alpha_public_id
  )
    refused("Native lifecycle context or project changed");
  if ((await lifecycleHash(row.body)) !== row.request_sha256)
    refused("Native lifecycle request changed");
  if (
    !(await env.OPS_DB.prepare(
      `SELECT 1 verified FROM native_project_command_proofs original JOIN staff_users s ON s.id=original.actor_staff_id AND s.status='active' AND s.access_subject=? AND s.email=? WHERE original.command_id=? AND original.actor_staff_id=?`,
    )
      .bind(actor.accessSubject, actor.email, row.command_id, actor.staffId)
      .first())
  )
    refused("Native lifecycle requires the original current staff actor", 403);
  return h;
}
async function readPair(
  env: Env,
  context: LifecycleContext,
  h: Head,
  send: typeof fetch,
) {
  const c = connection(env, context);
  const result = await transport(env, context, (c) =>
    readProjectAlphaProject(c, h.project_alpha_public_id, send),
  );
  const evidence =
    result.status === "read" ? validatedProjectAlphaProjectRead(result) : null;
  if (!evidence || !evidence.response.accepted)
    refused("Exact canonical PA project read is required");
  const binding = await transport(env, context, (c) =>
    readProjectAlphaProjectBindingStatus(c, h.external_project_id, send),
  );
  if (
    (binding.status !== "observed" && binding.status !== "binding_stale") ||
    binding.response.binding.publicId !== h.project_alpha_public_id ||
    binding.response.resource.revision !==
      evidence.response.resource.revision ||
    binding.response.resource.projectionSha256 !==
      evidence.response.resource.projectionSha256
  )
    refused("Exact project binding read is required");
  const data = evidence.response.data;
  if (
    binding.status === "observed" &&
    (binding.response.resource.status !== data.status ||
      binding.response.resource.archived !== data.archived)
  )
    refused("Project binding state does not match the canonical read");
  for (const [kind, record, publicId] of [
    ["organization", h.organization_record_id, data.organizationPublicId],
    ["client", h.client_record_id, data.clientPublicId],
  ] as const) {
    if (
      (record === null) !== (publicId === null) ||
      (record &&
        !(await env.OPS_DB.prepare(
          `SELECT 1 verified FROM project_alpha_active_directory_mappings WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type=? AND record_id=? AND project_alpha_public_id=?`,
        )
          .bind(
            h.source_id,
            h.source_instance_id,
            h.application_id,
            h.history_epoch_id,
            kind,
            record,
            publicId,
          )
          .first()))
    )
      refused("Project owner relationship changed");
  }
  return { read: evidence, binding };
}
export async function prepareNativeProjectLifecycle(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  input: {
    commandId: string;
    externalProjectId: string;
    action: "archive" | "restore";
  },
  send: typeof fetch = fetch,
) {
  if (
    !uuid(input.commandId) ||
    !externalId(input.externalProjectId) ||
    !["archive", "restore"].includes(input.action)
  )
    refused("Invalid lifecycle intent");
  const prior = await env.OPS_DB.prepare(
    "SELECT * FROM native_project_lifecycle_commands WHERE command_id=?",
  )
    .bind(input.commandId)
    .first<Row>();
  if (prior) {
    if (
      prior.external_project_id !== input.externalProjectId ||
      prior.action !== input.action ||
      prior.context_json !== JSON.stringify(context)
    )
      refused("Lifecycle command ID conflicts");
    await readNativeProjectLifecycleStatus(
      env,
      actor,
      context,
      prior.command_id,
    );
    return statusValue(prior);
  }
  const h = await head(env.OPS_DB, input.externalProjectId);
  await owned(env.OPS_DB, context, h);
  await requireAuthority(env, actor, h);
  const c = connection(env, context);
  if (
    h.source_instance_id !== c.expectedSourceInstanceId ||
    h.application_id !== c.expectedApplicationId ||
    h.history_epoch_id !== c.expectedHistoryEpoch ||
    h.archived !== (input.action === "restore" ? 1 : 0)
  )
    refused("Project is not in the required lifecycle state");
  const pair = await readPair(env, context, h, send);
  if (
    pair.binding.status !== "observed" ||
    pair.read.response.resource.revision !== h.pa_revision ||
    pair.read.response.resource.projectionSha256 !==
      h.canonical_projection_sha256 ||
    pair.read.response.data.archived !== (input.action === "restore")
  )
    refused("Project canonical read is stale");
  const body = JSON.stringify({
      commandId: input.commandId,
      expectedRevision: h.pa_revision,
    }),
    ctx = JSON.stringify(context),
    sha = await lifecycleHash(body);
  const envelopeSha = await lifecycleHash(
    JSON.stringify({
      context,
      action: input.action,
      externalProjectId: input.externalProjectId,
      sourceInstanceId: h.source_instance_id,
      applicationId: h.application_id,
      historyEpoch: h.history_epoch_id,
      publicId: h.project_alpha_public_id,
      body,
      localVersion: h.current_version,
      localHash: h.canonical_projection_sha256,
    }),
  );
  const expiry = new Date(
    Math.min(Date.now() + 5 * 60000, Date.parse(actor.verifiedUntil)),
  ).toISOString();
  await env.OPS_DB.batch([
    proof(env.OPS_DB, input.commandId, h, actor),
    env.OPS_DB.prepare(
      `INSERT INTO native_project_lifecycle_commands(command_id,external_project_id,action,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,project_alpha_public_id,context_json,context_sha256,body,request_sha256,expected_local_version,expected_projection_sha256,expected_pa_revision,prior_head_json,expires_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      input.commandId,
      h.external_project_id,
      input.action,
      h.source_id,
      h.source_instance_id,
      h.application_id,
      h.history_epoch_id,
      new URL(c.baseUrl).origin,
      h.project_alpha_public_id,
      ctx,
      envelopeSha,
      body,
      sha,
      h.current_version,
      h.canonical_projection_sha256,
      h.pa_revision,
      JSON.stringify(h),
      expiry,
    ),
  ]);
  return statusValue(await command(env.OPS_DB, input.commandId));
}
function statusValue(row: Row) {
  return {
    commandId: row.command_id,
    action: row.action,
    state: row.state,
    reviewSha256: row.context_sha256,
    dispatchClaimCount: row.transmission_count,
    expiresAt: row.expires_at,
    canonicalActivated: row.state === "activated",
  };
}
export async function readNativeProjectLifecycleStatus(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  id: string,
) {
  const row = await command(env.OPS_DB, id);
  connection(env, context, row);
  const h = await head(env.OPS_DB, row.external_project_id);
  await owned(env.OPS_DB, context, h);
  await requireAuthority(env, actor, h);
  if (row.context_json !== JSON.stringify(context))
    refused("Lifecycle context changed");
  const original = await env.OPS_DB.prepare(
    "SELECT actor_staff_id,actor_access_subject FROM native_project_command_proofs WHERE command_id=?",
  )
    .bind(id)
    .first<{
      actor_staff_id: string;
      actor_access_subject: string;
    }>();
  if (
    original?.actor_staff_id !== actor.staffId ||
    original.actor_access_subject !== actor.accessSubject
  )
    refused("Lifecycle actor changed", 403);
  const refreshes = (
    await env.OPS_DB.prepare(
      "SELECT command_id,state,request_sha256,transmission_count,expires_at FROM native_project_lifecycle_refreshes WHERE parent_command_id=? ORDER BY created_at,command_id",
    )
      .bind(row.command_id)
      .all()
  ).results;
  return { ...statusValue(row), refreshPreparations: refreshes };
}
async function authorize(
  env: Env,
  actor: LifecycleActor,
  row: Row,
  h: Head,
  purpose: string,
) {
  const pid = crypto.randomUUID(),
    aid = crypto.randomUUID();
  return {
    aid,
    statements: [
      proof(env.OPS_DB, pid, h, actor),
      env.OPS_DB.prepare(
        "INSERT INTO native_project_lifecycle_authorizations(authorization_id,command_id,proof_command_id,purpose)VALUES(?,?,?,?)",
      ).bind(aid, row.command_id, pid, purpose),
    ],
  };
}
function gatedPost(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  row: Row,
  token: string,
  childId: string | null,
  network: {
    began: boolean;
  },
  send: typeof fetch,
  beforePost: () => Promise<void>,
): typeof fetch {
  return async (input, init) => {
    const method =
      input instanceof Request ? input.method : (init?.method ?? "GET");
    if (method.toUpperCase() === "POST") {
      await current(env, actor, context, row);
      await transport(env, context, async (c) => {
        if (
          c.expectedSourceInstanceId !== row.source_instance_id ||
          c.expectedApplicationId !== row.application_id ||
          c.expectedHistoryEpoch !== row.history_epoch_id ||
          new URL(c.baseUrl).origin !== row.destination_origin
        )
          refused("Lifecycle connector proof changed");
      });
      const table = childId
        ? "native_project_lifecycle_refreshes"
        : "native_project_lifecycle_commands";
      const valid = await env.OPS_DB.prepare(
        `SELECT 1 verified FROM ${table} c JOIN native_project_lifecycle_live_authorizations a ON a.authorization_id=c.active_authorization_id WHERE c.command_id=? AND c.state='sending' AND c.lease_token=? AND c.lease_expires_at>?`,
      )
        .bind(childId ?? row.command_id, token, Date.now())
        .first();
      if (!valid) refused("Lifecycle lease or live authorization changed", 403);
      await beforePost();
      await current(env, actor, context, row);
      const requestHash = childId
        ? (await child(env.OPS_DB, row.command_id)).request_sha256
        : row.request_sha256;
      await env.OPS_DB.prepare(
        "INSERT INTO native_project_lifecycle_post_attempts(lease_token,parent_command_id,refresh_command_id,request_sha256)VALUES(?,?,?,?)",
      )
        .bind(token, row.command_id, childId, requestHash)
        .run();
      network.began = true;
    }
    return send(input, init);
  };
}
async function releaseUnsent(
  env: Env,
  row: Row,
  token: string,
  returnState: "prepared" | "uncertain",
  requestHash: string,
  childId: string | null,
  code: string,
) {
  const table = childId
    ? "native_project_lifecycle_refreshes"
    : "native_project_lifecycle_commands";
  await env.OPS_DB.batch([
    env.OPS_DB.prepare(
      `UPDATE ${table} SET state=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='sending' AND lease_token=?`,
    ).bind(returnState, childId ?? row.command_id, token),
    assertChanged(env.OPS_DB),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_events(event_id,command_id,phase,request_sha256,safe_code)VALUES(?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      row.command_id,
      childId ? "refresh-pre-send-blocked" : "lifecycle-pre-send-blocked",
      requestHash,
      code,
    ),
  ]);
}
async function uncertain(env: Env, row: Row, token: string, code: string) {
  await env.OPS_DB.batch([
    env.OPS_DB.prepare(
      "UPDATE native_project_lifecycle_commands SET state='uncertain',lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='sending' AND lease_token=?",
    ).bind(row.command_id, token),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_events(event_id,command_id,phase,request_sha256,safe_code)VALUES(?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      row.command_id,
      "uncertain",
      row.request_sha256,
      code,
    ),
  ]);
}
export async function submitNativeProjectLifecycle(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  input: {
    commandId: string;
    reviewSha256: string;
    reconcile: boolean;
  },
  send: typeof fetch = fetch,
  beforePost: () => Promise<void> = async () => {},
) {
  const row = await command(env.OPS_DB, input.commandId);
  if (input.reviewSha256 !== row.context_sha256)
    refused("Lifecycle reviewed request changed");
  if (["acknowledged", "settled", "activated"].includes(row.state)) {
    await readNativeProjectLifecycleStatus(env, actor, context, row.command_id);
    return statusValue(row);
  }
  const h = await current(env, actor, context, row);
  const recovering = ["sending", "uncertain"].includes(row.state);
  if (
    row.state === "sending" &&
    (row.lease_expires_at ?? Infinity) > Date.now()
  )
    refused("Lifecycle transmission is still leased");
  if (
    recovering !== input.reconcile ||
    (!recovering && row.state !== "prepared") ||
    (!recovering && Date.parse(row.expires_at) <= Date.now())
  )
    refused("Lifecycle requires an explicit matching recovery decision");
  const auth = await authorize(
      env,
      actor,
      row,
      h,
      recovering ? "reconcile" : "send",
    ),
    token = crypto.randomUUID();
  await env.OPS_DB.batch([
    ...auth.statements,
    env.OPS_DB.prepare(
      "UPDATE native_project_lifecycle_commands SET state='sending',lease_token=?,lease_expires_at=?,active_authorization_id=?,transmission_count=transmission_count+1 WHERE command_id=? AND state=? AND lease_token IS ?",
    ).bind(
      token,
      Date.now() + 300000,
      auth.aid,
      row.command_id,
      row.state,
      row.lease_token,
    ),
    assertChanged(env.OPS_DB),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_events(event_id,command_id,phase,request_sha256)VALUES(?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      row.command_id,
      recovering ? "before-exact-reconciliation-post" : "before-action-post",
      row.request_sha256,
    ),
  ]);
  const network = { began: false };
  try {
    const outcome = await transport(env, context, (c) =>
      sendProjectAlphaProjectLifecycleCommand(
        c,
        row.project_alpha_public_id,
        row.action,
        JSON.parse(row.body),
        gatedPost(
          env,
          actor,
          context,
          row,
          token,
          null,
          network,
          send,
          beforePost,
        ),
      ),
    );
    const receipt = validatedProjectLifecycleReceipt(outcome);
    if (
      !receipt ||
      receipt.body !== row.body ||
      receipt.action !== row.action ||
      receipt.publicId !== row.project_alpha_public_id ||
      receipt.destinationOrigin !== row.destination_origin ||
      !receipt.response.accepted ||
      receipt.response.result.presentation.portalPublished ||
      receipt.response.result.presentation.publicLinkEnabled
    ) {
      if (network.began)
        await uncertain(
          env,
          row,
          token,
          outcome.status === "acknowledged"
            ? "receipt_contract"
            : outcome.reason,
        );
      else
        await releaseUnsent(
          env,
          row,
          token,
          recovering ? "uncertain" : "prepared",
          row.request_sha256,
          null,
          outcome.status === "acknowledged"
            ? "receipt_contract"
            : outcome.reason,
        );
      return statusValue(await command(env.OPS_DB, row.command_id));
    }
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(
        "INSERT INTO native_project_lifecycle_receipts(command_id,response_json,response_sha256,project_alpha_revision,request_id)VALUES(?,?,?,?,?)",
      ).bind(
        row.command_id,
        JSON.stringify(receipt.response),
        receipt.responseSha256,
        receipt.response.resource.revision,
        receipt.response.requestId,
      ),
      env.OPS_DB.prepare(
        "UPDATE native_project_lifecycle_commands SET state='acknowledged',lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='sending' AND lease_token=?",
      ).bind(row.command_id, token),
      assertChanged(env.OPS_DB),
    ]);
  } catch {
    if (network.began)
      await uncertain(env, row, token, "post_or_local_receipt_unknown");
    else
      await releaseUnsent(
        env,
        row,
        token,
        recovering ? "uncertain" : "prepared",
        row.request_sha256,
        null,
        "pre_send_failed",
      );
  }
  return statusValue(await command(env.OPS_DB, row.command_id));
}
async function child(db: D1Database, parent: string) {
  const value = await db
    .prepare(
      "SELECT * FROM native_project_lifecycle_refreshes WHERE parent_command_id=? AND state<>'rejected' ORDER BY created_at DESC",
    )
    .bind(parent)
    .first<Child>();
  if (!value) refused("Lifecycle binding refresh is not prepared");
  return value;
}
export async function prepareNativeProjectLifecycleRefresh(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  input: {
    commandId: string;
    refreshCommandId: string;
    reviewSha256: string;
  },
  send: typeof fetch = fetch,
) {
  const row = await command(env.OPS_DB, input.commandId);
  if (
    row.context_sha256 !== input.reviewSha256 ||
    !uuid(input.refreshCommandId) ||
    row.state !== "acknowledged"
  )
    refused("Exact acknowledged lifecycle is required");
  const h = await current(env, actor, context, row),
    pair = await readPair(env, context, h, send);
  const prior = await env.OPS_DB.prepare(
    "SELECT * FROM native_project_lifecycle_refreshes WHERE parent_command_id=? AND state<>'rejected' ORDER BY created_at DESC",
  )
    .bind(row.command_id)
    .first<Child>();
  if (prior) {
    if (prior.command_id !== input.refreshCommandId)
      refused("Lifecycle already owns a different refresh command");
    return {
      commandId: row.command_id,
      refreshCommandId: prior.command_id,
      reviewSha256: prior.request_sha256,
      state: prior.state,
    };
  }
  const receipt = await env.OPS_DB.prepare(
    "SELECT project_alpha_revision FROM native_project_lifecycle_receipts WHERE command_id=?",
  )
    .bind(row.command_id)
    .first<{
      project_alpha_revision: string;
    }>();
  if (
    pair.binding.status !== "binding_stale" ||
    pair.read.response.resource.revision !== receipt?.project_alpha_revision ||
    pair.read.response.data.archived !== (row.action === "archive")
  )
    refused(
      "Exact stale lifecycle binding is required; no automatic binding change",
    );
  const body: ProjectAlphaProjectRefreshCommand = {
    commandId: input.refreshCommandId,
    externalId: row.external_project_id,
    expectedPublicId: row.project_alpha_public_id,
    expectedPriorRevision: pair.binding.response.binding.revision,
    expectedRevision: pair.read.response.resource.revision,
    expectedProjectionSha256: pair.read.response.resource.projectionSha256,
    expectedAuthorizationGeneration:
      pair.binding.response.authorizationGeneration,
  };
  const canonical = canonicalProjectAlphaProjectRequest("refresh", body);
  if (!canonical) refused("Invalid exact refresh proof");
  const sha = await lifecycleHash(canonical.body);
  const expiry = new Date(
    Math.min(Date.now() + 5 * 60000, Date.parse(actor.verifiedUntil)),
  ).toISOString();
  await env.OPS_DB.batch([
    proof(env.OPS_DB, input.refreshCommandId, h, actor),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_refreshes(command_id,parent_command_id,body,request_sha256,expected_revision,expected_projection_sha256,expires_at)VALUES(?,?,?,?,?,?,?)",
    ).bind(
      input.refreshCommandId,
      row.command_id,
      canonical.body,
      sha,
      body.expectedRevision,
      body.expectedProjectionSha256,
      expiry,
    ),
  ]);
  return {
    commandId: row.command_id,
    refreshCommandId: input.refreshCommandId,
    reviewSha256: sha,
    state: "prepared",
  };
}
async function refreshUncertain(
  env: Env,
  row: Row,
  ch: Child,
  token: string,
  code: string,
) {
  await env.OPS_DB.batch([
    env.OPS_DB.prepare(
      "UPDATE native_project_lifecycle_refreshes SET state='uncertain',lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='sending' AND lease_token=?",
    ).bind(ch.command_id, token),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_events(event_id,command_id,phase,request_sha256,safe_code)VALUES(?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      row.command_id,
      "refresh_uncertain",
      ch.request_sha256,
      code,
    ),
  ]);
}
export async function submitNativeProjectLifecycleRefresh(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  input: {
    commandId: string;
    refreshCommandId: string;
    reviewSha256: string;
    reconcile: boolean;
  },
  send: typeof fetch = fetch,
  beforePost: () => Promise<void> = async () => {},
) {
  const row = await command(env.OPS_DB, input.commandId),
    ch = await child(env.OPS_DB, row.command_id);
  if (
    row.state !== "acknowledged" ||
    input.refreshCommandId !== ch.command_id ||
    input.reviewSha256 !== ch.request_sha256 ||
    (await lifecycleHash(ch.body)) !== ch.request_sha256
  )
    refused("Exact reviewed refresh is required");
  const h = await current(env, actor, context, row);
  if (ch.state === "acknowledged")
    return {
      commandId: row.command_id,
      refreshCommandId: ch.command_id,
      state: ch.state,
      canonicalActivated: false,
    };
  const recovering = ["sending", "uncertain"].includes(ch.state);
  if (ch.state === "sending" && (ch.lease_expires_at ?? Infinity) > Date.now())
    refused("Refresh transmission is still leased");
  if (
    recovering !== input.reconcile ||
    (!recovering && ch.state !== "prepared") ||
    (!recovering && Date.parse(ch.expires_at) <= Date.now())
  )
    refused("Refresh requires explicit exact reconciliation");
  if (!recovering) {
    const pair = await readPair(env, context, h, send),
      body = JSON.parse(ch.body) as ProjectAlphaProjectRefreshCommand;
    if (
      pair.binding.status !== "binding_stale" ||
      pair.binding.response.binding.revision !== body.expectedPriorRevision ||
      pair.binding.response.authorizationGeneration !==
        body.expectedAuthorizationGeneration ||
      pair.read.response.resource.revision !== body.expectedRevision ||
      pair.read.response.resource.projectionSha256 !==
        body.expectedProjectionSha256
    )
      refused("Reviewed live refresh proof changed");
  }
  const auth = await authorize(
      env,
      actor,
      row,
      h,
      recovering ? "refresh_reconcile" : "refresh",
    ),
    token = crypto.randomUUID();
  await env.OPS_DB.batch([
    ...auth.statements,
    env.OPS_DB.prepare(
      "UPDATE native_project_lifecycle_refreshes SET state='sending',lease_token=?,lease_expires_at=?,active_authorization_id=?,transmission_count=transmission_count+1 WHERE command_id=? AND state=? AND lease_token IS ?",
    ).bind(
      token,
      Date.now() + 300000,
      auth.aid,
      ch.command_id,
      ch.state,
      ch.lease_token,
    ),
    assertChanged(env.OPS_DB),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_events(event_id,command_id,phase,request_sha256)VALUES(?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      row.command_id,
      recovering
        ? "before-exact-refresh-reconciliation-post"
        : "before-reviewed-refresh-post",
      ch.request_sha256,
    ),
  ]);
  const network = { began: false };
  try {
    const outcome = await transport(env, context, (c) =>
      sendProjectAlphaProjectRefreshCommand(
        c,
        JSON.parse(ch.body),
        gatedPost(
          env,
          actor,
          context,
          row,
          token,
          ch.command_id,
          network,
          send,
          beforePost,
        ),
      ),
    );
    const receipt = validatedProjectAlphaProjectAcknowledgement(outcome);
    if (
      !receipt ||
      receipt.type !== "refresh" ||
      receipt.requestSha256 !== ch.request_sha256 ||
      receipt.destinationOrigin !== row.destination_origin ||
      receipt.response.result.resource.publicId !==
        row.project_alpha_public_id ||
      receipt.response.result.resource.revision !== ch.expected_revision ||
      receipt.response.result.resource.projectionSha256 !==
        ch.expected_projection_sha256 ||
      receipt.response.result.presentation.portalPublished ||
      receipt.response.result.presentation.publicLinkEnabled
    ) {
      if (network.began)
        await refreshUncertain(
          env,
          row,
          ch,
          token,
          outcome.status === "acknowledged"
            ? "refresh_contract"
            : outcome.reason,
        );
      else
        await releaseUnsent(
          env,
          row,
          token,
          recovering ? "uncertain" : "prepared",
          ch.request_sha256,
          ch.command_id,
          outcome.status === "acknowledged"
            ? "refresh_contract"
            : outcome.reason,
        );
    } else
      await env.OPS_DB.batch([
        env.OPS_DB.prepare(
          "INSERT INTO native_project_lifecycle_refresh_receipts(command_id,response_json,response_sha256)VALUES(?,?,?)",
        ).bind(
          ch.command_id,
          JSON.stringify(receipt.response),
          receipt.responseSha256,
        ),
        env.OPS_DB.prepare(
          "UPDATE native_project_lifecycle_refreshes SET state='acknowledged',lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='sending' AND lease_token=?",
        ).bind(ch.command_id, token),
        assertChanged(env.OPS_DB),
      ]);
  } catch {
    if (network.began)
      await refreshUncertain(
        env,
        row,
        ch,
        token,
        "refresh_post_or_receipt_unknown",
      );
    else
      await releaseUnsent(
        env,
        row,
        token,
        recovering ? "uncertain" : "prepared",
        ch.request_sha256,
        ch.command_id,
        "refresh_pre_send_failed",
      );
  }
  return {
    commandId: row.command_id,
    refreshCommandId: ch.command_id,
    state: (await child(env.OPS_DB, row.command_id)).state,
    canonicalActivated: false,
  };
}
export async function activateNativeProjectLifecycle(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  input: {
    commandId: string;
    reviewSha256: string;
  },
  send: typeof fetch = fetch,
) {
  const row = await command(env.OPS_DB, input.commandId);
  if (row.context_sha256 !== input.reviewSha256)
    refused("Lifecycle reviewed request changed");
  if (row.state === "activated")
    return readNativeProjectLifecycleStatus(
      env,
      actor,
      context,
      row.command_id,
    );
  const h = await current(env, actor, context, row),
    ch = await child(env.OPS_DB, row.command_id);
  if (row.state !== "acknowledged" || ch.state !== "acknowledged")
    refused("Explicit refresh receipt is required before canonical activation");
  const pair = await readPair(env, context, h, send),
    read = pair.read.response;
  if (
    pair.binding.status !== "observed" ||
    read.resource.revision !== ch.expected_revision ||
    read.resource.projectionSha256 !== ch.expected_projection_sha256 ||
    read.data.archived !== (row.action === "archive")
  )
    refused("Matching refreshed canonical read is required");
  const pid = crypto.randomUUID(),
    sid = crypto.randomUUID(),
    token = crypto.randomUUID();
  const readJson = pair.read.responseJson,
    bindingJson = JSON.stringify(pair.binding.response),
    bindingSha = await lifecycleHash(bindingJson);
  await env.OPS_DB.batch([
    proof(env.OPS_DB, pid, h, actor),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_settlements(settlement_id,command_id,refresh_command_id,proof_command_id,read_json,read_sha256,binding_json,binding_sha256)VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      sid,
      row.command_id,
      ch.command_id,
      pid,
      readJson,
      pair.read.responseSha256,
      bindingJson,
      bindingSha,
    ),
    env.OPS_DB.prepare(
      "UPDATE native_project_lifecycle_commands SET state='settled' WHERE command_id=? AND state='acknowledged'",
    ).bind(row.command_id),
    assertChanged(env.OPS_DB),
    env.OPS_DB.prepare(
      "UPDATE native_project_lifecycle_commands SET state='activating',lease_token=?,lease_expires_at=? WHERE command_id=? AND state='settled'",
    ).bind(token, Date.now() + 300000, row.command_id),
    assertChanged(env.OPS_DB),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_activation_fences(command_id,settlement_id,proof_command_id,expires_at)VALUES(?,?,?,?)",
    ).bind(row.command_id, sid, pid, actor.verifiedUntil),
    env.OPS_DB.prepare(
      "UPDATE operations_shared_projects SET current_version=current_version+1,pa_revision=?,canonical_projection_sha256=?,archived=?,archived_at=?,overdue_warning=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE external_project_id=? AND current_version=? AND canonical_projection_sha256=?",
    ).bind(
      read.resource.revision,
      read.resource.projectionSha256,
      read.data.archived ? 1 : 0,
      read.data.archivedAt,
      read.data.overdueWarning ? 1 : 0,
      row.external_project_id,
      row.expected_local_version,
      row.expected_projection_sha256,
    ),
    assertChanged(env.OPS_DB),
    env.OPS_DB.prepare(
      "INSERT INTO operations_shared_project_revisions(external_project_id,version,read_json,lifecycle_settlement_id)VALUES(?,?,?,?)",
    ).bind(
      row.external_project_id,
      row.expected_local_version + 1,
      readJson,
      sid,
    ),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_activations(command_id,settlement_id,resulting_local_version)VALUES(?,?,?)",
    ).bind(row.command_id, sid, row.expected_local_version + 1),
    env.OPS_DB.prepare(
      "UPDATE native_project_lifecycle_commands SET state='activated',lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='activating' AND lease_token=?",
    ).bind(row.command_id, token),
    assertChanged(env.OPS_DB),
  ]);
  return statusValue(await command(env.OPS_DB, row.command_id));
}
/** Retain a known accepted remote effect while handing a newer external edit
 * to the existing explicit inbound review. This never sends a PA command. */
export async function retireNativeProjectLifecycleForInboundReview(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  input: {
    commandId: string;
    reviewSha256: string;
  },
  send: typeof fetch = fetch,
) {
  const row = await command(env.OPS_DB, input.commandId);
  if (row.context_sha256 !== input.reviewSha256)
    refused("Exact reviewed lifecycle is required");
  if (row.state === "inbound_review")
    return readNativeProjectLifecycleStatus(
      env,
      actor,
      context,
      row.command_id,
    );
  if (row.state !== "acknowledged")
    refused("Only a known accepted lifecycle may be handed to inbound review");
  const h = await current(env, actor, context, row);
  const receipt = await env.OPS_DB.prepare(
    "SELECT project_alpha_revision FROM native_project_lifecycle_receipts WHERE command_id=?",
  )
    .bind(row.command_id)
    .first<{
      project_alpha_revision: string;
    }>();
  if (
    !receipt ||
    (await env.OPS_DB.prepare(
      "SELECT 1 blocked FROM native_project_lifecycle_refreshes WHERE parent_command_id=? AND state NOT IN ('acknowledged','rejected')",
    )
      .bind(row.command_id)
      .first())
  )
    refused("Unresolved refresh must be reconciled or explicitly abandoned");
  const outcome = await transport(env, context, (c) =>
      readProjectAlphaProject(c, row.project_alpha_public_id, send),
    ),
    read =
      outcome.status === "read"
        ? validatedProjectAlphaProjectRead(outcome)
        : null;
  if (
    !read ||
    !read.response.accepted ||
    BigInt(read.response.resource.revision) <=
      BigInt(receipt.project_alpha_revision)
  )
    refused(
      "Authentic strictly newer PA detail is required for inbound review",
    );
  await current(env, actor, context, row);
  const auth = await authorize(env, actor, row, h, "inbound_review");
  await env.OPS_DB.batch([
    ...auth.statements,
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_inbound_handoffs(command_id,authorization_id,read_json,read_sha256)VALUES(?,?,?,?)",
    ).bind(row.command_id, auth.aid, read.responseJson, read.responseSha256),
    env.OPS_DB.prepare(
      "UPDATE native_project_lifecycle_commands SET state='inbound_review',active_authorization_id=? WHERE command_id=? AND state='acknowledged'",
    ).bind(auth.aid, row.command_id),
    assertChanged(env.OPS_DB),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_events(event_id,command_id,phase,request_sha256)VALUES(?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      row.command_id,
      "known-acceptance-retained-for-inbound-review",
      row.request_sha256,
    ),
  ]);
  return statusValue(await command(env.OPS_DB, row.command_id));
}
/** Local-only release of an immutable preparation whose PA body was never transmitted. */
export async function abandonNativeProjectLifecyclePreparation(
  env: Env,
  actor: LifecycleActor,
  context: LifecycleContext,
  input: {
    commandId: string;
    reviewSha256: string;
    refreshCommandId?: string;
  },
) {
  const row = await command(env.OPS_DB, input.commandId),
    h = await current(env, actor, context, row);
  const refresh = Boolean(input.refreshCommandId);
  const target = refresh ? await child(env.OPS_DB, row.command_id) : row;
  const expectedHash = refresh ? target.request_sha256 : row.context_sha256;
  if (
    input.reviewSha256 !== expectedHash ||
    target.state !== "prepared" ||
    (refresh && target.command_id !== input.refreshCommandId)
  )
    refused("Only the exact never-transmitted preparation may be abandoned");
  const auth = await authorize(
    env,
    actor,
    row,
    h,
    refresh ? "abandon_refresh" : "abandon",
  );
  const table = refresh
    ? "native_project_lifecycle_refreshes"
    : "native_project_lifecycle_commands";
  await env.OPS_DB.batch([
    ...auth.statements,
    env.OPS_DB.prepare(
      `UPDATE ${table} SET state='rejected',active_authorization_id=? WHERE command_id=? AND state='prepared' AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_post_attempts a WHERE ${refresh ? "a.refresh_command_id" : "a.parent_command_id"}=? ${refresh ? "" : "AND a.refresh_command_id IS NULL"})`,
    ).bind(auth.aid, target.command_id, target.command_id),
    assertChanged(env.OPS_DB),
    env.OPS_DB.prepare(
      "INSERT INTO native_project_lifecycle_events(event_id,command_id,phase,request_sha256)VALUES(?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      row.command_id,
      refresh
        ? "never-transmitted-refresh-abandoned"
        : "never-transmitted-preparation-abandoned",
      target.request_sha256,
    ),
  ]);
  return {
    commandId: row.command_id,
    abandonedPreparationId: target.command_id,
    noPaRequest: true,
  };
}
