import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "../../src/client/styles.css";
import { OperationsNativeDeliveryAuthority } from "../../src/client/OperationsNativeDeliveryAuthority";

type Call = { path: string; method: string; body: Record<string, unknown> | null };
const exposed = window as Window & { nativeDeliveryMode?: string; nativeDeliveryCalls?: Call[] };
const mode = exposed.nativeDeliveryMode ?? "success", calls: Call[] = [];
exposed.nativeDeliveryCalls = calls;
const targetId = "11111111-1111-4111-8111-111111111111";
const recipientBindingId = "22222222-2222-4222-8222-222222222222";
const folderReservationId = "33333333-3333-4333-8333-333333333333";
const authorityId = "44444444-4444-4444-8444-444444444444";
const recoveryOperationId = "55555555-5555-4555-8555-555555555555";
const secondAuthorityId = "77777777-7777-4777-8777-777777777777";
const authorityCursor = `v1.authority_page.${"d".repeat(64)}`;
const candidate = { candidateFingerprint: "a".repeat(64), recipientBindingId,
  enrollmentIntentId: "66666666-6666-4666-8666-666666666666", targetId, targetRevision: 9,
  targetClientRecordId: "client:one", clientLabel: "Client One", recipientLabel: "Recipient One",
  workspaceId: "workspace:one", homeOwnershipEpoch: 3, homeGrantRevision: 4, publicationRevision: 5,
  folderReservationId, folderReservationRevision: 6, clientFolderBindingId: "folder-binding:one",
  externalProjectId: "project:one", projectLabel: "Project One", projectVersion: 7,
  opsFolderProjectId: "ops-project:one", folderLabel: "Folder One", opsDivisionId: "division:one" };
function active(operationId: string, transportStatus: "pending" | "acknowledged" | "dead" = "acknowledged",
  selectedAuthorityId = authorityId) {
  return { authorityId: selectedAuthorityId, revision: 1, state: "active", recipientBindingId, folderReservationId, targetId,
    enrollmentIntentId: candidate.enrollmentIntentId, targetClientRecordId: "client:one", workspaceId: "workspace:one",
    clientFolderBindingId: "folder-binding:one", externalProjectId: "project:one", opsFolderProjectId: "ops-project:one",
    opsDivisionId: "division:one", clientLabel: "Client One", recipientLabel: "Recipient One",
    projectLabel: "Project One", folderLabel: "Folder One",
    features: ["folder.list", "file.metadata"], expiresAt: "2099-01-01T00:00:00.000Z",
    latestOperationId: operationId, latestAction: "delivery.grant", transportStatus,
    recoveryOperationId: transportStatus === "pending" ? operationId : null };
}
let grantCalls = 0, revokeCalls = 0, candidateCalls = 0;

window.fetch = async (input, init = {}) => {
  const path = String(input), method = init.method ?? "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
  calls.push({ path, method, body });
  if (path.endsWith("/session")) return Response.json({ csrfToken: `123.${"b".repeat(64)}`,
    verifiedUntil: "2099-01-01T00:00:00.000Z" });
  if (path.includes("/candidates?")) {
    candidateCalls += 1;
    if (mode === "candidate-denied" || mode === "candidate-denied-after-first" && candidateCalls > 1)
      return new Response("denied", { status: 403, headers: { "Content-Type": "text/html" } });
    return Response.json({ items: [candidate], page: { nextCursor: null } });
  }
  if (path.includes("/authorities?")) {
    const paged = mode === "authority-pages", second = path.includes("cursor=");
    return Response.json({ items: [paged && second ? active(recoveryOperationId, "acknowledged", secondAuthorityId)
      : mode === "load-pending" ? active(recoveryOperationId, "pending")
        : mode === "load-dead" ? active(recoveryOperationId, "dead") : active(recoveryOperationId)],
    page: { nextCursor: paged && !second ? authorityCursor : null } });
  }
  if (path.endsWith(`/authorities/${authorityId}`) && method === "GET") {
    const authority = mode === "load-pending" ? active(recoveryOperationId, "pending")
      : mode === "load-dead" ? active(recoveryOperationId, "dead") : active(recoveryOperationId);
    return Response.json({ authority });
  }
  if (path.endsWith("/authorities") && method === "POST") {
    grantCalls += 1;
    if (mode === "grant-network" && grantCalls === 1) throw new TypeError("simulated network loss");
    if (mode === "candidate-stale") return Response.json({ error: "candidate_review_stale" }, { status: 409 });
    const pending = mode === "grant-pending";
    const authority = active(body!.operationId as string, pending ? "pending" : "acknowledged",
      body!.authorityId as string);
    authority.features = body!.features as string[]; authority.expiresAt = body!.expiresAt as string;
    return Response.json({ operationId: body!.operationId, status: pending ? "pending" : "acknowledged",
      authority, replayed: grantCalls > 1, recoveryOperationId: pending ? body!.operationId : null },
    { status: pending ? 202 : grantCalls > 1 ? 200 : 201 });
  }
  if (path.endsWith(`/authorities/${authorityId}/recover`) && method === "POST") {
    const authority = active(body!.operationId as string);
    return Response.json({ operationId: body!.operationId, status: "acknowledged", authority,
      replayed: false, recoveryOperationId: null });
  }
  if (path.endsWith(`/authorities/${authorityId}/revoke`) && method === "POST") {
    revokeCalls += 1;
    if (mode === "revoke-network" && revokeCalls === 1) throw new TypeError("simulated network loss");
    const authority = { ...active(recoveryOperationId), revision: 2, state: "revoked", features: [], expiresAt: null,
      latestOperationId: body!.operationId, latestAction: "delivery.revoke" };
    return Response.json({ operationId: body!.operationId, status: "acknowledged", authority,
      replayed: revokeCalls > 1, recoveryOperationId: null });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
};

createRoot(document.getElementById("root")!).render(<OperationsNativeDeliveryAuthority />);
