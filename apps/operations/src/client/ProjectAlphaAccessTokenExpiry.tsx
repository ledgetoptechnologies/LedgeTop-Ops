import { useEffect, useState } from "react";
import { Card, StatusPill } from "@ltds/ui";
import { api } from "./api";

type State = "healthy" | "renewal_due" | "expires_soon" | "expired" | "unconfigured" | "invalid";
type Item = { connector: "ltds" | "ltt"; label: string; state: State; expiresAt: string | null; daysRemaining: number | null };
type Diagnostic = { generatedAt: string; healthy: boolean; connectors: Item[] };
const states = new Set<State>(["healthy", "renewal_due", "expires_soon", "expired", "unconfigured", "invalid"]);
const labels: Record<State, string> = { healthy: "healthy", renewal_due: "renewal due", expires_soon: "expires soon", expired: "expired", unconfigured: "not configured", invalid: "invalid configuration" };

function verified(value: Diagnostic): Diagnostic {
  if (!value || typeof value.healthy !== "boolean" || !Array.isArray(value.connectors) || value.connectors.length !== 2)
    throw new Error("Access-token expiry response could not be verified.");
  for (const item of value.connectors) {
    if (!item || !["ltds", "ltt"].includes(item.connector) || typeof item.label !== "string" || !states.has(item.state)
      || !(item.expiresAt === null || (typeof item.expiresAt === "string" && Number.isFinite(Date.parse(item.expiresAt))))
      || !(item.daysRemaining === null || Number.isSafeInteger(item.daysRemaining)))
      throw new Error("Access-token expiry response could not be verified.");
  }
  if (value.healthy !== value.connectors.every(item => item.state === "healthy"))
    throw new Error("Access-token expiry response could not be verified.");
  return value;
}

function detail(item: Item) {
  if (item.state === "unconfigured") return "Add the deployment expiry timestamp to enable this reminder.";
  if (item.state === "invalid") return "The deployment expiry timestamp must be a UTC RFC 3339 timestamp.";
  return `${item.daysRemaining} day${item.daysRemaining === 1 ? "" : "s"} remaining · expires ${new Date(item.expiresAt!).toLocaleDateString()}`;
}

export function ProjectAlphaAccessTokenExpiry() {
  const [data, setData] = useState<Diagnostic | null>(null), [error, setError] = useState(""), [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(""); setLoading(true);
    api<Diagnostic>("/api/admin/project-alpha-access-token-expiry", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setData(verified(value)); setLoading(false); } })
      .catch(caught => { if (!controller.signal.aborted) { setLoading(false); setError(caught instanceof Error ? caught.message : "Access-token expiry could not be checked."); } });
    return () => controller.abort();
  }, [revision]);
  return <Card title="Project Alpha connector token expiry" action={<button type="button" className="button-ghost button-small" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading && revision > 0 ? "Refreshing…" : "Refresh"}</button>}>
    <p>Read-only reminders for deployment-owned Cloudflare Access service-token rotation. No token, client ID, secret, or credential fingerprint is shown.</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {loading && !error && <p role="status">{revision ? "Refreshing token expiry…" : "Checking token expiry…"}</p>}
    {data && <div className="portal-workflow-readiness">
      <p role="status"><strong>{data.healthy ? "Connector token expiry is healthy." : "One or more connector token reminders need attention."}</strong></p>
      {data.connectors.map(item => <div key={item.connector}><p><strong>{item.label}</strong> · <StatusPill tone={item.state === "healthy" ? "success" : item.state === "renewal_due" ? "warning" : "danger"}>{labels[item.state]}</StatusPill></p><small>{detail(item)}</small></div>)}
    </div>}
  </Card>;
}
