import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "../../src/client/styles.css";
import { ClientOnboardingStaff } from "../../src/client/ClientOnboardingStaff";

type Call = { path: string; body: unknown };
const calls: Call[] = [];
const fixtureWindow = window as Window & { onboardingCalls?: Call[]; onboardingMode?: string; copied?: string[]; opened?: string[]; release?: () => void };
fixtureWindow.onboardingCalls = calls;
fixtureWindow.copied = [];
fixtureWindow.opened = [];
const mode = fixtureWindow.onboardingMode ?? "success";
const consumerId = "33333333-3333-4333-8333-333333333333", businessId = "77777777-7777-4777-8777-777777777777";
const laterId = "88888888-8888-4888-8888-888888888888";
const invitationId = "11111111-1111-4111-8111-111111111111";
const primary = "project-alpha:primary", secondary = "project-alpha:secondary";
let approved = false, activationReads = 0, approvalAttempts = 0, sessionReads = 0, choiceReads = 0;
const denied = () => Response.json({ error: "client_onboarding_denied" }, { status: 403 });
// Delayed modes hold the write until the test calls window.release().
const held = () => new Promise<void>(resolve => { fixtureWindow.release = resolve; });

Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { fixtureWindow.copied!.push(value); } } });
window.open = ((url?: string | URL) => { fixtureWindow.opened!.push(String(url)); return null; }) as typeof window.open;

const fields = (business: boolean) => ({ clientType: business ? "business" : "consumer", name: business ? "Dana Business" : "Reviewed Client",
  email: "client@example.test", phone: "555-0100", organizationName: business ? "Example LLC" : "", organizationEmail: "",
  organizationPhone: "", addressLine1: "1 Main", addressLine2: "", city: "Town", state: "TX", postalCode: "75001", country: "US" });

