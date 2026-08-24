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
