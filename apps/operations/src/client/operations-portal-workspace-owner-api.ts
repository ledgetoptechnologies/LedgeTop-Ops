const BASE = "/api/native-client-portal/operations-workspaces";
const headers = { "Content-Type": "application/json" };
async function value(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body
    && typeof body.error === "string" ? body.error : "request_failed");
  return body;
}
export async function operationsWorkspaceCsrf(): Promise<string> {
  const body = await value(await fetch(`${BASE}/csrf`, { credentials: "same-origin", cache: "no-store" }));
  if (!body || typeof body !== "object" || !("csrfToken" in body) || typeof body.csrfToken !== "string")
    throw new Error("invalid_response");
  return body.csrfToken;
}
export async function reserveAndPublishOperationsWorkspace(csrfToken: string, body: unknown) {
  const operationId = body && typeof body === "object" && "workspace" in body && body.workspace
    && typeof body.workspace === "object" && "operationId" in body.workspace ? body.workspace.operationId : null;
  if (typeof operationId !== "string") throw new Error("invalid_request");
  return value(await fetch(`${BASE}/reserve-and-publish`, { method: "POST", credentials: "same-origin", headers: {
    ...headers, "X-CSRF-Token": csrfToken, "Idempotency-Key": operationId,
  }, body: JSON.stringify(body) }));
}
export async function refreshAndPublishOperationsWorkspace(csrfToken: string, body: unknown) {
  const operationId = body && typeof body === "object" && "publication" in body && body.publication
    && typeof body.publication === "object" && "operationId" in body.publication ? body.publication.operationId : null;
  if (typeof operationId !== "string") throw new Error("invalid_request");
  return value(await fetch(`${BASE}/refresh-and-publish`, { method: "POST", credentials: "same-origin", headers: {
    ...headers, "X-CSRF-Token": csrfToken, "Idempotency-Key": operationId,
  }, body: JSON.stringify(body) }));
}
async function mutateFolder(csrfToken: string, path: "reserve-folder-and-publish" | "revoke-folder-and-publish",
  body: unknown) {
  const operationId = body && typeof body === "object" && "folder" in body && body.folder
    && typeof body.folder === "object" && "operationId" in body.folder ? body.folder.operationId : null;
  if (typeof operationId !== "string") throw new Error("invalid_request");
  return value(await fetch(`${BASE}/${path}`, { method: "POST", credentials: "same-origin", headers: {
    ...headers, "X-CSRF-Token": csrfToken, "Idempotency-Key": operationId,
  }, body: JSON.stringify(body) }));
}
export const reserveAndPublishOperationsFolder = (csrfToken: string, body: unknown) =>
  mutateFolder(csrfToken, "reserve-folder-and-publish", body);
export const revokeAndPublishOperationsFolder = (csrfToken: string, body: unknown) =>
  mutateFolder(csrfToken, "revoke-folder-and-publish", body);
export async function recoverOperationsWorkspacePublication(csrfToken: string, operationId: string, reason: string) {
  const invocationId = crypto.randomUUID();
  return value(await fetch(`${BASE}/recover-publication`, { method: "POST", credentials: "same-origin", headers: {
    ...headers, "X-CSRF-Token": csrfToken, "Idempotency-Key": invocationId,
  }, body: JSON.stringify({ operationId, invocationId, reason }) }));
}
import type { OperationsPortalSharedProjectFolder, ConfirmOperationsPortalSharedProjectFolder }
  from "../worker/operations-portal-shared-project-folders";

function projectFolderProof(body: unknown, targetId: string, externalProjectId: string): OperationsPortalSharedProjectFolder {
  if (!body || typeof body !== "object" || !("targetId" in body) || body.targetId !== targetId
    || !("externalProjectId" in body) || body.externalProjectId !== externalProjectId
    || !("projectName" in body) || typeof body.projectName !== "string"
    || !("projectVersion" in body) || typeof body.projectVersion !== "number" || !Number.isSafeInteger(body.projectVersion)
    || body.projectVersion < 1 || !("association" in body)) throw new Error("invalid_response");
  const raw = body.association;
  if (raw === null) return { targetId, externalProjectId, projectName: body.projectName, projectVersion: body.projectVersion, association: null };
  if (!raw || typeof raw !== "object" || !("opsFolderProjectId" in raw) || typeof raw.opsFolderProjectId !== "string"
    || !("opsDivisionId" in raw) || typeof raw.opsDivisionId !== "string"
    || !("baseR2Prefix" in raw) || typeof raw.baseR2Prefix !== "string"
    || !("baseMatchMethod" in raw) || (raw.baseMatchMethod !== "manual" && raw.baseMatchMethod !== "unique_rule" && raw.baseMatchMethod !== "project_alpha")
    || !("baseConfirmedBy" in raw) || typeof raw.baseConfirmedBy !== "string"
    || !("baseConfirmedAt" in raw) || typeof raw.baseConfirmedAt !== "string") throw new Error("invalid_response");
  return { targetId, externalProjectId, projectName: body.projectName, projectVersion: body.projectVersion,
    association: { opsFolderProjectId: raw.opsFolderProjectId, opsDivisionId: raw.opsDivisionId, baseR2Prefix: raw.baseR2Prefix,
      baseMatchMethod: raw.baseMatchMethod, baseConfirmedBy: raw.baseConfirmedBy, baseConfirmedAt: raw.baseConfirmedAt } };
}
export async function lookupOperationsProjectFolder(targetId: string, externalProjectId: string) {
  const query = new URLSearchParams({ targetId, externalProjectId });
  return projectFolderProof(await value(await fetch(`${BASE}/project-folder?${query}`, {
    credentials: "same-origin", cache: "no-store",
  })), targetId, externalProjectId);
}
export async function confirmOperationsProjectFolder(csrfToken: string, body: ConfirmOperationsPortalSharedProjectFolder) {
  return projectFolderProof(await value(await fetch(`${BASE}/confirm-project-folder`, { method: "POST", credentials: "same-origin",
    headers: { ...headers, "X-CSRF-Token": csrfToken }, body: JSON.stringify(body),
  })), body.targetId, body.externalProjectId);
}
