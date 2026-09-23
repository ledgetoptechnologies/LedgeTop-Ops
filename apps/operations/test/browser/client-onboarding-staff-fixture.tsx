import { createRoot } from "react-dom/client";
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
  if (mode === "uncertain") return new Response(JSON.stringify({ error: "client_onboarding_unavailable" }), { status: 503 });
  return Response.json({ commandId: body.commandId, invitationId: "11111111-1111-4111-8111-111111111111",
    expiresAt: "2099-01-01T00:00:00.000Z", invitationSecret: "d".repeat(64) });
};

createRoot(document.getElementById("root")!).render(<ClientOnboardingStaff />);
