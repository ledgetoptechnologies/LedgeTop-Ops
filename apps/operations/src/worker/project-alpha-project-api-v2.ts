import {
  authHeaders, advances, boundedJson, boundedJsonWithBytes, canonicalConnection, decimal, endpoint, externalId, exact, get, hash, isFailure, post, preflightFailure, profile, publicId, relation, runPreflight, trusted, uuid,
  PROJECT_ALPHA_PROJECT_CONFLICT_CODES, PROJECT_ALPHA_PROJECT_REQUEST_LIMIT, type ProjectAlphaProjectConflictCode, type ProjectAlphaProjectFailure, type ProjectAlphaProjectProfile, type ProjectAlphaProjectRelationProof,
} from "./project-alpha-project-transport";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection, ProjectAlphaApiV2Endpoint } from "./project-alpha-api-v2";

export type ProjectAlphaProjectCreateCommand = Readonly<{ commandId: string; externalId: string; expectedAuthorizationGeneration: string; project: ProjectAlphaProjectProfile; organization: ProjectAlphaProjectRelationProof; client: ProjectAlphaProjectRelationProof | null }>;
export type ProjectAlphaProjectUpdateCommand = Readonly<{ commandId: string; externalId: string; expectedRevision: string; expectedProjectionSha256: string; expectedAuthorizationGeneration: string; project: ProjectAlphaProjectProfile }>;
export type ProjectAlphaProjectBindCommand = Readonly<{ commandId: string; externalId: string; expectedPublicId: string; expectedRevision: string; expectedProjectionSha256: string; expectedAuthorizationGeneration: string }>;
export type ProjectAlphaProjectRefreshCommand = Readonly<{ commandId: string; externalId: string; expectedPublicId: string; expectedPriorRevision: string; expectedRevision: string; expectedProjectionSha256: string; expectedAuthorizationGeneration: string }>;
export type ProjectAlphaProjectCommand = ProjectAlphaProjectCreateCommand | ProjectAlphaProjectUpdateCommand | ProjectAlphaProjectBindCommand | ProjectAlphaProjectRefreshCommand;
export type ProjectAlphaProjectCommandType = "create" | "update" | "bind" | "refresh";
export type ProjectAlphaProjectSuccess = Readonly<{ apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string; replayed: boolean; result: Readonly<{ resource: Readonly<{ type: "project"; id: string; publicId: string; revision: string; projectionSha256: string }>; authorizationGeneration: string; presentation: Readonly<{ portalPublished: boolean; publicLinkEnabled: boolean }> }> }>;
export type ProjectAlphaProjectOutcome = Readonly<{ status: "acknowledged"; httpStatus: 200 | 201; response: ProjectAlphaProjectSuccess }> | ProjectAlphaProjectFailure;
export type ValidatedProjectAlphaProjectAcknowledgement = Readonly<{
  type: ProjectAlphaProjectCommandType;
  command: ProjectAlphaProjectCommand;
  response: ProjectAlphaProjectSuccess;
  destinationOrigin: string;
  requestSha256: string;
  responseSha256: string;
}>;

// Only the bounded transport can mint settlement evidence. A JSON-shaped
// acknowledgement supplied by a caller cannot be used to authorize D1 state.
const validatedAcknowledgements = new WeakMap<object, Readonly<{
  type: ProjectAlphaProjectCommandType;
  commandJson: string;
  responseJson: string;
  destinationOrigin: string;
  requestSha256: string;
  responseSha256: string;
}>>();
const settlementEvidence = new WeakSet<object>();

function deepFreezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // `slice` gives Web Crypto an exact, non-shared view even under newer TS
  // typed-array generics where Uint8Array may be backed by SharedArrayBuffer.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function validatedProjectAlphaProjectAcknowledgement(
  outcome: ProjectAlphaProjectOutcome,
): ValidatedProjectAlphaProjectAcknowledgement | null {
  if (!outcome || typeof outcome !== "object") return null;
  const snapshot = validatedAcknowledgements.get(outcome);
  if (!snapshot) return null;
  const evidence: ValidatedProjectAlphaProjectAcknowledgement = Object.freeze({
    type: snapshot.type,
    command: deepFreezeJson(JSON.parse(snapshot.commandJson) as ProjectAlphaProjectCommand),
    response: deepFreezeJson(JSON.parse(snapshot.responseJson) as ProjectAlphaProjectSuccess),
    destinationOrigin: snapshot.destinationOrigin,
    requestSha256: snapshot.requestSha256,
    responseSha256: snapshot.responseSha256,
  });
  settlementEvidence.add(evidence);
  return evidence;
}