window.fetch = async (input, init) => {
  const path = String(input);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ path, body });
  const route = path.split("/").at(-1);
  if (route === "session") {
    sessionReads += 1;
    if (mode === "disabled") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    if ((mode === "refresh-denied" || mode === "approve-revoked") && sessionReads > 1) return denied();
    if (mode === "refresh-unavailable" && sessionReads > 1) return Response.json({ error: "client_onboarding_unavailable" }, { status: 503 });
    return Response.json({ csrfToken: String(sessionReads % 10).repeat(64),
      verifiedUntil: mode === "short-session" ? new Date(Date.now() + 60_000).toISOString() : "2099-01-01T00:00:00.000Z" });
  }
  if (route === "inbox") {
    if (mode === "inbox-denied") return Response.json({ error: "client_onboarding_denied" }, { status: 403 });
    if (body.cursor) return Response.json({ submissions: [{ submissionId: laterId, submittedAt: "2098-01-03T00:00:00.000Z", name: "Later Client",
      organizationName: "", clientType: "consumer", existingClient: true }], nextCursor: null });
    return Response.json({ submissions: [
      { submissionId: consumerId, submittedAt: "2098-01-01T00:00:00.000Z", name: "Reviewed Client", organizationName: "", clientType: "consumer", existingClient: false },
      { submissionId: businessId, submittedAt: "2098-01-02T00:00:00.000Z", name: "Dana Business", organizationName: "Example LLC", clientType: "business", existingClient: false },
    ].filter(item => !(approved && item.submissionId === (mode.startsWith("business") || mode === "shared" ? businessId : consumerId))),
    nextCursor: { submittedAt: "2098-01-02T00:00:00.000Z", submissionId: businessId } });
  }
  if (route === "review" && mode === "review-disabled") return Response.json({ error: "not_found" }, { status: 404 });
  if (route === "review") return Response.json({ invitationId, submissionId: body.submissionId, fieldsSha256: "e".repeat(64),
    submittedAt: "2098-01-01T00:00:00.000Z", targetClientRecordId: body.submissionId === laterId ? "client:existing-1" : null,
    scopes: [{ businessAreaId: "area:onboarding", divisionId: null }], fields: { ...fields(body.submissionId === businessId), ...(body.submissionId === laterId ? { name: "Later Client" } : {}) } });
  if (route === "enrollment-choices") choiceReads += 1;
  if (route === "enrollment-choices" && mode === "choices-denied") return denied();
  if (route === "enrollment-choices" && mode === "choices-unavailable" && choiceReads === 1) return Response.json({ error: "client_onboarding_unavailable" }, { status: 503 });
  if (route === "enrollment-choices") return Response.json({ sourceIds: mode === "no-sources" ? [] : [secondary, primary] });
  if (route === "activation-status") {
    if (mode === "decided") return Response.json({ activation: { clientRecordId: "55555555-5555-4555-8555-555555555555", updatedAt: "2098-01-05T00:00:00.000Z", state: "active", reason: "active" } });
    if (mode === "status-denied") return denied();
    if (!approved) return Response.json({ activation: null });
    activationReads += 1;
    if (mode === "activation-denied") return denied();
    if (mode === "poll-null" && activationReads <= 2) return Response.json({ activation: null });
    if (mode === "poll-transient" && activationReads === 1) return Response.json({ error: "temporary" }, { status: 503 });
    return Response.json({ activation: { clientRecordId: "55555555-5555-4555-8555-555555555555", updatedAt: "2098-01-05T00:00:00.000Z",
      state: activationReads > 1 ? "active" : "pending", reason: activationReads > 1 ? "active" : "awaiting_pa" } });
  }
  if (route === "scope-choices") {
    if (mode === "scopes-unavailable") return Response.json({ error: "client_onboarding_unavailable" }, { status: 503 });
    return Response.json({ scopes: mode === "no-scopes" ? [] : [
      { businessAreaId: "area:drone", name: "Drone Services", allowAreaWide: true, divisions: [{ divisionId: "division:inspections", name: "Inspections" }] },
      { businessAreaId: "area:tech", name: "Technologies", allowAreaWide: false, divisions: [{ divisionId: "division:web", name: "Web" }] }] });
  }
  if (route === "approve") {
    approvalAttempts += 1;
    if (mode === "delayed-approval") await held();
    if (mode === "approve-denied" || mode === "approve-revoked") return denied();
    if (mode === "uncertain-approval" && approvalAttempts === 1) return Response.json({ error: "client_onboarding_unavailable" }, { status: 503 });
    approved = true;
    return Response.json({ decisionId: "44444444-4444-4444-8444-444444444444", submissionId: body.submissionId,
      clientRecordId: "55555555-5555-4555-8555-555555555555", clientRecordVersion: 1,
      ...(body.organizationSelection ? { organizationRecordId: "66666666-6666-4666-8666-666666666666", organizationRecordVersion: 1 } : {}),
      relationshipVersion: 1, replayed: false });
  }
  if (route === "existing-companies" && mode === "search-denied") return denied();
  if (route === "existing-companies") return Response.json({ existingContactReuse: "unsupported", nextAfterRecordId: null, companies: [
    { recordId: "org:example", expectedVersion: 4, name: "Example LLC", sourceIds: [primary], reusable: true, reason: null },
    { recordId: "org:example-old", expectedVersion: 2, name: "Example LLC (old)", sourceIds: [], reusable: false, reason: "company_not_active" } ] });
  if (route === "shared-company-choices") return Response.json({ approvalAvailable: false, nextAfterGroupId: null, companies: [
    { groupId: "99999999-9999-4999-8999-999999999999", expectedVersion: 3, name: "Example LLC", reviewAvailable: true, reason: null,
      members: [{ recordId: "org:ltt", expectedVersion: 2, sourceIds: [secondary] }, { recordId: "org:ltds", expectedVersion: 5, sourceIds: [primary] }] } ] });
  if (route === "shared-company-plan" && mode === "delayed-plan") await held();
  if (route === "shared-company-plan") return Response.json({ planId: body.commandId, submissionId: body.submissionId,
    companyGroupId: body.organizationSelection.groupId, companyGroupVersion: 3, sourceIds: body.sourceIds, expiresAt: "2099-01-01T00:00:00.000Z",
    state: "reviewed", approvalAvailable: true, replayed: false, children: body.sourceIds.map((sourceId: string, index: number) => ({
      clientRecordId: `child-${index}`, parentRecordId: sourceId === primary ? "org:ltds" : "org:ltt", parentRecordVersion: 1, sourceIds: [sourceId] })) });
  if (route === "approve-shared-company") { approved = true; return Response.json({ decisionId: body.planId, planId: body.planId, outcome: "approved",
    invitationId, submissionId: body.submissionId, clientRecordId: "55555555-5555-4555-8555-555555555555", clientRecordVersion: 1,
    organizationRecordId: "org:ltds", organizationRecordVersion: 6, relationshipVersion: 1, replayed: false, members: [], portalActivation: "pending" }); }
  if (route === "create") return Response.json({ invitationId, expiresAt: body.expiresAt, requestSha256: "c".repeat(64), state: "pending" });
  if (route === "reveal") {
    if (mode === "uncertain") return Response.json({ error: "client_onboarding_unavailable" }, { status: 503 });
    return Response.json({ commandId: body.commandId, invitationId, expiresAt: "2099-01-01T00:00:00.000Z", invitationSecret: "d".repeat(64),
      recipientUrl: mode === "no-link" ? null : `https://portal.example.test/onboarding/${invitationId}#${"d".repeat(64)}` });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
};

createRoot(document.getElementById("root")!).render(<ClientOnboardingStaff />);
