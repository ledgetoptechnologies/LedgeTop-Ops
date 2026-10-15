import {
  probeProjectAlphaApiV2,
  type ProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2Endpoint,
  type ProjectAlphaApiV2Probe,
} from "./project-alpha-api-v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const MAX_REVISION = "9223372036854775807";
const REQUEST_LIMIT = 32 * 1024;
const RESPONSE_LIMIT = 64 * 1024;

export type ProjectAlphaDirectoryBindingRevisionRefreshKind = "client" | "organization";
export type ProjectAlphaDirectoryBindingRevisionRefreshCommand = {
  commandId: string;
  externalId: string;
  expectedPriorRevision: string;
  expectedLiveRevision: string;
  expectedAuthorizationGeneration: string;
};
export type ProjectAlphaDirectoryBindingRevisionRefreshSuccess = {
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  replayed: boolean;
  result: {
    resource: { type: ProjectAlphaDirectoryBindingRevisionRefreshKind; id: string; revision: string };
    binding: { publicId: string; previousRevision: string; authorizationGeneration: string };
  };
};
export type ProjectAlphaDirectoryBindingRevisionRefreshOutcome =
  | { status: "acknowledged"; httpStatus: 200; response: ProjectAlphaDirectoryBindingRevisionRefreshSuccess }
  | { status: "rejected" | "blocked" | "conflict" | "uncertain"; reason: "invalid_command" | "request_limit" | "preflight" | "http_status" | "timeout" | "transport" | "response_limit" | "invalid_contract"; httpStatus?: number; requestId?: string; preflight?: ProjectAlphaApiV2Probe };

export type ProjectAlphaDirectoryBindingRevisionRefreshReconciliation = {
  sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string;
  status: "acknowledged" | "terminal_conflict" | "unresolved";
  command: { commandId: string; requestSha256: string };
  observation: {
    resource: { type: ProjectAlphaDirectoryBindingRevisionRefreshKind; id: string; revision: string; projectionSha256: string };
    binding: { publicId: string; revision: string; projectionSha256: string };
    authorizationGeneration: string;
  };
  acknowledgement: ProjectAlphaDirectoryBindingRevisionRefreshSuccess | null;
};
export type ProjectAlphaDirectoryBindingRevisionRefreshReconciliationOutcome =
  | { status: "reconciled"; httpStatus: 200; response: ProjectAlphaDirectoryBindingRevisionRefreshReconciliation }
  | { status: "rejected" | "blocked" | "conflict" | "uncertain"; reason: "invalid_command" | "request_limit" | "preflight" | "http_status" | "timeout" | "transport" | "response_limit" | "invalid_contract"; httpStatus?: number; requestId?: string; preflight?: ProjectAlphaApiV2Probe };

// This evidence is minted only after the bounded POST has passed the exact
// response contract. JSON-shaped outcomes supplied by callers cannot mint it.
const validatedAcknowledgements = new WeakMap<object, Readonly<{ commandJson: string; responseJson: string; destinationOrigin: string }>>();
const validatedReconciliations = new WeakMap<object, Readonly<{ commandJson: string; responseJson: string; destinationOrigin: string }>>();
export function validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement(outcome: ProjectAlphaDirectoryBindingRevisionRefreshOutcome): Readonly<{ command: ProjectAlphaDirectoryBindingRevisionRefreshCommand; response: ProjectAlphaDirectoryBindingRevisionRefreshSuccess; destinationOrigin: string }> | null {
  const snapshot = validatedAcknowledgements.get(outcome);
  return snapshot ? { command: JSON.parse(snapshot.commandJson) as ProjectAlphaDirectoryBindingRevisionRefreshCommand,
    response: JSON.parse(snapshot.responseJson) as ProjectAlphaDirectoryBindingRevisionRefreshSuccess, destinationOrigin: snapshot.destinationOrigin } : null;
}
export function validatedProjectAlphaDirectoryBindingRevisionRefreshReconciliation(outcome: ProjectAlphaDirectoryBindingRevisionRefreshReconciliationOutcome): Readonly<{ command: ProjectAlphaDirectoryBindingRevisionRefreshCommand; response: ProjectAlphaDirectoryBindingRevisionRefreshReconciliation; destinationOrigin: string }> | null {
  const snapshot=validatedReconciliations.get(outcome);
  return snapshot?{command:JSON.parse(snapshot.commandJson) as ProjectAlphaDirectoryBindingRevisionRefreshCommand,
    response:JSON.parse(snapshot.responseJson) as ProjectAlphaDirectoryBindingRevisionRefreshReconciliation,destinationOrigin:snapshot.destinationOrigin}:null;
}