/** Private handoff for the unmounted settlement adapter.  A structural clone
 * of the public evidence deliberately fails this identity check. */
export function privateProjectAlphaProjectSettlementEvidence(value: unknown): ValidatedProjectAlphaProjectAcknowledgement | null {
  return !!value && typeof value === "object" && settlementEvidence.has(value) ? value as ValidatedProjectAlphaProjectAcknowledgement : null;
}

const routes: Record<ProjectAlphaProjectCommandType, ProjectAlphaApiV2Endpoint> = {
  create: endpoint("POST", "/api/v2/projects/commands", "projects.create"),
  update: endpoint("POST", "/api/v2/projects/profile/commands", "projects.write"),
  bind: endpoint("POST", "/api/v2/projects/bindings/commands", "projects.bind"),
  refresh: endpoint("POST", "/api/v2/projects/bindings/revisions/commands", "projects.binding.revision.refresh"),
};
function validBase(value: unknown, fields: readonly string[]): value is Record<string, unknown> { return !!value && plain(value) && exact(value, fields) && uuid(value.commandId) && externalId(value.externalId) && decimal(value.expectedAuthorizationGeneration); }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && "value" in Object.getOwnPropertyDescriptor(value, key)!); }
function canonicalProject(value: ProjectAlphaProjectProfile): ProjectAlphaProjectProfile { return { name: value.name, description: value.description, estimatedStart: value.estimatedStart, estimatedEnd: value.estimatedEnd }; }
function canonicalRelation(value: ProjectAlphaProjectRelationProof | null): ProjectAlphaProjectRelationProof | null { return value === null ? null : { externalId: value.externalId, expectedPublicId: value.expectedPublicId, expectedRevision: value.expectedRevision, expectedProjectionSha256: value.expectedProjectionSha256 }; }
function canonicalCommand(type: ProjectAlphaProjectCommandType, value: ProjectAlphaProjectCommand): ProjectAlphaProjectCommand {
  if (type === "create") { const command = value as ProjectAlphaProjectCreateCommand; return { commandId: command.commandId, externalId: command.externalId, expectedAuthorizationGeneration: command.expectedAuthorizationGeneration, project: canonicalProject(command.project), organization: canonicalRelation(command.organization)!, client: canonicalRelation(command.client) }; }
  if (type === "update") { const command = value as ProjectAlphaProjectUpdateCommand; return { commandId: command.commandId, externalId: command.externalId, expectedRevision: command.expectedRevision, expectedProjectionSha256: command.expectedProjectionSha256, expectedAuthorizationGeneration: command.expectedAuthorizationGeneration, project: canonicalProject(command.project) }; }
  if (type === "bind") { const command = value as ProjectAlphaProjectBindCommand; return { commandId: command.commandId, externalId: command.externalId, expectedPublicId: command.expectedPublicId, expectedRevision: command.expectedRevision, expectedProjectionSha256: command.expectedProjectionSha256, expectedAuthorizationGeneration: command.expectedAuthorizationGeneration }; }
  const command = value as ProjectAlphaProjectRefreshCommand; return { commandId: command.commandId, externalId: command.externalId, expectedPublicId: command.expectedPublicId, expectedPriorRevision: command.expectedPriorRevision, expectedRevision: command.expectedRevision, expectedProjectionSha256: command.expectedProjectionSha256, expectedAuthorizationGeneration: command.expectedAuthorizationGeneration };
}
/** The one canonical JSON form used for both PA dispatch and the durable v2
 * request fingerprint.  This contains no connection secrets. */
