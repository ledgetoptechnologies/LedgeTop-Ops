import { useRef, useState } from "react";
import { Card, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import type { BusinessProjectDetail } from "./BusinessProjectWorkspace";

type Side = { revision: string; name: string; description: string | null; status: string; archived: boolean;
  overdueWarning: boolean; completedAt: string | null; archivedAt: string | null; estimatedStart: string | null;
  estimatedEnd: string | null; organizationRecordId: string | null; clientRecordId: string | null;
  scopes: Array<{ scopeKind: string; businessAreaId: string; divisionId: string | null }> };
type Review = { proposalId: string; sourceId: string; externalProjectId: string; expectedLocalVersion: number; expiresAt: string;
  operations: Side; projectAlpha: Side; changedFields: string[] };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function review(value: unknown, root: BusinessProjectDetail["canonicalRoot"], projectId: string): Review | null {
  if (!record(value) || value.status !== "available" || !record(value.proposal)) return null;
  const p = value.proposal;
  if (typeof p.proposalId !== "string" || p.sourceId !== root.sourceId || p.externalProjectId !== projectId
    || !Number.isSafeInteger(p.expectedLocalVersion) || typeof p.expiresAt !== "string"
    || !record(p.operations) || !record(p.projectAlpha) || !Array.isArray(p.changedFields)
    || !p.changedFields.every(item => typeof item === "string")) return null;
  return p as unknown as Review;
}
const label = (value: string) => value.replace(/([A-Z])/g, " $1").replace(/^./, first => first.toUpperCase());
const shown = (value: unknown) => value === null ? "Not set" : Array.isArray(value) ? JSON.stringify(value) : String(value);

export function ProjectInboundReview({ root, projectId, contextVersion, onResolved }: {
  root: BusinessProjectDetail["canonicalRoot"]; projectId: string; contextVersion: string; onResolved: () => void;
}) {
  const kind = root.kind === "organization" ? "organizations" : "standalone";
  const base = `/api/client-hub/sources/${encodeURIComponent(root.sourceId)}/business/${kind}/${encodeURIComponent(root.publicId)}`
    + `/business-projects/${encodeURIComponent(projectId)}/inbound-review`;
  const [state, setState] = useState<{ review: Review | null; busy: boolean; message: string; error: string }>(
    { review: null, busy: false, message: "", error: "" });
  const proposalAttempt = useRef<string | null>(null), resolutionAttempt = useRef<{ proposalId: string; decision: string; key: string } | null>(null);
  const compare = async () => {
    const key = proposalAttempt.current ?? crypto.randomUUID(); proposalAttempt.current = key;
    setState(current => ({ ...current, busy: true, error: "", message: "" }));
    try {
      const proposed = await api<unknown>(`${base}/propose`, { method: "POST", headers: { "Idempotency-Key": key },
        body: JSON.stringify({ expectedContextVersion: contextVersion, idempotencyKey: key }) });
      if (!record(proposed)) throw new Error("The comparison response was invalid.");
      if (proposed.status === "unchanged") {
        setState({ review: null, busy: false, error: "", message: "Operations already matches the current Project Alpha project." }); return;
      }
      if (proposed.status !== "proposed" || typeof proposed.proposalId !== "string")
        throw new ApiError("The project cannot be compared right now.", 409, proposed);
      const query = new URLSearchParams({ expectedContextVersion: contextVersion });
      const loaded = review(await api<unknown>(`${base}/proposals/${encodeURIComponent(proposed.proposalId)}?${query}`), root, projectId);
      if (!loaded) throw new ApiError("The project comparison changed. Compare again.", 409, {});
      setState({ review: loaded, busy: false, error: "", message: "" });
    } catch (error) {
      setState(current => ({ ...current, busy: false, error: error instanceof Error ? error.message : "The project could not be compared.", message: "" }));
    }
  };
  const resolve = async (decision: "accept_project_alpha" | "requires_follow_up") => {
    if (!state.review) return;
    const fingerprint = `${state.review.proposalId}\0${decision}`;
    const attempt = resolutionAttempt.current?.proposalId === fingerprint ? resolutionAttempt.current
      : { proposalId: fingerprint, decision, key: crypto.randomUUID() };
    resolutionAttempt.current = attempt; setState(current => ({ ...current, busy: true, error: "", message: "" }));
    try {
      const result = await api<unknown>(`${base}/resolve`, { method: "POST", headers: { "Idempotency-Key": attempt.key },
        body: JSON.stringify({ expectedContextVersion: contextVersion, idempotencyKey: attempt.key,
          proposalId: state.review.proposalId, decision }) });
      if (!record(result) || result.status !== "resolved" || typeof result.replayed !== "boolean")
        throw new ApiError("The review was not resolved. Refresh and compare again.", 409, record(result) ? result : {});
      proposalAttempt.current = null; resolutionAttempt.current = null;
      if (decision === "accept_project_alpha") onResolved();
      else setState({ review: null, busy: false, error: "", message: "Follow-up recorded. Operations was not changed." });
    } catch (error) {
      setState(current => ({ ...current, busy: false, error: error instanceof Error ? error.message : "The review could not be resolved.", message: "" }));
    }
  };
  return <Card title="Project Alpha inbound review">
    <p>Compare this Operations project with its current Project Alpha record. This review does not grant portal access or activate client links.</p>
    {!state.review && <button type="button" className="button-ghost" disabled={state.busy} onClick={() => void compare()}>
      {state.busy ? "Comparing…" : "Compare with Project Alpha"}</button>}
    {state.message && <p role="status">{state.message}</p>}{state.error && <p role="alert">{state.error}</p>}
    {state.review && <><p><StatusPill tone="warning">Review required</StatusPill> Local version {state.review.expectedLocalVersion}; proposal expires {new Date(state.review.expiresAt).toLocaleString()}.</p>
      <table><thead><tr><th>Field</th><th>Operations</th><th>Project Alpha</th></tr></thead><tbody>
        {state.review.changedFields.map(field => <tr key={field}><th>{label(field)}</th>
          <td>{shown(state.review!.operations[field as keyof Side])}</td><td>{shown(state.review!.projectAlpha[field as keyof Side])}</td></tr>)}
      </tbody></table><div className="business-project-recovery">
        <button type="button" className="button-orange" disabled={state.busy} onClick={() => void resolve("accept_project_alpha")}>Accept Project Alpha</button>
        <button type="button" className="button-ghost" disabled={state.busy} onClick={() => void resolve("requires_follow_up")}>Record follow-up</button>
        <button type="button" className="button-ghost" disabled={state.busy} onClick={() => { proposalAttempt.current = null; setState(current => ({ ...current, review: null })); }}>Cancel review</button>
      </div></>}
  </Card>;
}
