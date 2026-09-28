import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "../../src/client/styles.css";
import { ClientPortalRecipientEnrollment } from "../../src/client/ClientPortalRecipientEnrollment";

type Call = { path: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
(window as Window & { enrollmentCalls?: Call[] }).enrollmentCalls = calls;
const mode = (window as Window & { enrollmentMode?: string }).enrollmentMode;
const intentId = "22222222-2222-4222-8222-222222222222";
const selectionId = "11111111-1111-4111-8111-111111111111";
const baseReview = { intentId, revision: 2, state: "pending", target: { clientRecordId: "client:one", selectionId },
  principal: { issuer: "https://client.cloudflareaccess.com", subject: "access|recipient" }, expiresAt: "2099-01-01T00:00:00.000Z" };
const listingReview = mode === "cancel-issued" ? { ...baseReview, revision: 1, state: "issued", principal: null } : baseReview;
let currentReview = listingReview;
let confirmationAttempts = 0;
let issueAttempts = 0;
let cancellationAttempts = 0;
window.fetch = async (input, init = {}) => {
  const path = String(input), method = init.method ?? "GET", body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ path, method, body });
  if (path.endsWith("/session")) return Response.json({ csrfToken: "a".repeat(64), verifiedUntil: "2099-01-01T00:00:00.000Z",
    recipientOrigin: "https://client-staging.example.test" });
  if (path.endsWith("/intents") && method === "GET") return Response.json({ intents: [currentReview] });
  if (path.endsWith("/intents") && method === "POST") {
    issueAttempts += 1;
    if (mode === "issue-uncertain" && issueAttempts === 1) return Response.json({ error: "unavailable" }, { status: 503 });
    const issued = { intentId: "33333333-3333-4333-8333-333333333333", revision: 1, state: "issued",
      target: { clientRecordId: body.clientRecordId, selectionId: body.selectionId }, principal: null, expiresAt: body.expiresAt };
    if (mode === "issue-uncertain") return Response.json({ ...issued, replayed: true });
    return Response.json({ ...issued, opaqueToken: "b".repeat(64), replayed: false }, { status: 201 });
  }
  if (path.endsWith("/confirm")) {
    confirmationAttempts += 1;
    if (mode === "confirm-uncertain" && confirmationAttempts === 1) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ operationId: body.operationId, status: "acknowledged",
      intent: { ...baseReview, revision: 3, state: "active" }, replayed: confirmationAttempts > 1 });
  }
  if (path.endsWith("/cancel")) {
    cancellationAttempts += 1;
    if (mode === "cancel-uncertain" && cancellationAttempts === 1)
      return Response.json({ error: "unavailable" }, { status: 503 });
    if (mode === "cancel-denied" && cancellationAttempts === 1)
      return Response.json({ error: "forbidden" }, { status: 403 });
    const cancelled = { ...listingReview, revision: listingReview.revision + 1, state: "cancelled" };
    currentReview = cancelled;
    if (mode === "cancel-uncertain") return Response.json({
      operationId: body.operationId, status: "acknowledged", intent: null,
      receipt: { intentId, revision: cancelled.revision, state: "cancelled" }, replayed: true,
    });
    return Response.json({ operationId: body.operationId, status: "acknowledged",
      intent: cancelled, receipt: null, replayed: false });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
};
createRoot(document.getElementById("root")!).render(<ClientPortalRecipientEnrollment />);