export function canonicalProjectAlphaProjectRequest(type: ProjectAlphaProjectCommandType, value: unknown): Readonly<{ command: ProjectAlphaProjectCommand; body: string }> | null {
  if (!isProjectAlphaProjectCommand(type, value)) return null;
  try {
    const command = canonicalCommand(type, value), body = JSON.stringify(command);
    return new TextEncoder().encode(body).byteLength <= PROJECT_ALPHA_PROJECT_REQUEST_LIMIT
      && isProjectAlphaProjectCommand(type, JSON.parse(body)) ? Object.freeze({ command, body }) : null;
  } catch { return null; }
}
export function isProjectAlphaProjectCreateCommand(value: unknown): value is ProjectAlphaProjectCreateCommand {
  return validBase(value, ["commandId", "externalId", "expectedAuthorizationGeneration", "project", "organization", "client"]) && profile(value.project) && relation(value.organization, true) && relation(value.client, false);
}
export function isProjectAlphaProjectUpdateCommand(value: unknown): value is ProjectAlphaProjectUpdateCommand {
  return validBase(value, ["commandId", "externalId", "expectedRevision", "expectedProjectionSha256", "expectedAuthorizationGeneration", "project"])
    && decimal(value.expectedRevision, true) && hash(value.expectedProjectionSha256) && profile(value.project);
}
export function isProjectAlphaProjectBindCommand(value: unknown): value is ProjectAlphaProjectBindCommand {
  return validBase(value, ["commandId", "externalId", "expectedPublicId", "expectedRevision", "expectedProjectionSha256", "expectedAuthorizationGeneration"])
    && publicId(value.expectedPublicId) && decimal(value.expectedRevision, true) && hash(value.expectedProjectionSha256);
}
export function isProjectAlphaProjectRefreshCommand(value: unknown): value is ProjectAlphaProjectRefreshCommand {
  return validBase(value, ["commandId", "externalId", "expectedPublicId", "expectedPriorRevision", "expectedRevision", "expectedProjectionSha256", "expectedAuthorizationGeneration"])
    && publicId(value.expectedPublicId) && decimal(value.expectedPriorRevision, true) && decimal(value.expectedRevision, true)
    && advances(value.expectedRevision, value.expectedPriorRevision) && hash(value.expectedProjectionSha256);
}
export function isProjectAlphaProjectCommand(type: ProjectAlphaProjectCommandType, value: unknown): value is ProjectAlphaProjectCommand {
  return type === "create" ? isProjectAlphaProjectCreateCommand(value) : type === "update" ? isProjectAlphaProjectUpdateCommand(value) : type === "bind" ? isProjectAlphaProjectBindCommand(value) : isProjectAlphaProjectRefreshCommand(value);
}
function success(value: unknown, type: ProjectAlphaProjectCommandType, command: ProjectAlphaProjectCommand, connection: ProjectAlphaApiV2Connection, status: number, requestId: string | null): value is ProjectAlphaProjectSuccess {
  if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"]) || value.apiVersion !== "2" || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId || typeof value.replayed !== "boolean" || (status !== (type === "create" ? 201 : 200)) || !plain(value.result) || !exact(value.result, ["resource", "authorizationGeneration", "presentation"])) return false;
  const resource = value.result.resource, presentation = value.result.presentation;
  if (!plain(resource) || !exact(resource, ["type", "id", "publicId", "revision", "projectionSha256"]) || resource.type !== "project" || resource.id !== command.externalId || !publicId(resource.publicId) || !decimal(resource.revision, true) || !hash(resource.projectionSha256) || !decimal(value.result.authorizationGeneration) || !plain(presentation) || !exact(presentation, ["portalPublished", "publicLinkEnabled"]) || typeof presentation.portalPublished !== "boolean" || typeof presentation.publicLinkEnabled !== "boolean") return false;
  // A generic create command must never make a project client-visible as an
  // incidental synchronization side effect. Existing projects may already be
  // published when they are bound, updated, or refreshed, so this dark-create
  // fence is intentionally limited to the create acknowledgement.
  if (type === "create" && (presentation.portalPublished || presentation.publicLinkEnabled)) return false;
  const incremented = (value: string): string | null => { if (value === "9223372036854775807") return null; const digits = value.split(""); let carry = 1; for (let i = digits.length - 1; i >= 0 && carry; i--) { const n = digits[i]!.charCodeAt(0) - 48 + carry; digits[i] = String(n % 10); carry = n === 10 ? 1 : 0; } return (carry ? "1" : "") + digits.join(""); };
  if (type === "bind") { const expected = command as ProjectAlphaProjectBindCommand; return resource.publicId === expected.expectedPublicId && resource.revision === expected.expectedRevision && resource.projectionSha256 === expected.expectedProjectionSha256 && value.result.authorizationGeneration === incremented(expected.expectedAuthorizationGeneration); }
  if (type === "refresh") { const expected = command as ProjectAlphaProjectRefreshCommand; return resource.publicId === expected.expectedPublicId && resource.revision === expected.expectedRevision && resource.projectionSha256 === expected.expectedProjectionSha256 && value.result.authorizationGeneration === incremented(expected.expectedAuthorizationGeneration); }
  if (type === "update") { const expected = command as ProjectAlphaProjectUpdateCommand; return value.result.authorizationGeneration === expected.expectedAuthorizationGeneration && (resource.revision.length > expected.expectedRevision.length || (resource.revision.length === expected.expectedRevision.length && resource.revision >= expected.expectedRevision)); }
  return value.result.authorizationGeneration === incremented((command as ProjectAlphaProjectCreateCommand).expectedAuthorizationGeneration);
}
function conflictCode(value: unknown): value is ProjectAlphaProjectConflictCode {
  return typeof value === "string" && (PROJECT_ALPHA_PROJECT_CONFLICT_CODES as readonly string[]).includes(value);
}
/**
 * A 409 is terminal only when PA proves it is describing this connection and
 * this response. Identity conflicts are intentionally usable before PA can
 * echo a verified identity; every other conflict must carry all three echoed
 * identity fields. No remote body is retained after this check.
 */
