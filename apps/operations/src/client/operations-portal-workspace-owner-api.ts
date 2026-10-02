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
