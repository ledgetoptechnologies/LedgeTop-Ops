import { HTTPException } from "hono/http-exception";
import { parseDuplicateFreeJson } from "./bounded-json";
import { resolveProjectAlphaApiV2Connection, withEnabledConfiguredProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { probeProjectAlphaApiV2 } from "./project-alpha-api-v2";
import { readConfiguredProjectAlphaDirectoryBindingStatus, readConfiguredProjectAlphaDirectoryProfile } from "./project-alpha-directory-read-api-v2";
import { readConfiguredProjectAlphaDirectoryInventory, type ProjectAlphaDirectoryInventoryOutcome } from "./project-alpha-directory-inventory-api-v2";
import type { Env } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/;
const RESPONSE_LIMIT = 64 * 1024;
const TIMEOUT_MS = 10_000;
function nextGeneration(value: string): string | null { if (!REVISION.test(value) || value === "9223372036854775807") return null; return String(BigInt(value) + 1n); }

export type DirectoryBootstrapInput = Readonly<{
  sourceId: string; expectedApplicationId: string; commandId: string; recordId: string;
  scopes: readonly Readonly<{ businessAreaId: string; divisionId: string | null }>[];
  profile: Readonly<{ name: string; generalEmail: string; generalPhone: string; addressLine1: string; addressLine2: string; city: string; state: string; postalCode: string; country: string }>;
  actor: Readonly<{ staffId: string; accessSubject: string; admissionVersion: number }>;
}>;
export type DirectoryBootstrapOutcome = Readonly<{ status: "acknowledged" | "replayed" | "conflict" | "blocked" | "uncertain"; reason?: string; publicId?: string; revision?: string;
  diagnostic?: Readonly<{ status: string; reason?: string; httpStatus?: number; preflightStatus?: string; preflightReason?: string }> }>;

function inventoryDiagnostic(outcome: ProjectAlphaDirectoryInventoryOutcome): NonNullable<DirectoryBootstrapOutcome["diagnostic"]> {
  const diagnostic: { status: string; reason?: string; httpStatus?: number; preflightStatus?: string; preflightReason?: string } = { status: outcome.status };
  if ("reason" in outcome) diagnostic.reason = outcome.reason;
  if ("httpStatus" in outcome && typeof outcome.httpStatus === "number") diagnostic.httpStatus = outcome.httpStatus;
  if ("preflight" in outcome && outcome.preflight) {
    diagnostic.preflightStatus = outcome.preflight.status;
    if (outcome.preflight.status !== "verified") diagnostic.preflightReason = outcome.preflight.reason;
  }
  return diagnostic;
}

function headers(connection: Readonly<{ apiKey: string; expectedSourceInstanceId: string; expectedApplicationId: string; expectedHistoryEpoch?: string; accessClientId?: string; accessClientSecret?: string }>): Headers {
  const result = new Headers({ Accept: "application/json", "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${connection.apiKey}`,
    "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId, "X-PA-Application-ID": connection.expectedApplicationId,
    "X-PA-History-Epoch": connection.expectedHistoryEpoch ?? "" });
  if (connection.accessClientId && connection.accessClientSecret) { result.set("CF-Access-Client-Id", connection.accessClientId); result.set("CF-Access-Client-Secret", connection.accessClientSecret); }
  return result;
}
function exactReplay(row: Record<string, unknown> | null, command: unknown): DirectoryBootstrapOutcome | null {
  if (!row) return null;
  if (row.command_json !== JSON.stringify(command)) return { status: "conflict", reason: "command_id_body_conflict" };
  // A PA success followed by a D1 acknowledgement failure is recovered by
  // replaying this exact idempotent command, not by inventing a second record.
  if (typeof row.project_alpha_public_id !== "string" || typeof row.revision !== "string") return null;
  return { status: "replayed", publicId: row.project_alpha_public_id, revision: row.revision };
}
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)); }
async function boundedJson(response: Response): Promise<unknown> {
  const length=response.headers.get("Content-Length");
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>RESPONSE_LIMIT)) throw new Error("response_limit");
  const reader=response.body?.getReader(); if(!reader) throw new Error("body");
  const chunks:Uint8Array[]=[];let total=0;
  try { for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>RESPONSE_LIMIT){await reader.cancel();throw new Error("response_limit");}chunks.push(part.value);} }
  finally { reader.releaseLock(); }
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return parseDuplicateFreeJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
}
function receipt(value: unknown, input: DirectoryBootstrapInput, connection: Readonly<{ expectedSourceInstanceId:string;expectedApplicationId:string;expectedHistoryEpoch?:string }>, requestId:string): { publicId:string; revision:string; body:Record<string,unknown> } | null {
  if(!plain(value)||!exact(value,["sourceInstanceId","applicationId","historyEpoch","requestId","replayed","result"])||value.sourceInstanceId!==connection.expectedSourceInstanceId||value.applicationId!==connection.expectedApplicationId||value.historyEpoch!==connection.expectedHistoryEpoch||value.requestId!==requestId||!UUID.test(requestId)||typeof value.replayed!=="boolean"||!plain(value.result)||!exact(value.result,["resource","authorizationGeneration"])||typeof value.result.authorizationGeneration!=="string"||!REVISION.test(value.result.authorizationGeneration)||!plain(value.result.resource)||!exact(value.result.resource,["type","id","publicId","revision"]))return null;
  const resource=value.result.resource;
  if(resource.type!=="organization"||resource.id!==input.recordId||typeof resource.publicId!=="string"||!PUBLIC_ID.test(resource.publicId)||resource.revision!=="1"||typeof resource.revision!=="string"||!REVISION.test(resource.revision))return null;
  return { publicId:resource.publicId,revision:resource.revision,body:value };
}
function trustedCreateReceipt(response: Response, expectedStatus: number): string | null {
  const requestId=response.headers.get("X-Request-ID");
  const noStore=(response.headers.get("Cache-Control")??"").split(",").some(value=>value.trim().toLowerCase()==="no-store");
  return response.status===expectedStatus&&noStore&&!response.headers.has("Set-Cookie")&&!response.headers.has("Location")&&/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type")??"")&&typeof requestId==="string"&&UUID.test(requestId)?requestId:null;
}

