export const PROJECT_ALPHA_SNAPSHOT_FRESHNESS_MS = 26 * 60 * 60 * 1000;

export type IntegrationHealthRow = {
  integration?: unknown;
  status?: unknown;
  last_success_at?: unknown;
};

export interface ConnectionSummary {
  id: "project-alpha" | "viewer" | "delivery";
  label: string;
  configured: boolean;
  status: string;
  stale: boolean;
  lastSuccessAt: string | null;
  href: string;
}

export function buildConnectionSummaries(input: {
  integrations: Array<IntegrationHealthRow & { stale?: unknown }>;
  projectAlphaConfigured: boolean;
  viewerConfigured: boolean;
  deliveryConfigured: boolean;
}): ConnectionSummary[] {
  const projectAlpha = input.integrations.find(row =>
    String(row.integration ?? "").toLowerCase().replaceAll("_", "-") === "project-alpha");
  const configured = (id: "viewer" | "delivery", label: string, enabled: boolean, href: string): ConnectionSummary => ({
    id, label, configured: enabled, status: enabled ? "configured" : "disabled", stale: false,
    lastSuccessAt: null, href,
  });
  return [{
    id: "project-alpha",
    label: "Project Alpha",
    configured: input.projectAlphaConfigured,
    status: input.projectAlphaConfigured ? String(projectAlpha?.status || "configured") : "disabled",
    stale: input.projectAlphaConfigured ? Boolean(projectAlpha?.stale) : false,
    lastSuccessAt: typeof projectAlpha?.last_success_at === "string" ? projectAlpha.last_success_at : null,
    href: "/administration",
  }, configured("viewer", "3D Viewer", input.viewerConfigured, "/viewer"),
  configured("delivery", "Delivery service", input.deliveryConfigured, "/delivery")];
}

/**
 * Project Alpha sends incremental changes through webhooks and performs one
 * full reconciliation each day. The dashboard warning therefore tracks a
 * missed daily reconciliation, not the age of the most recent webhook.
 */
export function projectAlphaHealthIsStale(row: IntegrationHealthRow, now = Date.now()): boolean {
  if (String(row.integration ?? "").toLowerCase().replaceAll("_", "-") !== "project-alpha") return false;
  if (row.status !== "healthy" || !row.last_success_at) return true;

  const timestamp = Date.parse(`${String(row.last_success_at).replace(" ", "T")}Z`);
  return !Number.isFinite(timestamp) || now - timestamp > PROJECT_ALPHA_SNAPSHOT_FRESHNESS_MS;
}

export type ProjectAlphaQuoteFreshness = Readonly<{
  sourceId: string | null;
  availability: "available" | "unavailable" | "unknown" | "monitor_disabled";
  lastVerifiedAt: string | null;
  lastCheckedAt: string | null;
}>;

/**
 * A verified quote is an immutable historical summary, not a live PA read.
 * Keep its verification time separate from connection health so an outage
 * cannot make a stale amount look current. This is deliberately a small
 * source-qualified, non-secret payload for the Operations quote display.
 */
export function projectAlphaQuoteFreshness(input: {
  sourceId: unknown;
  quoteVerifiedAt: unknown;
  incidentStateJson: unknown;
  /** The reader must prove the incident identity is still active, not merely source-matched. */
  activeIdentityMatched?: unknown;
}): ProjectAlphaQuoteFreshness {
  const sourceId = typeof input.sourceId === "string" && /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(input.sourceId)
    ? input.sourceId : null;
  const quoteVerifiedAt = typeof input.quoteVerifiedAt === "string" && Number.isFinite(Date.parse(input.quoteVerifiedAt))
    ? input.quoteVerifiedAt : null;
  const empty = { sourceId, lastVerifiedAt: quoteVerifiedAt, lastCheckedAt: null } as const;
  if (input.activeIdentityMatched !== true || typeof input.incidentStateJson !== "string")
    return { ...empty, availability: "unknown" };
  try {
    const state = JSON.parse(input.incidentStateJson) as Record<string, unknown>;
    if (!state || typeof state !== "object" || Array.isArray(state)
      || typeof state.lastProbeStartedAt !== "number" || !Number.isSafeInteger(state.lastProbeStartedAt)
      || state.lastProbeStartedAt < 0 || typeof state.category !== "string") return { ...empty, availability: "unknown" };
    const lastCheckedAt = new Date(state.lastProbeStartedAt).toISOString();
    if (state.category === "verified") return { ...empty, availability: "available", lastCheckedAt };
    if (state.category === "disabled") return { ...empty, availability: "monitor_disabled", lastCheckedAt };
    if (["misconfigured", "unavailable", "unauthorized", "incompatible", "rate_limited"].includes(state.category))
      return { ...empty, availability: "unavailable", lastCheckedAt };
  } catch { /* Corrupt/missing monitor state is unknown, never a healthy PA. */ }
  return { ...empty, availability: "unknown" };
}
