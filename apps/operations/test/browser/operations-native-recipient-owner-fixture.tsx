import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "../../src/client/styles.css";
import { OperationsNativeRecipientEnrollment } from "../../src/client/OperationsNativeRecipientEnrollment";

type Call = { path: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
const exposed = window as Window & { nativeRecipientCalls?: Call[]; nativeRecipientMode?: string };
exposed.nativeRecipientCalls = calls;
const mode = exposed.nativeRecipientMode ?? "success";
const intentId = "22222222-2222-4222-8222-222222222222";
const targetId = "11111111-1111-4111-8111-111111111111";
const bindingId = "44444444-4444-4444-8444-444444444444";
const recoveryOperationId = "33333333-3333-4333-8333-333333333333";
const principal = { issuer: "https://client.cloudflareaccess.com", subject: "access|recipient" };
const home = ["operations.service_home.read"], both = ["operations.request.create", "operations.service_home.read"];
// Requested scope plus where it stands: nothing is in effect until an owner confirms.
const homeAccess = { permissions: home, permissionSchemaVersion: 3, capabilityStatus: "not_requested", effectivePermissions: [] as string[] };
const requestAccess = { permissions: both, permissionSchemaVersion: 4, capabilityStatus: "pending", effectivePermissions: [] as string[] };
const requested = mode === "requests-pending" || mode === "requests-partial";
// What the server pins for the loaded intent; "access-missing" is a record that doesn't say.
const pinned: Record<string, unknown> = requested ? requestAccess : mode === "access-missing" ? {}
  : mode === "access-unknown" ? { ...requestAccess, permissions: ["operations.request.create"] }
  : mode === "access-overclaimed" ? { ...requestAccess, effectivePermissions: both } : homeAccess;
// After an acknowledged grant: the base home grant works, and the request capability once its own receipt closes.
const granted = !requested ? { effectivePermissions: home } : mode === "requests-partial"
  ? { capabilityStatus: "pending", effectivePermissions: home } : { capabilityStatus: "active", effectivePermissions: both };
const pending = { intentId, revision: 2, state: "pending", target: { targetId, targetRevision: 7, clientRecordId: "client:one" },
  principal, recipientLabel: "recipient@example.test", recipientBindingId: null as string | null,
  expiresAt: mode === "expired" ? "2020-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z", recoveryOperationId: null, ...pinned };
let current = mode === "load-recovery" ? { ...pending, revision: 3, state: "confirming",
  recipientBindingId: bindingId, recoveryOperationId } : pending;
let workspace = mode === "workspace-recovery"
  ? { targetId, state: "revoking", ownershipEpoch: 5, recoveryOperationId }
  : { targetId, state: "active", ownershipEpoch: 4, recoveryOperationId: null as string | null };
let confirmations = 0;
let issues = 0;
let workspaceRevocations = 0;

window.fetch = async (input, init = {}) => {
  const path = String(input), method = init.method ?? "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
  calls.push({ path, method, body });
  if (path.includes("/api/native-client-portal/recipient-enrollment"))
    return Response.json({ error: "legacy_forbidden" }, { status: 500 });
  if (path.endsWith("/session")) return Response.json({ csrfToken: `123.${"a".repeat(64)}`,
    verifiedUntil: "2099-01-01T00:00:00.000Z", recipientOrigin: "https://client-staging.example.test" });
  if (path.endsWith(`/intents/${intentId}`) && method === "GET") return Response.json({ intent: current });
  if (path.endsWith(`/workspaces/${targetId}`) && method === "GET") return Response.json({ workspace });
  if (path.endsWith(`/workspaces/${targetId}/revoke`) && method === "POST") {
    workspaceRevocations += 1;
    if (mode === "workspace-network-rejection" && workspaceRevocations === 1)
      throw new TypeError("simulated workspace network rejection");
    workspace = { targetId, state: mode === "workspace-pending" ? "revoking" : "revoked",
      ownershipEpoch: 5, recoveryOperationId: body!.operationId as string };
    return Response.json({ operationId: body!.operationId,
      status: mode === "workspace-pending" ? "pending" : "acknowledged", workspace,
      replayed: workspaceRevocations > 1 }, { status: mode === "workspace-pending" ? 202 : 200 });
  }
  if (path.endsWith(`/workspaces/${targetId}/recover`) && method === "POST") {
    workspace = { ...workspace, state: "revoked" };
    return Response.json({ operationId: body!.operationId, status: "acknowledged", workspace });
  }
  if (path.endsWith("/intents") && method === "POST") {
    issues += 1;
    if (mode === "issue-network-rejection" && issues === 1) throw new TypeError("simulated network rejection");
    const issuedIntentId = "55555555-5555-4555-8555-555555555555";
    const permissions = body!.permissions as string[], requests = permissions.includes("operations.request.create");
    if (mode === "issue-capability-unavailable" && requests)
      return Response.json({ error: "request_capability_unavailable" }, { status: 409 });
    const review = { intentId: issuedIntentId, revision: 1, state: "issued",
      target: { targetId: body!.targetId, targetRevision: 9, clientRecordId: body!.targetClientRecordId },
      principal: null, recipientLabel: `Recipient ${issuedIntentId.slice(0, 8)}`, recipientBindingId: null,
      expiresAt: body!.expiresAt, ...(requests && mode !== "issue-mismatch" ? requestAccess : homeAccess) };
    if (mode === "issue-network-rejection") return Response.json({ review, replayed: true });
    return Response.json({ review, opaqueToken: "b".repeat(64), replayed: false }, { status: 201 });
  }
  if (path.endsWith("/confirm")) {
    confirmations += 1;
    if (mode === "confirm-network-rejection" && confirmations === 1) throw new TypeError("simulated network rejection");
    if (mode === "confirm-uncertain" && confirmations === 1)
      return Response.json({ error: "unavailable" }, { status: 503 });
    if (mode === "confirm-denied") return Response.json({ error: "denied" }, { status: 403 });
    if (mode === "pending-recover") {
      current = { ...pending, revision: 3, state: "confirming", recipientBindingId: bindingId,
        recoveryOperationId: body!.operationId as string };
      return Response.json({ operationId: body!.operationId, status: "pending", intent: current, replayed: false }, { status: 202 });
    }
    current = { ...pending, revision: 4, state: "active", recipientBindingId: bindingId,
      recoveryOperationId: body!.operationId as string, ...granted };
    return Response.json({ operationId: body!.operationId, status: "acknowledged", intent: current,
      replayed: confirmations > 1 });
  }
  if (path.endsWith("/recover")) {
    current = { ...current, revision: Number(current.revision) + 1, state: current.state === "confirming" ? "active" : "revoked" };
    return Response.json({ operationId: body!.operationId, status: "acknowledged", intent: current });
  }
  if (path.endsWith("/cancel")) {
    current = { ...current, revision: Number(current.revision) + 1, state: "cancelled", recoveryOperationId: null };
    return Response.json({ review: current, replayed: false });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
};

createRoot(document.getElementById("root")!).render(<OperationsNativeRecipientEnrollment />);
