import { probeProjectAlphaApiV2, type ProjectAlphaApiV2Connection, type ProjectAlphaApiV2Endpoint,
  type ProjectAlphaApiV2Probe } from "./project-alpha-api-v2";

const identity = { requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
const endpoint = (method: string, path: string, requiredCapability: string): ProjectAlphaApiV2Endpoint =>
  ({ method, path, requiredCapability, ...identity });

// Fixed metadata checks only. No endpoint in this list is ever requested.
export const INSTALLED_WRITER_REQUIREMENTS = {
  clientCreate: endpoint("POST", "/api/v2/directory/clients/commands", "directory.clients.create"),
  clientRead: endpoint("GET", "/api/v2/directory/clients/{publicId}", "directory.clients.read"),
  clientProfileWrite: endpoint("POST", "/api/v2/directory/clients/{publicId}/profile/commands", "directory.clients.write"),
  clientContactProfileWrite: { ...endpoint("POST", "/api/v2/directory/clients/{publicId}/contact-profile/commands", "directory.clients.write"), requiresExpectedRevision: true },
  clientBindingStatus: endpoint("GET", "/api/v2/bindings/client/status/{base64urlExternalId}", "directory.clients.binding_status.read"),
  clientBindingRefresh: endpoint("POST", "/api/v2/directory/clients/bindings/revisions/commands", "directory.clients.binding.revision.refresh"),
  clientBindingReconcile: endpoint("POST", "/api/v2/directory/clients/bindings/revisions/commands/reconcile", "directory.clients.binding.revision.refresh"),
  organizationRead: endpoint("GET", "/api/v2/directory/organizations/{publicId}", "directory.organizations.read"),
  organizationCreate: endpoint("POST", "/api/v2/directory/organizations/commands", "directory.organizations.create"),
  organizationProfileWrite: endpoint("POST", "/api/v2/directory/organizations/{publicId}/profile/commands", "directory.organizations.write"),
  organizationBindingStatus: endpoint("GET", "/api/v2/bindings/organization/status/{base64urlExternalId}", "directory.organizations.binding_status.read"),
  organizationBindingRefresh: endpoint("POST", "/api/v2/directory/organizations/bindings/revisions/commands", "directory.organizations.binding.revision.refresh"),
  organizationBindingReconcile: endpoint("POST", "/api/v2/directory/organizations/bindings/revisions/commands/reconcile", "directory.organizations.binding.revision.refresh"),
  clientOrganizationAssign: endpoint("POST", "/api/v2/directory/clients/{publicId}/organization/assign/commands", "directory.clients.organization.assign"),
} satisfies Record<string, ProjectAlphaApiV2Endpoint>;

function safe(probe: ProjectAlphaApiV2Probe) {
  return probe.status === "verified"
    ? { status: "advertised", exactIdentityMatch: true, exactContractMatch: true }
    : { status: "unavailable", reason: probe.reason, exactIdentityMatch: false, exactContractMatch: false };
}

/** Observe the deployment-owned key once, then reuse only that bounded response
 * with the existing strict validator. Never send a command, expose raw metadata,
 * or interpret advertised prerequisites as record authority or command success. */
export async function readInstalledWriterReadiness(connection: ProjectAlphaApiV2Connection, send: typeof fetch = fetch) {
  let snapshot: (() => Response) | undefined;
  // Pin the complete connection before the first await, including Access fields.
  const selected = { ...connection };
  const first: ProjectAlphaApiV2Probe = selected.expectedHistoryEpoch === undefined
    ? { status: "misconfigured", reason: "configuration" }
    : await probeProjectAlphaApiV2(selected, [], async (input, init) => {
    const response = await send(input, init);
    // Buffer at most the validator's existing 64 KiB bound. Do not tee the
    // network stream: cancellation of a malformed response must not wait on an
    // unread clone. Non-success responses go straight to the normal validator.
    if (response.redirected || response.status !== 200 || !response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 64 * 1024) { await reader.cancel(); throw new Error("response_limit"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers(response.headers);
    snapshot = () => new Response(bytes, { status: response.status, headers });
    return snapshot();
  });
  const checks: Record<string, ReturnType<typeof safe>> = {};
  for (const [name, required] of Object.entries(INSTALLED_WRITER_REQUIREMENTS)) {
    checks[name] = safe(first.status !== "verified" ? first
      : await probeProjectAlphaApiV2(selected, [], async () => snapshot!(), [required], [required.requiredCapability]));
  }
  // Linked creation requires this grant even when PA's optional standalone
  // relationship route is disabled. Keep grant and route readiness distinct.
  checks.clientOrganizationAssignGrant = safe(first.status !== "verified" ? first
    : await probeProjectAlphaApiV2(selected, [], async () => snapshot!(), [], ["directory.clients.organization.assign"]));
  return { meaning: "advertised_prerequisites_only", singleCapabilitiesObservation: true,
    identity: safe(first), checks };
}
