import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "../../src/client/styles.css";
import { ClientOnboardingStaff } from "../../src/client/ClientOnboardingStaff";

const calls: Array<{ path: string; body: unknown }> = [];
(window as Window & { onboardingCalls?: typeof calls }).onboardingCalls = calls;
const mode = (window as Window & { onboardingMode?: string }).onboardingMode;
window.fetch = async (input, init) => {
  const path = String(input);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ path, body });
  if (path.endsWith("/session")) {
    if (mode === "disabled") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return Response.json({ csrfToken: "a".repeat(64), verifiedUntil: "2099-01-01T00:00:00.000Z" });
  }
  if (path.endsWith("/create")) return Response.json({ invitationId: "11111111-1111-4111-8111-111111111111",
    expiresAt: body.expiresAt, requestSha256: "c".repeat(64), state: "pending" });
  if (path.endsWith("/review")) return Response.json({
    invitationId: "11111111-1111-4111-8111-111111111111",
    submissionId: body.submissionId, fieldsSha256: "e".repeat(64),
    submittedAt: "2098-01-01T00:00:00.000Z", targetClientRecordId: null,
    scopes: [{ businessAreaId: "area:onboarding", divisionId: null }],
    fields: { clientType: mode === "business" ? "business" : "consumer", name: "Reviewed Client",
      email: "client@example.test", phone: "", organizationName: mode === "business" ? "Example LLC" : "",
      organizationEmail: "", organizationPhone: "", addressLine1: "1 Main", addressLine2: "",
      city: "Town", state: "TX", postalCode: "75001", country: "US" },
  });
  if (path.endsWith("/approve")) return Response.json({
    decisionId: "44444444-4444-4444-8444-444444444444", submissionId: body.submissionId,
    clientRecordId: "55555555-5555-4555-8555-555555555555", clientRecordVersion: 1,
    relationshipVersion: 1, replayed: false,
  });
  if (mode === "uncertain") return new Response(JSON.stringify({ error: "client_onboarding_unavailable" }), { status: 503 });
  return Response.json({ commandId: body.commandId, invitationId: "11111111-1111-4111-8111-111111111111",
    expiresAt: "2099-01-01T00:00:00.000Z", invitationSecret: "d".repeat(64) });
};

createRoot(document.getElementById("root")!).render(<ClientOnboardingStaff />);