function plain(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && "value" in Object.getOwnPropertyDescriptor(value, key)!);
  } catch { return false; }
}
function keys(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }
function positiveRevision(value: unknown): value is string { return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && (value.length < MAX_REVISION.length || value <= MAX_REVISION); }
function generation(value: unknown): value is string { return typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && (value.length < MAX_REVISION.length || value <= MAX_REVISION); }
function increment(value: string): string | null {
  if (!generation(value) || value === MAX_REVISION) return null;
  const digits = value.split(""); let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry; index--) { const next = digits[index]!.charCodeAt(0) - 48 + carry; digits[index] = String(next % 10); carry = next === 10 ? 1 : 0; }
  return (carry ? "1" : "") + digits.join("");
}
function advances(live: string, prior: string): boolean { return live.length > prior.length || (live.length === prior.length && live > prior); }
function externalId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 191 || new TextEncoder().encode(value).byteLength > 764 || /\p{C}/u.test(value)) return false;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value; } catch { return false; }
}
function endpoint(kind: ProjectAlphaDirectoryBindingRevisionRefreshKind): ProjectAlphaApiV2Endpoint {
  const plural = kind === "client" ? "clients" : "organizations";
  return { method: "POST", path: `/api/v2/directory/${plural}/bindings/revisions/commands`, requiredCapability: `directory.${plural}.binding.revision.refresh`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}
function reconciliationEndpoint(kind:ProjectAlphaDirectoryBindingRevisionRefreshKind):ProjectAlphaApiV2Endpoint{
  const plural=kind==='client'?'clients':'organizations';
  return{method:'POST',path:`/api/v2/directory/${plural}/bindings/revisions/commands/reconcile`,requiredCapability:`directory.${plural}.binding.revision.refresh`,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true};
}

export function isProjectAlphaDirectoryBindingRevisionRefreshCommand(value: unknown): value is ProjectAlphaDirectoryBindingRevisionRefreshCommand {
  return plain(value) && keys(value, ["commandId", "externalId", "expectedPriorRevision", "expectedLiveRevision", "expectedAuthorizationGeneration"])
    && typeof value.commandId === "string" && UUID.test(value.commandId) && externalId(value.externalId)
    && positiveRevision(value.expectedPriorRevision) && positiveRevision(value.expectedLiveRevision)
    && advances(value.expectedLiveRevision, value.expectedPriorRevision) && generation(value.expectedAuthorizationGeneration)
    && increment(value.expectedAuthorizationGeneration) !== null;
}
function success(value: unknown, kind: ProjectAlphaDirectoryBindingRevisionRefreshKind, command: ProjectAlphaDirectoryBindingRevisionRefreshCommand, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaDirectoryBindingRevisionRefreshSuccess {
  return plain(value) && keys(value, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"])
    && value.sourceInstanceId === connection.expectedSourceInstanceId && value.applicationId === connection.expectedApplicationId && value.historyEpoch === connection.expectedHistoryEpoch
    && typeof value.requestId === "string" && UUID.test(value.requestId) && value.requestId === requestId && typeof value.replayed === "boolean"
    && plain(value.result) && keys(value.result, ["resource", "binding"]) && plain(value.result.resource) && keys(value.result.resource, ["type", "id", "revision"])
    && value.result.resource.type === kind && value.result.resource.id === command.externalId && value.result.resource.revision === command.expectedLiveRevision && positiveRevision(value.result.resource.revision)
    && plain(value.result.binding) && keys(value.result.binding, ["publicId", "previousRevision", "authorizationGeneration"])
    && typeof value.result.binding.publicId === "string" && PUBLIC_ID.test(value.result.binding.publicId)
    && value.result.binding.previousRevision === command.expectedPriorRevision && positiveRevision(value.result.binding.previousRevision)
    && value.result.binding.authorizationGeneration === increment(command.expectedAuthorizationGeneration);
}
async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length"); if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) { await response.body?.cancel(); throw new Error("response_limit"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("invalid_contract"); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read().catch(() => { throw new Error("transport"); }); if (part.done) break; size += part.value.byteLength; if (size > RESPONSE_LIMIT) { await reader.cancel(); throw new Error("response_limit"); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function reconciliation(value:unknown,kind:ProjectAlphaDirectoryBindingRevisionRefreshKind,command:ProjectAlphaDirectoryBindingRevisionRefreshCommand,
  requestSha256:string,connection:ProjectAlphaApiV2Connection,requestId:string|null):value is ProjectAlphaDirectoryBindingRevisionRefreshReconciliation{
  if(!plain(value)||!keys(value,['sourceInstanceId','applicationId','historyEpoch','requestId','status','command','observation','acknowledgement'])
    ||value.sourceInstanceId!==connection.expectedSourceInstanceId||value.applicationId!==connection.expectedApplicationId||value.historyEpoch!==connection.expectedHistoryEpoch
    ||typeof value.requestId!=='string'||!UUID.test(value.requestId)||value.requestId!==requestId
    ||!['acknowledged','terminal_conflict','unresolved'].includes(String(value.status))||!plain(value.command)||!keys(value.command,['commandId','requestSha256'])
    ||value.command.commandId!==command.commandId||value.command.requestSha256!==requestSha256||!plain(value.observation)
    ||!keys(value.observation,['resource','binding','authorizationGeneration'])||!plain(value.observation.resource)
    ||!keys(value.observation.resource,['type','id','revision','projectionSha256'])||value.observation.resource.type!==kind
    ||value.observation.resource.id!==command.externalId||!positiveRevision(value.observation.resource.revision)
    ||typeof value.observation.resource.projectionSha256!=='string'||!/^[0-9a-f]{64}$/.test(value.observation.resource.projectionSha256)
    ||!plain(value.observation.binding)||!keys(value.observation.binding,['publicId','revision','projectionSha256'])
    ||typeof value.observation.binding.publicId!=='string'||!PUBLIC_ID.test(value.observation.binding.publicId)
    ||!positiveRevision(value.observation.binding.revision)||typeof value.observation.binding.projectionSha256!=='string'
    ||!/^[0-9a-f]{64}$/.test(value.observation.binding.projectionSha256)||!generation(value.observation.authorizationGeneration))return false;
  if(value.status==='terminal_conflict')return value.acknowledgement===null&&value.observation.resource.revision===command.expectedLiveRevision
    &&value.observation.binding.revision===command.expectedPriorRevision&&advances(value.observation.authorizationGeneration,command.expectedAuthorizationGeneration);
  if(value.status==='unresolved')return value.acknowledgement===null;
  const ack=value.acknowledgement;
  return plain(ack)&&keys(ack,['sourceInstanceId','applicationId','historyEpoch','requestId','replayed','result'])
    &&ack.sourceInstanceId===connection.expectedSourceInstanceId&&ack.applicationId===connection.expectedApplicationId&&ack.historyEpoch===connection.expectedHistoryEpoch
    &&typeof ack.requestId==='string'&&UUID.test(ack.requestId)&&ack.replayed===true&&plain(ack.result)&&keys(ack.result,['resource','binding'])
    &&plain(ack.result.resource)&&keys(ack.result.resource,['type','id','revision'])&&ack.result.resource.type===kind&&ack.result.resource.id===command.externalId
    &&ack.result.resource.revision===command.expectedLiveRevision&&plain(ack.result.binding)&&keys(ack.result.binding,['publicId','previousRevision','authorizationGeneration'])
    &&ack.result.binding.publicId===value.observation.binding.publicId&&ack.result.binding.previousRevision===command.expectedPriorRevision
    &&ack.result.binding.authorizationGeneration===increment(command.expectedAuthorizationGeneration);
}

/** Read-only exact refresh capability check, shared by pre-lease and send-time fences. */
export async function preflightProjectAlphaDirectoryBindingRevisionRefresh(connection: ProjectAlphaApiV2Connection, kind: ProjectAlphaDirectoryBindingRevisionRefreshKind, send: typeof fetch = fetch): Promise<ProjectAlphaApiV2Probe> {
  if ((kind !== "client" && kind !== "organization") || typeof connection.expectedHistoryEpoch !== "string" || !UUID.test(connection.expectedHistoryEpoch)) return { status: "misconfigured", reason: "configuration" };
  return probeProjectAlphaApiV2(connection, [], send, [endpoint(kind)]);
}
export async function preflightProjectAlphaDirectoryBindingRevisionRefreshReconciliation(connection:ProjectAlphaApiV2Connection,kind:ProjectAlphaDirectoryBindingRevisionRefreshKind,send:typeof fetch=fetch):Promise<ProjectAlphaApiV2Probe>{
  if((kind!=='client'&&kind!=='organization')||typeof connection.expectedHistoryEpoch!=='string'||!UUID.test(connection.expectedHistoryEpoch))return{status:'misconfigured',reason:'configuration'};
  return probeProjectAlphaApiV2(connection,[],send,[reconciliationEndpoint(kind)]);
}

/** Read-only reconciliation of one frozen command. A validated terminal result
 * proves PA's locked receipt absence; it is not an acknowledgement or retry. */
export async function reconcileProjectAlphaDirectoryBindingRevisionRefreshCommand(inputConnection:ProjectAlphaApiV2Connection,kind:ProjectAlphaDirectoryBindingRevisionRefreshKind,
  inputCommand:ProjectAlphaDirectoryBindingRevisionRefreshCommand,requestSha256:string,send:typeof fetch=fetch):Promise<ProjectAlphaDirectoryBindingRevisionRefreshReconciliationOutcome>{
  let command:ProjectAlphaDirectoryBindingRevisionRefreshCommand,connection:ProjectAlphaApiV2Connection,body:string;
  try{
    // PA's PHP canonical JSON escapes U+2028/U+2029 while JSON.stringify does
    // not. Historical local hashes are immutable, so recovery is deliberately
    // ineligible for those external IDs instead of silently comparing unlike hashes.
    if((kind!=='client'&&kind!=='organization')||!isProjectAlphaDirectoryBindingRevisionRefreshCommand(inputCommand)
      ||/[\u2028\u2029]/u.test(inputCommand.externalId)||!/^[0-9a-f]{64}$/.test(requestSha256))return{status:'rejected',reason:'invalid_command'};
    body=JSON.stringify(inputCommand);if(new TextEncoder().encode(body).byteLength>REQUEST_LIMIT)return{status:'rejected',reason:'request_limit'};
    command=JSON.parse(body) as ProjectAlphaDirectoryBindingRevisionRefreshCommand;if(!isProjectAlphaDirectoryBindingRevisionRefreshCommand(command))return{status:'rejected',reason:'invalid_command'};
    connection={...inputConnection,expectedSourceInstanceId:inputConnection.expectedSourceInstanceId.toLowerCase(),expectedApplicationId:inputConnection.expectedApplicationId.toLowerCase()};
    if(typeof connection.expectedHistoryEpoch!=='string'||!UUID.test(connection.expectedHistoryEpoch))return{status:'blocked',reason:'preflight',preflight:{status:'misconfigured',reason:'configuration'}};
  }catch{return{status:'rejected',reason:'invalid_command'};}
  const preflight=await preflightProjectAlphaDirectoryBindingRevisionRefreshReconciliation(connection,kind,send);if(preflight.status!=='verified')return{status:'blocked',reason:'preflight',preflight};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10_000);let response:Response|undefined;
  try{
    const headers=new Headers({Accept:'application/json','Content-Type':'application/json; charset=utf-8',Authorization:`Bearer ${connection.apiKey}`,'X-PA-Source-Instance-ID':connection.expectedSourceInstanceId,'X-PA-Application-ID':connection.expectedApplicationId,'X-PA-History-Epoch':connection.expectedHistoryEpoch});
    if(connection.accessClientId&&connection.accessClientSecret){headers.set('CF-Access-Client-Id',connection.accessClientId);headers.set('CF-Access-Client-Secret',connection.accessClientSecret);}
    response=await send(new URL(reconciliationEndpoint(kind).path,connection.baseUrl),{method:'POST',headers,body,redirect:'manual',credentials:'omit',cache:'no-store',signal:controller.signal});
    const candidate=response.headers.get('X-Request-ID'),diagnostic={httpStatus:response.status,...(candidate&&UUID.test(candidate)?{requestId:candidate}:{})};
    if(response.redirected||(response.status>=300&&response.status<400)){await response.body?.cancel();return{status:'uncertain',reason:'invalid_contract',...diagnostic};}
    if(response.status!==200){await response.body?.cancel();return{status:response.status>=500||response.status<400?'uncertain':response.status===409?'conflict':[400,413,415].includes(response.status)?'rejected':'blocked',reason:'http_status',...diagnostic};}
    if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')??'')||!(response.headers.get('Cache-Control')??'').split(',').some(part=>part.trim().toLowerCase()==='no-store')||response.headers.has('Set-Cookie')||response.headers.has('Location')){await response.body?.cancel();return{status:'uncertain',reason:'invalid_contract',...diagnostic};}
    const parsed=await boundedJson(response);if(!reconciliation(parsed,kind,command,requestSha256,connection,candidate))return{status:'uncertain',reason:'invalid_contract',...diagnostic};
    const result:ProjectAlphaDirectoryBindingRevisionRefreshReconciliationOutcome={status:'reconciled',httpStatus:200,response:parsed};
    validatedReconciliations.set(result,Object.freeze({commandJson:body,responseJson:JSON.stringify(parsed),destinationOrigin:new URL(connection.baseUrl).origin}));return result;
  }catch(error){if(controller.signal.aborted)return{status:'uncertain',reason:'timeout'};if(error instanceof Error&&error.message==='response_limit')return{status:'uncertain',reason:'response_limit'};if(error instanceof Error&&error.message==='transport')return{status:'uncertain',reason:'transport'};return{status:'uncertain',reason:response?'invalid_contract':'transport'};}
  finally{clearTimeout(timer);}
}

/** One bounded, default-off transport attempt. It neither stores a receipt nor changes local mappings, links, or authority. */
export async function sendProjectAlphaDirectoryBindingRevisionRefreshCommand(inputConnection: ProjectAlphaApiV2Connection, kind: ProjectAlphaDirectoryBindingRevisionRefreshKind, inputCommand: ProjectAlphaDirectoryBindingRevisionRefreshCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryBindingRevisionRefreshOutcome> {
  let command: ProjectAlphaDirectoryBindingRevisionRefreshCommand, connection: ProjectAlphaApiV2Connection, body: string;
  try {
    if ((kind !== "client" && kind !== "organization") || !isProjectAlphaDirectoryBindingRevisionRefreshCommand(inputCommand)) return { status: "rejected", reason: "invalid_command" };
    body = JSON.stringify(inputCommand); if (new TextEncoder().encode(body).byteLength > REQUEST_LIMIT) return { status: "rejected", reason: "request_limit" };
    command = JSON.parse(body) as ProjectAlphaDirectoryBindingRevisionRefreshCommand; if (!isProjectAlphaDirectoryBindingRevisionRefreshCommand(command)) return { status: "rejected", reason: "invalid_command" };
    connection = { ...inputConnection, expectedSourceInstanceId: inputConnection.expectedSourceInstanceId.toLowerCase(), expectedApplicationId: inputConnection.expectedApplicationId.toLowerCase() };
    if (typeof connection.expectedHistoryEpoch !== "string" || !UUID.test(connection.expectedHistoryEpoch)) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  } catch { return { status: "rejected", reason: "invalid_command" }; }
  const preflight = await preflightProjectAlphaDirectoryBindingRevisionRefresh(connection, kind, send); if (preflight.status !== "verified") return { status: "blocked", reason: "preflight", preflight };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000); let response: Response | undefined;
  try {
    const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${connection.apiKey}`, "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId, "X-PA-Application-ID": connection.expectedApplicationId, "X-PA-History-Epoch": connection.expectedHistoryEpoch });
    if (connection.accessClientId && connection.accessClientSecret) { headers.set("CF-Access-Client-Id", connection.accessClientId); headers.set("CF-Access-Client-Secret", connection.accessClientSecret); }
    response = await send(new URL(endpoint(kind).path, connection.baseUrl), { method: "POST", headers, body, redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
    const candidate = response.headers.get("X-Request-ID"), diagnostic = { httpStatus: response.status, ...(candidate && UUID.test(candidate) ? { requestId: candidate } : {}) };
    if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...diagnostic }; }
    if (response.status !== 200) { await response.body?.cancel(); return { status: response.status >= 500 || response.status < 400 ? "uncertain" : response.status === 409 ? "conflict" : [400, 413, 415].includes(response.status) ? "rejected" : "blocked", reason: "http_status", ...diagnostic }; }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "") || !(response.headers.get("Cache-Control") ?? "").split(",").some(part => part.trim().toLowerCase() === "no-store") || response.headers.has("Set-Cookie") || response.headers.has("Location")) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...diagnostic }; }
    const parsed = await boundedJson(response); if (!success(parsed, kind, command, connection, candidate)) return { status: "uncertain", reason: "invalid_contract", ...diagnostic };
    const acknowledged: ProjectAlphaDirectoryBindingRevisionRefreshOutcome = { status: "acknowledged", httpStatus: 200, response: parsed };
    // Store detached evidence so mutations of the returned public result do
    // not change what a future ledger settlement can authenticate.
    validatedAcknowledgements.set(acknowledged, Object.freeze({ commandJson: body, responseJson: JSON.stringify(parsed), destinationOrigin: new URL(connection.baseUrl).origin }));
    return acknowledged;
  } catch (error) { if (controller.signal.aborted) return { status: "uncertain", reason: "timeout" }; if (error instanceof Error && error.message === "response_limit") return { status: "uncertain", reason: "response_limit" }; if (error instanceof Error && error.message === "transport") return { status: "uncertain", reason: "transport" }; return { status: "uncertain", reason: response ? "invalid_contract" : "transport" }; }
  finally { clearTimeout(timer); }
}
