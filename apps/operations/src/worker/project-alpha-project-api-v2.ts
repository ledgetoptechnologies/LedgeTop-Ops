import {
  authHeaders, advances, boundedJson, canonicalConnection, decimal, endpoint, externalId, exact, get, hash, isFailure, post, preflightFailure, profile, publicId, relation, runPreflight, trusted, uuid,
  PROJECT_ALPHA_PROJECT_REQUEST_LIMIT, type ProjectAlphaProjectFailure, type ProjectAlphaProjectProfile, type ProjectAlphaProjectRelationProof,
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

const routes: Record<ProjectAlphaProjectCommandType, ProjectAlphaApiV2Endpoint> = {
  create: endpoint("POST", "/api/v2/projects/commands", "projects.create"),
  update: endpoint("POST", "/api/v2/projects/profile/commands", "projects.write"),
  bind: endpoint("POST", "/api/v2/projects/bindings/commands", "projects.bind"),
  refresh: endpoint("POST", "/api/v2/projects/bindings/revisions/commands", "projects.binding.revision.refresh"),
};
function validBase(value: unknown, fields: readonly string[]): value is Record<string, unknown> { return !!value && plain(value) && exact(value, fields) && uuid(value.commandId) && externalId(value.externalId) && decimal(value.expectedAuthorizationGeneration); }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && "value" in Object.getOwnPropertyDescriptor(value, key)!); }
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
  const incremented = (value: string): string | null => { if (value === "9223372036854775807") return null; const digits = value.split(""); let carry = 1; for (let i = digits.length - 1; i >= 0 && carry; i--) { const n = digits[i]!.charCodeAt(0) - 48 + carry; digits[i] = String(n % 10); carry = n === 10 ? 1 : 0; } return (carry ? "1" : "") + digits.join(""); };
  if (type === "bind") { const expected = command as ProjectAlphaProjectBindCommand; return resource.publicId === expected.expectedPublicId && resource.revision === expected.expectedRevision && resource.projectionSha256 === expected.expectedProjectionSha256 && value.result.authorizationGeneration === incremented(expected.expectedAuthorizationGeneration); }
  if (type === "refresh") { const expected = command as ProjectAlphaProjectRefreshCommand; return resource.publicId === expected.expectedPublicId && resource.revision === expected.expectedRevision && resource.projectionSha256 === expected.expectedProjectionSha256 && value.result.authorizationGeneration === incremented(expected.expectedAuthorizationGeneration); }
  if (type === "update") { const expected = command as ProjectAlphaProjectUpdateCommand; return value.result.authorizationGeneration === expected.expectedAuthorizationGeneration && (resource.revision.length > expected.expectedRevision.length || (resource.revision.length === expected.expectedRevision.length && resource.revision >= expected.expectedRevision)); }
  return value.result.authorizationGeneration === incremented((command as ProjectAlphaProjectCreateCommand).expectedAuthorizationGeneration);
}
export function isProjectAlphaProjectAcknowledgement(type: ProjectAlphaProjectCommandType, value: unknown, command: ProjectAlphaProjectCommand, connection: ProjectAlphaApiV2Connection): value is Extract<ProjectAlphaProjectOutcome, { status: "acknowledged" }> {
  return plain(value) && exact(value, ["status", "httpStatus", "response"]) && value.status === "acknowledged" && (value.httpStatus === 200 || value.httpStatus === 201) && plain(value.response) && typeof value.response.requestId === "string" && success(value.response, type, command, connection, value.httpStatus, value.response.requestId);
}
export function isProjectAlphaProjectBindingAcknowledgement(value: unknown, command: ProjectAlphaProjectBindCommand, connection: ProjectAlphaApiV2Connection): boolean { return isProjectAlphaProjectAcknowledgement("bind", value, command, connection); }
export function isProjectAlphaProjectRefreshAcknowledgement(value: unknown, command: ProjectAlphaProjectRefreshCommand, connection: ProjectAlphaApiV2Connection): boolean { return isProjectAlphaProjectAcknowledgement("refresh", value, command, connection); }
async function send(type: ProjectAlphaProjectCommandType, inputConnection: ProjectAlphaApiV2Connection, inputCommand: ProjectAlphaProjectCommand, fetcher: typeof fetch): Promise<ProjectAlphaProjectOutcome> {
  const connection = canonicalConnection(inputConnection);
  if (!connection || !isProjectAlphaProjectCommand(type, inputCommand)) return { status: "rejected", reason: "invalid_command" };
  let body: string; let command: ProjectAlphaProjectCommand;
  try { body = JSON.stringify(inputCommand); if (new TextEncoder().encode(body).byteLength > PROJECT_ALPHA_PROJECT_REQUEST_LIMIT) return { status: "rejected", reason: "request_limit" }; command = JSON.parse(body) as ProjectAlphaProjectCommand; if (!isProjectAlphaProjectCommand(type, command)) return { status: "rejected", reason: "invalid_command" }; }
  catch { return { status: "rejected", reason: "invalid_command" }; }
  const preflight = await runPreflight(connection, routes[type], fetcher); if (preflight) return preflight;
  const response = await post(connection, routes[type], body, fetcher, type === "create" ? [201, 200] : [200]);
  if (isFailure(response)) return response;
  try { const parsed = await boundedJson(response); return success(parsed, type, command, connection, response.status, response.headers.get("X-Request-ID")) ? { status: "acknowledged", httpStatus: response.status as 200 | 201, response: parsed } : { status: "uncertain", reason: "invalid_contract", ...diagnostic(response) }; }
  catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...diagnostic(response) }; }
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
