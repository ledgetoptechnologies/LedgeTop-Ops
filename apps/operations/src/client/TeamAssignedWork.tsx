import { useState } from "react";
import { StatusPill } from "@ltds/ui";
import { api } from "./api";

interface AssignedOperation {
  id: string;
  title: string;
  status: string;
  scheduledStart: string | null;
  projectName: string | null;
  briefAvailable: boolean;
  canViewSops: boolean;
  sopCount: number;
}

interface AssignedWorkResponse {
  operations: AssignedOperation[];
  truncated: boolean;
}

function date(value: string | null) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function TeamAssignedWork({ staffId }: { staffId: string }) {
  const [state, setState] = useState<AssignedWorkResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    if (state || loading) return;
    setLoading(true);
    setError("");
    try {
      setState(await api<AssignedWorkResponse>(
        `/api/team/staff/${encodeURIComponent(staffId)}/assigned-work`,
      ));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <details
      className="team-assigned-work"
      onToggle={event => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>Assigned work</summary>
      {loading && <small role="status">Loading assigned operations…</small>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {state && (state.operations.length ? (
        <div className="team-assigned-work-list">
          {state.operations.map(operation => (
            <article key={operation.id}>
              <div>
                <strong>{operation.title}</strong>
                <small>{operation.projectName || "No linked project"} · {date(operation.scheduledStart)}</small>
                <div className="record-badges">
                  <StatusPill>{operation.status.replaceAll("_", " ")}</StatusPill>
                  {operation.canViewSops && (
                    <span className="managed-badge">
                      {operation.sopCount} {operation.sopCount === 1 ? "SOP" : "SOPs"}
                    </span>
                  )}
                </div>
              </div>
              <a
                className="button-ghost button-small"
                href={`/operations?brief=${encodeURIComponent(operation.id)}`}
              >
                {operation.briefAvailable ? "Open job brief" : "Open operation"}
              </a>
            </article>
          ))}
          {state.truncated && <small>Showing the 100 most recent assigned operations.</small>}
        </div>
      ) : (
        <small>No active assigned operations are visible to you.</small>
      ))}
    </details>
  );
}