/**
 * Staging-only bootstrap.  The record is first created through the same
 * native-admission/fence/revision/audit/intent/materialization guards used by
 * ordinary directory mutations.  The PA request is then dispatched from the
 * durable outbox and its acknowledgement and immutable mapping are persisted
 * in one D1 batch.  It intentionally has no retry loop or scheduler.
 */
export async function bootstrapProjectAlphaDirectoryOrganization(env: Env, input: DirectoryBootstrapInput, send: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<DirectoryBootstrapOutcome> {
  let configured: ReturnType<typeof resolveProjectAlphaApiV2Connection>;
  try { configured = resolveProjectAlphaApiV2Connection(env, input.sourceId); }
  catch { return { status: "blocked", reason: "connection_configuration" }; }
  if (!configured.enabled || configured.connection.expectedApplicationId !== input.expectedApplicationId)
    return { status: "blocked", reason: "connection_selection" };
  // Staging can carry multiple connection entries. This fixture must never
  // choose one merely because a browser supplied its source ID.
  if (env.PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_SOURCE_ID !== input.sourceId
    || env.PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ORIGIN !== configured.connection.baseUrl)
    return { status: "blocked", reason: "acceptance_target_pin" };
  const existing = await env.OPS_DB.prepare(`SELECT o.command_json,o.source_id,o.application_id,o.expected_source_instance_id,o.expected_history_epoch_id,o.resource_type,o.external_id,
      m.project_alpha_public_id,m.source_id AS mapping_source_id,m.source_instance_id AS mapping_source_instance_id,m.application_id AS mapping_application_id,m.history_epoch_id AS mapping_history_epoch_id,m.resource_type AS mapping_resource_type,m.external_id AS mapping_external_id,
      json_extract(o.outcome_json,'$.response.result.resource.revision') AS revision
    FROM project_alpha_directory_outbox o LEFT JOIN project_alpha_directory_mappings m ON m.command_id=o.command_id WHERE o.command_id=?`).bind(input.commandId).first<Record<string, unknown>>();
  if(existing&&(existing.source_id!==input.sourceId||existing.application_id!==configured.connection.expectedApplicationId||existing.expected_source_instance_id!==configured.connection.expectedSourceInstanceId||existing.expected_history_epoch_id!==configured.connection.expectedHistoryEpoch||existing.resource_type!=="organization"||existing.external_id!==input.recordId))return{status:"conflict",reason:"command_id_identity_conflict"};
  if(existing&&existing.project_alpha_public_id!==null&&(existing.mapping_source_id!==input.sourceId||existing.mapping_application_id!==configured.connection.expectedApplicationId||existing.mapping_source_instance_id!==configured.connection.expectedSourceInstanceId||existing.mapping_history_epoch_id!==configured.connection.expectedHistoryEpoch||existing.mapping_resource_type!=="organization"||existing.mapping_external_id!==input.recordId))return{status:"conflict",reason:"mapping_identity_conflict"};
  let expectedAuthorizationGeneration: string;
  if(existing){let prior:unknown;try{prior=JSON.parse(String(existing.command_json));}catch{return{status:"conflict",reason:"command_id_body_conflict"};}if(!plain(prior)||!exact(prior,["operation","commandId","resourceType","externalId","expectedRevision","expectedAuthorizationGeneration","fields","scopes"])||prior.operation!=="create"||prior.commandId!==input.commandId||prior.resourceType!=="organization"||prior.externalId!==input.recordId||prior.expectedRevision!=="0"||JSON.stringify(prior.fields)!==JSON.stringify(input.profile)||JSON.stringify(prior.scopes)!==JSON.stringify(input.scopes)||typeof prior.expectedAuthorizationGeneration!=="string"||!REVISION.test(prior.expectedAuthorizationGeneration))return{status:"conflict",reason:"command_id_body_conflict"};expectedAuthorizationGeneration=prior.expectedAuthorizationGeneration;}
  else { const inventory=await readConfiguredProjectAlphaDirectoryInventory(env,input.sourceId,{type:"organization",limit:1},send);
    if(inventory.status!=="observed"||!REVISION.test(inventory.inventory.authorizationGeneration))return {status:"blocked",reason:"directory_inventory",diagnostic:inventoryDiagnostic(inventory)};
    expectedAuthorizationGeneration=inventory.inventory.authorizationGeneration; }
  const apiCommand = { commandId: input.commandId, externalId: input.recordId, expectedAuthorizationGeneration, profile: input.profile };
  const commandJson = { operation: "create", commandId: input.commandId, resourceType: "organization", externalId: input.recordId,
    expectedRevision: "0", expectedAuthorizationGeneration, fields: input.profile, scopes: input.scopes };
  const replay = exactReplay(existing ?? null, commandJson); if (replay) return replay;
  const grant = await env.OPS_DB.prepare(`SELECT id FROM native_directory_grants WHERE staff_id=? AND permission='directory.profile.edit' AND effect='allow' AND active=1 AND scope_kind='global'
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants d WHERE d.staff_id=native_directory_grants.staff_id AND d.permission='directory.profile.edit' AND d.effect='deny' AND d.active=1 AND d.scope_kind='global') LIMIT 1`).bind(input.actor.staffId).first<{ id: string }>();
  if (!grant) return { status: "blocked", reason: "native_directory_authority" };
  const selected = await withEnabledConfiguredProjectAlphaApiV2Connection(env, input.sourceId, async connection => connection);
  if (selected.status !== "enabled") return { status: "blocked", reason: "connection_configuration" };
  const connection = selected.value;
  const preflight=await probeProjectAlphaApiV2(connection,["api.capabilities.read"],send,[
    {method:"POST",path:"/api/v2/directory/organizations/commands",requiredCapability:"directory.organizations.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
    {method:"GET",path:"/api/v2/directory/organizations/{publicId}",requiredCapability:"directory.organizations.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
    {method:"GET",path:"/api/v2/bindings/organization/status/{base64urlExternalId}",requiredCapability:"directory.organizations.binding_status.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
    {method:"GET",path:"/api/v2/directory/inventory",requiredCapability:"directory.inventory.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
  ]);
  if(preflight.status!=="verified")return {status:"blocked",reason:"directory_capabilities"};
  const destination = [{ sourceId: input.sourceId, sourceInstanceUUID: connection.expectedSourceInstanceId, applicationUUID: connection.expectedApplicationId,
    historyEpoch: connection.expectedHistoryEpoch, origin: connection.baseUrl, externalCanonicalId: input.recordId }];
  const mutationId = `${input.commandId}:directory-bootstrap`, admissionId = `${input.commandId}:admission`, intentId = `${input.commandId}:intent`;
  const auditId = `${input.commandId}:audit`, scopes = JSON.stringify(input.scopes), profileJson = JSON.stringify(input.profile), destinations = JSON.stringify(destination);
  const origin = JSON.stringify({ actorId: input.actor.staffId, authorityRevision: "1", actorSubject: input.actor.accessSubject });
  try {
    if (!existing) await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId,input.actor.staffId,input.actor.accessSubject,input.recordId,"organization",scopes,profileJson,destinations,input.actor.staffId),
      env.OPS_DB.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,create_admission_id,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes) VALUES(?,?,?,?,?,'directory.profile.edit',?,?,0,?,?,?,?,?,?,1)`).bind(mutationId,"create",input.actor.staffId,input.actor.accessSubject,input.actor.admissionVersion,input.recordId,"organization",admissionId,grant.id,scopes,profileJson,JSON.stringify(commandJson),destinations),
      env.OPS_DB.prepare(`INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)`).bind(input.recordId),
      env.OPS_DB.prepare(`INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,?,?)`).bind(input.recordId,mutationId,profileJson),
      env.OPS_DB.prepare(`INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json,original_verified_access_subject) VALUES(?,?,?,1,'staff',?,?,?)`).bind(auditId,mutationId,input.recordId,input.actor.staffId,JSON.stringify(commandJson),input.actor.accessSubject),
      env.OPS_DB.prepare(`INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,application_uuid,destination_origin,external_canonical_id,desired_payload_json,expected_history_epoch_id,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'waiting')`).bind(intentId,mutationId,input.recordId,1,input.sourceId,connection.expectedSourceInstanceId,connection.expectedApplicationId,connection.baseUrl,input.recordId,profileJson,connection.expectedHistoryEpoch),
      env.OPS_DB.prepare(`UPDATE operations_directory_intents SET state='ready' WHERE intent_id=? AND state='waiting'`).bind(intentId),
      env.OPS_DB.prepare(`INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,disposition_json,next_attempt_at,history_epoch_id) VALUES(?,?,?,?,?,?,?)`).bind(intentId,input.commandId,JSON.stringify(commandJson),origin,JSON.stringify({ kind:"authorized_create", sourceId:input.sourceId, sourceInstanceUUID:connection.expectedSourceInstanceId, applicationUUID:connection.expectedApplicationId, historyEpoch:connection.expectedHistoryEpoch, origin:connection.baseUrl, externalCanonicalId:input.recordId }),Date.now(),connection.expectedHistoryEpoch),
      // The immutable fence can only be removed after every guarded write was
      // consumed. This statement is itself rejected if a trigger left work.
      env.OPS_DB.prepare(`DELETE FROM operations_directory_write_fences WHERE mutation_id=?`).bind(mutationId),
    ]);
  } catch { return { status: "blocked", reason: "native_guard_or_materialization" }; }
  let response: Response; const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
  try { response = await send(new URL("/api/v2/directory/organizations/commands", connection.baseUrl), { method:"POST", headers: headers(connection), body: JSON.stringify(apiCommand), redirect:"manual", credentials:"omit", cache:"no-store",signal:controller.signal }); }
  catch { return { status: "uncertain", reason: controller.signal.aborted ? "timeout" : "transport" }; }
  finally { clearTimeout(timer); }
  if(response.redirected||(response.status>=300&&response.status<400)){await response.body?.cancel();return {status:"uncertain",reason:"pa_receipt"};}
  const requestId=trustedCreateReceipt(response,existing?200:201); if(!requestId)return { status:"uncertain", reason:"pa_receipt" };
  let confirmed:ReturnType<typeof receipt>; try { confirmed=receipt(await boundedJson(response),input,connection,requestId); } catch { confirmed=null; }
  if(!confirmed)return {status:"uncertain",reason:"pa_receipt"};
  const receiptGeneration=plain(confirmed.body.result)&&typeof confirmed.body.result.authorizationGeneration==="string"?confirmed.body.result.authorizationGeneration:null;
  const expectedReceiptGeneration=nextGeneration(expectedAuthorizationGeneration);
  if(!expectedReceiptGeneration||receiptGeneration!==expectedReceiptGeneration)return {status:"uncertain",reason:"pa_receipt"};
  const profile=await readConfiguredProjectAlphaDirectoryProfile(env,input.sourceId,"organization",confirmed.publicId,send);
  const binding=await readConfiguredProjectAlphaDirectoryBindingStatus(env,input.sourceId,"organization",input.recordId,confirmed.publicId,send);
  if(profile.status!=="observed"||binding.status!=="observed"||profile.observation.resource.revision!==confirmed.revision||binding.observation.resource.revision!==confirmed.revision||profile.observation.authorizationGeneration!==receiptGeneration||binding.observation.authorizationGeneration!==receiptGeneration)return {status:"uncertain",reason:"binding_confirmation"};
  const lease = `${input.commandId}:lease`, outcome = JSON.stringify({ status:"acknowledged", response: confirmed.body });
  try { await env.OPS_DB.batch([
    env.OPS_DB.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',lease_token=?,lease_expires_at=?,attempts=attempts+1 WHERE command_id=? AND state='pending'`).bind(lease,Date.now()+60_000,input.commandId),
    env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id) VALUES(?,'organization',?,?,?,?,?,?)`).bind(input.sourceId,input.recordId,confirmed.publicId,connection.expectedSourceInstanceId,connection.expectedApplicationId,connection.expectedHistoryEpoch,input.commandId),
    env.OPS_DB.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased' AND lease_token=?`).bind(outcome,input.commandId,lease),
    env.OPS_DB.prepare(`UPDATE operations_directory_intents SET state='acknowledged' WHERE intent_id=? AND state='materialized'`).bind(intentId),
  ]); } catch { return { status:"uncertain", reason:"acknowledgement_persistence" }; }
  return { status:"acknowledged", publicId:confirmed.publicId, revision:confirmed.revision };
}
