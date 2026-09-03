import { useEffect, useState } from "react";
import { Card, StatusPill } from "@ltds/ui";
import { api } from "./api";

type Reason = "client_runtime_unverified" | "operations_feature_disabled"
  | "operations_configuration_unavailable" | "schema_unavailable"
  | "notification_transport_unavailable" | "readiness_check_unavailable";
type Item = { state: "ready" | "blocked" | "unverified"; reasons: Reason[] };
type Readiness = { ready: boolean; workflows: {
  nativeFeedback: Item; serviceRequests: Item; requestAttachments: Item; delegatedSharing: Item; expiryNotices: Item;
} };

const labels: Record<keyof Readiness["workflows"], string> = {
  nativeFeedback: "Client feedback",
  serviceRequests: "Service requests",
  requestAttachments: "Request attachments",
  delegatedSharing: "Delegated sharing and signer",
  expiryNotices: "Access-expiry notices",
};
const explanations: Record<Reason, string> = {
  client_runtime_unverified: "Client runtime gate must be verified in the Client deployment",
  operations_feature_disabled: "Operations companion is disabled",
  operations_configuration_unavailable: "Operations companion configuration is unavailable",
  schema_unavailable: "Required database contract is unavailable",
  notification_transport_unavailable: "Notification transport is unavailable",
  readiness_check_unavailable: "Readiness could not be verified",
};
const workflowKeys: Array<keyof Readiness["workflows"]> = ["nativeFeedback", "serviceRequests", "requestAttachments", "delegatedSharing", "expiryNotices"];
const reasonKeys = new Set(Object.keys(explanations));
function verifiedReadiness(value: Readiness): Readiness {
  if (!value || typeof value.ready !== "boolean" || !value.workflows) throw new Error("Portal workflow readiness response could not be verified.");
  for (const key of workflowKeys) {
    const item = value.workflows[key];
    if (!item || !["ready", "blocked", "unverified"].includes(item.state) || !Array.isArray(item.reasons)
      || item.reasons.some(reason => !reasonKeys.has(reason)) || (item.state === "ready") !== (item.reasons.length === 0))
      throw new Error("Portal workflow readiness response could not be verified.");
  }
  if (value.ready !== workflowKeys.every(key => value.workflows[key].state === "ready"))
    throw new Error("Portal workflow readiness response could not be verified.");
  return value;
}

export function PortalWorkflowReadiness() {
  const [data, setData] = useState<Readiness | null>(null), [error, setError] = useState("");
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    setLoading(true);
    api<Readiness>("/api/admin/portal-workflow-readiness", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setData(verifiedReadiness(value)); setLoading(false); } })
      .catch(caught => { if (!controller.signal.aborted) { setData(null); setLoading(false);
        setError(caught instanceof Error ? caught.message : "Readiness could not be checked."); } });
    return () => controller.abort();
  }, [revision]);
  return <Card title="Client portal workflow readiness" action={<button type="button" className="button-ghost button-small"
    disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading && revision > 0 ? "Refreshing…" : "Refresh"}</button>}>
    <p>Read-only deployment checks for cross-application workflows. This does not enable features or expose client, source, or credential details.</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {loading && !error && <p role="status">{revision > 0 ? "Refreshing portal workflows…" : "Checking portal workflows…"}</p>}
    {data && <div className="portal-workflow-readiness">
      <p role="status"><strong>{data.ready ? "All cross-application workflows are ready." : "Some workflows are blocked or require Client deployment verification."}</strong></p>
      {Object.entries(data.workflows).map(([key, value]) => <div key={key}>
        <p><strong>{labels[key as keyof Readiness["workflows"]]}</strong> · <StatusPill tone={value.state === "ready" ? "success" : "warning"}>{value.state}</StatusPill></p>
        {value.reasons.length > 0 && <small>{value.reasons.map(reason => explanations[reason]).join(" · ")}</small>}
      </div>)}
    </div>}
  </Card>;
}
