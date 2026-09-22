import {
  boundedJsonWithBytes, canonicalConnection, decimal, endpoint, exact, externalId, isFailure,
  plain, post, publicId, runPreflight, uuid,
  type ProjectAlphaProjectFailure,
} from "./project-alpha-project-transport";
import {
  withEnabledConfiguredProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2ConnectionEnvironment,
} from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection, ProjectAlphaApiV2Endpoint } from "./project-alpha-api-v2";

export type ProjectAlphaExistingDirectoryBindingKind = "client" | "organization";
export type ProjectAlphaExistingDirectoryBindingCommand = Readonly<{
  commandId: string;
  externalId: string;
  expectedPublicId: string;
  expectedRevision: string;
}>;
export type ProjectAlphaExistingDirectoryBindingSuccess = Readonly<{
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  replayed: boolean;
  result: Readonly<{
    binding: Readonly<{ publicId: string }>;
    resource: Readonly<{ type: ProjectAlphaExistingDirectoryBindingKind; id: string; revision: string }>;
  }>;
}>;
export type ProjectAlphaExistingDirectoryBindingOutcome =
  | Readonly<{ status: "acknowledged"; httpStatus: 200; response: ProjectAlphaExistingDirectoryBindingSuccess }>
  | ProjectAlphaProjectFailure;
export type ProjectAlphaExistingDirectoryBindingEvidence = Readonly<{
  kind: ProjectAlphaExistingDirectoryBindingKind;
  command: ProjectAlphaExistingDirectoryBindingCommand;
  response: ProjectAlphaExistingDirectoryBindingSuccess;
  destinationOrigin: string;
  requestSha256: string;
  responseSha256: string;
}>;

const validated = new WeakMap<object, Readonly<{
  kind: ProjectAlphaExistingDirectoryBindingKind;
  commandJson: string;
  responseJson: string;
  destinationOrigin: string;
  requestSha256: string;
  responseSha256: string;
}>>();

function route(kind: ProjectAlphaExistingDirectoryBindingKind): ProjectAlphaApiV2Endpoint {
  const plural = kind === "client" ? "clients" : "organizations";
  return endpoint("POST", `/api/v2/directory/${plural}/bindings/commands`, `directory.${plural}.bind`, {
    requiresExpectedPublicId: true,
    requiresExpectedRevision: true,
  });
}

function command(value: unknown): value is ProjectAlphaExistingDirectoryBindingCommand {
  return plain(value) && exact(value, ["commandId", "externalId", "expectedPublicId", "expectedRevision"])
    && uuid(value.commandId) && externalId(value.externalId) && publicId(value.expectedPublicId)
    && decimal(value.expectedRevision, true);
}

export function canonicalProjectAlphaExistingDirectoryBindingCommand(value: unknown): Readonly<{
  command: ProjectAlphaExistingDirectoryBindingCommand;
  body: string;
}> | null {
  if (!command(value)) return null;
  try {
    const canonical = Object.freeze({ commandId: value.commandId, externalId: value.externalId,
      expectedPublicId: value.expectedPublicId, expectedRevision: value.expectedRevision });
    const body = JSON.stringify(canonical);
    return new TextEncoder().encode(body).byteLength <= 32 * 1024
      ? Object.freeze({ command: canonical, body }) : null;
  } catch { return null; }
}

function success(value: unknown, kind: ProjectAlphaExistingDirectoryBindingKind,
  expected: ProjectAlphaExistingDirectoryBindingCommand, connection: ProjectAlphaApiV2Connection,
  requestId: string | null): value is ProjectAlphaExistingDirectoryBindingSuccess {
  if (!plain(value) || !exact(value, ["replayed", "result", "requestId", "sourceInstanceId", "historyEpoch", "applicationId"])
    || typeof value.replayed !== "boolean" || !uuid(value.requestId) || value.requestId !== requestId
    || value.sourceInstanceId !== connection.expectedSourceInstanceId
    || value.applicationId !== connection.expectedApplicationId
    || value.historyEpoch !== connection.expectedHistoryEpoch || !plain(value.result)
    || !exact(value.result, ["resource", "binding"])) return false;
  const resource = value.result.resource, binding = value.result.binding;
  return plain(resource) && exact(resource, ["type", "id", "revision"])
    && resource.type === kind && resource.id === expected.externalId && resource.revision === expected.expectedRevision
    && plain(binding) && exact(binding, ["publicId"]) && binding.publicId === expected.expectedPublicId;
}