function conflict(value: unknown, connection: ProjectAlphaApiV2Connection, requestId: string | null): ProjectAlphaProjectConflictCode | null {
  if (!plain(value) || value.apiVersion !== "2" || !uuid(value.requestId) || value.requestId !== requestId
    || !plain(value.error) || !exact(value.error, ["code"]) || !conflictCode(value.error.code)) return null;
  const hasIdentity = ["sourceInstanceId", "applicationId", "historyEpoch"].every(field => Object.hasOwn(value, field));
  const base = exact(value, ["apiVersion", "requestId", "error"]);
  const verified = exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "error"])
    && value.sourceInstanceId === connection.expectedSourceInstanceId
    && value.applicationId === connection.expectedApplicationId
    && value.historyEpoch === connection.expectedHistoryEpoch;
  if (value.error.code === "identity_conflict") return base || (hasIdentity && verified) ? value.error.code : null;
  return hasIdentity && verified ? value.error.code : null;
}
export function isProjectAlphaProjectAcknowledgement(type: ProjectAlphaProjectCommandType, value: unknown, command: ProjectAlphaProjectCommand, connection: ProjectAlphaApiV2Connection): value is Extract<ProjectAlphaProjectOutcome, { status: "acknowledged" }> {
  return plain(value) && exact(value, ["status", "httpStatus", "response"]) && value.status === "acknowledged" && (value.httpStatus === 200 || value.httpStatus === 201) && plain(value.response) && typeof value.response.requestId === "string" && success(value.response, type, command, connection, value.httpStatus, value.response.requestId);
}
export function isProjectAlphaProjectBindingAcknowledgement(value: unknown, command: ProjectAlphaProjectBindCommand, connection: ProjectAlphaApiV2Connection): boolean { return isProjectAlphaProjectAcknowledgement("bind", value, command, connection); }
export function isProjectAlphaProjectRefreshAcknowledgement(value: unknown, command: ProjectAlphaProjectRefreshCommand, connection: ProjectAlphaApiV2Connection): boolean { return isProjectAlphaProjectAcknowledgement("refresh", value, command, connection); }
async function send(type: ProjectAlphaProjectCommandType, inputConnection: ProjectAlphaApiV2Connection, inputCommand: ProjectAlphaProjectCommand, fetcher: typeof fetch): Promise<ProjectAlphaProjectOutcome> {
  const connection = canonicalConnection(inputConnection);
  if (!connection || !isProjectAlphaProjectCommand(type, inputCommand)) return { status: "rejected", reason: "invalid_command" };
  const canonical = canonicalProjectAlphaProjectRequest(type, inputCommand);
  if (!canonical) return { status: "rejected", reason: "invalid_command" };
  const { body } = canonical; const command = canonical.command;
  const preflight = await runPreflight(connection, routes[type], fetcher); if (preflight) return preflight;
  const response = await post(connection, routes[type], body, fetcher, type === "create" ? [201, 200, 409] : [200, 409]);
  if (isFailure(response)) return response;
  try {
    const decoded = await boundedJsonWithBytes(response), parsed = decoded.value;
    if (response.status === 409) {
      const reason = conflict(parsed, connection, response.headers.get("X-Request-ID"));
      return reason ? { status: "conflict", reason, httpStatus: 409, requestId: response.headers.get("X-Request-ID")! }
        : { status: "uncertain", reason: "invalid_contract", ...diagnostic(response) };
    }
    if (!success(parsed, type, command, connection, response.status, response.headers.get("X-Request-ID")))
      return { status: "uncertain", reason: "invalid_contract", ...diagnostic(response) };
    const acknowledged: ProjectAlphaProjectOutcome = {
      status: "acknowledged",
      httpStatus: response.status as 200 | 201,
      response: parsed,
    };
    validatedAcknowledgements.set(acknowledged, Object.freeze({
      type,
      commandJson: body,
      responseJson: JSON.stringify(parsed),
      destinationOrigin: new URL(connection.baseUrl).origin,
      requestSha256: await sha256(new TextEncoder().encode(body)),
      responseSha256: await sha256(decoded.bytes),
    }));
    return acknowledged;
  }
  catch (error) {
    // A 409 body is a narrow typed contract. Oversize and read/parse failures
    // cannot safely be treated as a meaningful conflict.
    if (response.status === 409) return { status: "uncertain", reason: "invalid_contract", ...diagnostic(response) };
    return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...diagnostic(response) };
  }
}
function diagnostic(response: Response): { httpStatus: number; requestId?: string } { const value = response.headers.get("X-Request-ID"); return { httpStatus: response.status, ...(value && uuid(value) ? { requestId: value } : {}) }; }
export function sendProjectAlphaProjectCreateCommand(connection: ProjectAlphaApiV2Connection, command: ProjectAlphaProjectCreateCommand, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectOutcome> { return send("create", connection, command, fetcher); }
export function sendProjectAlphaProjectUpdateCommand(connection: ProjectAlphaApiV2Connection, command: ProjectAlphaProjectUpdateCommand, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectOutcome> { return send("update", connection, command, fetcher); }
export function sendProjectAlphaProjectBindingCommand(connection: ProjectAlphaApiV2Connection, command: ProjectAlphaProjectBindCommand, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectOutcome> { return send("bind", connection, command, fetcher); }
export function sendProjectAlphaProjectRefreshCommand(connection: ProjectAlphaApiV2Connection, command: ProjectAlphaProjectRefreshCommand, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectOutcome> { return send("refresh", connection, command, fetcher); }
type ConfiguredOutcome = ProjectAlphaProjectOutcome | Readonly<{ status: "disabled"; sourceId: string }>;
async function configured<T extends ProjectAlphaProjectCommand>(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, type: ProjectAlphaProjectCommandType, command: T, fetcher: typeof fetch): Promise<ConfiguredOutcome> { const value = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => send(type, connection, command, fetcher)); return value.status === "enabled" ? value.value : value.status === "disabled" ? value : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } }; }
export const sendConfiguredProjectAlphaProjectCreateCommand = (env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, command: ProjectAlphaProjectCreateCommand, fetcher?: typeof fetch) => configured(env, sourceId, "create", command, fetcher ?? fetch);
export const sendConfiguredProjectAlphaProjectUpdateCommand = (env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, command: ProjectAlphaProjectUpdateCommand, fetcher?: typeof fetch) => configured(env, sourceId, "update", command, fetcher ?? fetch);
export const sendConfiguredProjectAlphaProjectBindingCommand = (env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, command: ProjectAlphaProjectBindCommand, fetcher?: typeof fetch) => configured(env, sourceId, "bind", command, fetcher ?? fetch);
export const sendConfiguredProjectAlphaProjectRefreshCommand = (env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, command: ProjectAlphaProjectRefreshCommand, fetcher?: typeof fetch) => configured(env, sourceId, "refresh", command, fetcher ?? fetch);
