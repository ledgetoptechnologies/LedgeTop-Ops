import { useCallback, useEffect, useRef, useState } from "react";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import { api } from "./api";

interface RecentLink {
  id: string;
  display_name?: string;
  target_path?: string;
  r2_prefix?: string;
  target_kind?: "file" | "folder";
  password_protected: boolean | number;
  revoked_at: string | null;
  expires_at?: string | null;
  unavailable_since: string | null;
}

export function RecentDeliveryLinks({ prefix, revision, canRevoke }: {
  prefix?: string;
  revision: number;
  canRevoke: boolean;
}) {
  const [state, setState] = useState<{ prefix?: string; rows: RecentLink[]; loading: boolean; error: string }>({ prefix, rows: [], loading: true, error: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const currentPrefix = useRef(prefix);
  currentPrefix.current = prefix;
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ prefix, rows: [], loading: true, error: "" });
    try {
      const query = new URLSearchParams({ limit: "8" });
      if (prefix) query.set("prefix", prefix);
      const data = await api<{ shares: RecentLink[] }>(`/api/delivery/shares?${query}`, { signal: controller.signal });
      if (!controller.signal.aborted) setState({ prefix, rows: data.shares, loading: false, error: "" });
    } catch (error) {
      if (!controller.signal.aborted) setState({ prefix, rows: [], loading: false, error: error instanceof Error ? error.message : "Client links could not be loaded." });
    }
  }, [prefix]);
  useEffect(() => {
    mounted.current = true;
    setActionError("");
    void load();
    return () => { mounted.current = false; request.current?.abort(); };
  }, [load, revision]);
  const revoke = async (row: RecentLink) => {
    if (busy || !confirm(`Unshare ${row.display_name || "this item"}? Anyone using this link will lose access.`)) return;
    setBusy(row.id);
    setActionError("");
    try {
      await api(`/api/delivery/shares/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      if (mounted.current && currentPrefix.current === prefix) await load();
    } catch (error) {
      if (mounted.current && currentPrefix.current === prefix) setActionError(error instanceof Error ? error.message : "The link could not be revoked.");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const loading = state.prefix !== prefix || state.loading;
  const folder = prefix?.split("/").filter(Boolean).at(-1);
  const href = `/delivery/links${prefix ? `?${new URLSearchParams({ prefix })}` : ""}`;
  return <Card title="Recent client links" className="recent-delivery-links" action={<span className="card-actions">
    <a className="button button-ghost button-small" href={href}>{prefix ? "View folder links" : "View all"}</a>
    <button type="button" className="button-ghost button-small" disabled={loading} onClick={() => void load()}>Refresh</button>
  </span>}>
    <p className="delivery-links-scope">{prefix ? <>Latest eight links for <strong>{folder}</strong> and its subfolders.</> : "Latest eight client links."}</p>
    {actionError && <div className="notice error" role="alert">{actionError}</div>}
    {loading ? <Loading /> : state.error ? <div className="notice error" role="alert">
      <p>{state.error}</p><button type="button" className="button-ghost button-small" onClick={() => void load()}>Retry client links</button>
    </div> : state.rows.length ? <div className="table-wrap recent-delivery-links-table"><table>
      <thead><tr><th>Shared item</th><th>Security</th><th>Status</th>{canRevoke && <th>Action</th>}</tr></thead>
      <tbody>{state.rows.map(row => {
        const status = row.revoked_at ? "revoked" : row.unavailable_since ? "unavailable" : row.expires_at && new Date(row.expires_at).valueOf() <= Date.now() ? "expired" : "active";
        return <tr key={row.id}>
          <td><strong>{row.display_name || row.target_path || row.r2_prefix}</strong><small><code>{row.target_path || row.r2_prefix}</code></small></td>
          <td>{row.password_protected ? "Access code" : "Complete link"}</td>
          <td><StatusPill tone={status === "active" ? "success" : status === "revoked" ? "danger" : status === "unavailable" ? "warning" : "neutral"}>{status}</StatusPill></td>
          {canRevoke && <td>{!row.revoked_at && <button type="button" className="button-danger button-small" disabled={busy !== null} onClick={() => void revoke(row)}>{busy === row.id ? "Unsharing…" : "Unshare"}</button>}</td>}
        </tr>;
      })}</tbody>
    </table></div> : <EmptyState title={prefix ? "No links for this folder" : "No delivery links"} detail={prefix ? "Links for this folder, its files, and its subfolders will appear here." : "Links created from the file browser appear here."} />}
  </Card>;
}