function conflict(value: unknown, requestId: string | null): boolean {
  return plain(value) && exact(value, ["code", "requestId"]) && uuid(value.requestId)
    && value.requestId === requestId && typeof value.code === "string"
    && /^[A-Z][A-Z0-9_]{1,95}$/.test(value.code);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sendDirect(kind: ProjectAlphaExistingDirectoryBindingKind, inputConnection: ProjectAlphaApiV2Connection,
  input: unknown, fetcher: typeof fetch): Promise<ProjectAlphaExistingDirectoryBindingOutcome> {
  const connection = canonicalConnection(inputConnection), canonical = canonicalProjectAlphaExistingDirectoryBindingCommand(input);
  if (!connection || !canonical) return { status: "rejected", reason: "invalid_command" };
  const preflight = await runPreflight(connection, route(kind), fetcher);
  if (preflight) return preflight;
  const response = await post(connection, route(kind), canonical.body, fetcher, [200, 409]);
  if (isFailure(response)) return response;
  try {
    const decoded = await boundedJsonWithBytes(response), requestId = response.headers.get("X-Request-ID");
    if (response.status === 409) return conflict(decoded.value, requestId)
      ? { status: "conflict", reason: "http_status", httpStatus: 409, ...(requestId ? { requestId } : {}) }
      : { status: "uncertain", reason: "invalid_contract", httpStatus: 409 };
    if (!success(decoded.value, kind, canonical.command, connection, requestId))
      return { status: "uncertain", reason: "invalid_contract", httpStatus: 200 };
    const outcome: ProjectAlphaExistingDirectoryBindingOutcome = {
      status: "acknowledged", httpStatus: 200, response: decoded.value,
    };
    validated.set(outcome, Object.freeze({ kind, commandJson: canonical.body,
      responseJson: JSON.stringify(decoded.value), destinationOrigin: new URL(connection.baseUrl).origin,
      requestSha256: await sha256(new TextEncoder().encode(canonical.body)), responseSha256: await sha256(decoded.bytes) }));
    return outcome;
  } catch (error) {
    return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit"
      ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract",
      httpStatus: response.status };
  }
}

export async function sendConfiguredProjectAlphaExistingDirectoryBinding(
  env: ProjectAlphaApiV2ConnectionEnvironment,
  sourceId: string,
  kind: ProjectAlphaExistingDirectoryBindingKind,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<ProjectAlphaExistingDirectoryBindingOutcome> {
  if (kind !== "client" && kind !== "organization") return { status: "rejected", reason: "invalid_command" };
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId,
    connection => sendDirect(kind, connection, input, fetcher));
  if (configured.status === "enabled") return configured.value;
  return configured.status === "disabled"
    ? { status: "blocked", reason: "preflight" }
    : { status: "blocked", reason: "preflight" };
}

export function validatedProjectAlphaExistingDirectoryBindingEvidence(
  outcome: ProjectAlphaExistingDirectoryBindingOutcome,
): ProjectAlphaExistingDirectoryBindingEvidence | null {
  if (!outcome || typeof outcome !== "object") return null;
  const evidence = validated.get(outcome);
  if (!evidence) return null;
  return Object.freeze({ kind: evidence.kind,
    command: Object.freeze(JSON.parse(evidence.commandJson) as ProjectAlphaExistingDirectoryBindingCommand),
    response: Object.freeze(JSON.parse(evidence.responseJson) as ProjectAlphaExistingDirectoryBindingSuccess),
    destinationOrigin: evidence.destinationOrigin, requestSha256: evidence.requestSha256,
    responseSha256: evidence.responseSha256 });
}
