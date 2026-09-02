import { useEffect, useRef, useState } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./ProjectAlphaContactRoles.css";

export interface ProjectAlphaContactRoleRoot {
  sourceId: string; rootNamespace: string; kind: "organization" | "standalone_client"; publicId: string;
}
export interface ProjectAlphaContactRoleItem {
  contactDisplayName: string; clientDisplayName: string;
  scopeType: "organization" | "standalone_client" | "department" | "client" | "project";
  scopeDisplayName: string; role: string; primary: boolean; primaryBilling: boolean;
  sendProjectInvoices: boolean; canViewInvoiceLinks: boolean; sourceVersion: string;
}
export interface ProjectAlphaContactRolePage {
  state: "unavailable" | "not_published" | "verified_empty" | "populated";
  reason: "workspace_unavailable" | "schema_v4_not_published" | null;
  items: ProjectAlphaContactRoleItem[]; nextCursor: string | null; hasMore: boolean;
  returned: number; limit: number; canonicalRoot: ProjectAlphaContactRoleRoot; contextVersion: string;
}

const rootKey = (root: ProjectAlphaContactRoleRoot) => JSON.stringify([root.sourceId, root.rootNamespace, root.kind, root.publicId]);
const safeText = (value: unknown, maximum = 512): value is string => typeof value === "string" && value.length > 0
  && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

export function isProjectAlphaContactRolePage(value: unknown, root: ProjectAlphaContactRoleRoot,
  contextVersion: string): value is ProjectAlphaContactRolePage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const page = value as Partial<ProjectAlphaContactRolePage>;
  if (!page.canonicalRoot || rootKey(page.canonicalRoot) !== rootKey(root) || page.contextVersion !== contextVersion
    || !["unavailable", "not_published", "verified_empty", "populated"].includes(page.state || "")
    || !(page.reason === null || page.reason === "workspace_unavailable" || page.reason === "schema_v4_not_published")
    || !Array.isArray(page.items) || typeof page.hasMore !== "boolean"
    || !(page.nextCursor === null || safeText(page.nextCursor, 4096)) || !Number.isInteger(page.returned)
    || !Number.isInteger(page.limit) || page.limit! < 1 || page.limit! > 100 || page.returned !== page.items.length
    || page.items.length > page.limit! || (page.hasMore && !page.nextCursor)
    || (page.state !== "populated" && (page.items.length > 0 || page.hasMore))) return false;
  return page.items.every(item => item && safeText(item.contactDisplayName, 240) && safeText(item.clientDisplayName, 240)
    && ["organization", "standalone_client", "department", "client", "project"].includes(item.scopeType)
    && safeText(item.scopeDisplayName, 240) && safeText(item.role, 50) && safeText(item.sourceVersion, 512)
    && [item.primary, item.primaryBilling, item.sendProjectInvoices, item.canViewInvoiceLinks].every(flag => typeof flag === "boolean"));
}

function stateMessage(page: ProjectAlphaContactRolePage): string | null {
  if (page.state === "unavailable") return "Project Alpha contact roles are unavailable for this source or workspace.";
  if (page.state === "not_published") return "This Project Alpha source has not published contact-role assignments yet.";
  if (page.state === "verified_empty") return "Project Alpha published this role collection with no active assignments.";
  return null;
}
const label = (value: string) => value.replaceAll("_", " ").replaceAll(".", " · ").replaceAll(":", " · ");

/** Informational source roles stay visibly separate from business contacts,
 * portal logins and Operations-owned contact assignments. */
export function ProjectAlphaContactRoles({ initial, basePath, root, contextVersion, contextSignal, onInvalidated }: {
  initial: ProjectAlphaContactRolePage; basePath: string; root: ProjectAlphaContactRoleRoot; contextVersion: string;
  contextSignal: AbortSignal; onInvalidated: (message: string, status?: number) => void;
}) {
  const verified = isProjectAlphaContactRolePage(initial, root, contextVersion) ? initial : null;
  const [items, setItems] = useState<ProjectAlphaContactRoleItem[]>(verified?.items ?? []);
  const [page, setPage] = useState<ProjectAlphaContactRolePage | null>(verified);
  const [busy, setBusy] = useState(false), [error, setError] = useState(verified ? "" : "These Project Alpha contact roles could not be verified.");
  const pending = useRef<AbortController | null>(null), failedCursor = useRef<string | null>(null), sequence = useRef(0);
  useEffect(() => {
    const abort = () => { pending.current?.abort(); pending.current = null; sequence.current += 1; };
    contextSignal.addEventListener("abort", abort);
    return () => { contextSignal.removeEventListener("abort", abort); abort(); };
  }, [contextSignal]);
  const load = async (cursor: string) => {
    if (contextSignal.aborted || pending.current || !cursor) return;
    const controller = new AbortController(), request = ++sequence.current; pending.current = controller;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ expectedContextVersion: contextVersion, limit: "25", cursor });
      const result = await api<ProjectAlphaContactRolePage>(`${basePath}/project-alpha-contact-roles?${params}`, { signal: controller.signal });
      if (contextSignal.aborted || controller.signal.aborted || request !== sequence.current) return;
      if (!isProjectAlphaContactRolePage(result, root, contextVersion) || result.state !== "populated"
        || (result.hasMore && result.nextCursor === cursor)) throw new Error("These Project Alpha contact roles could not be verified. Retry this section.");
      setItems(previous => [...previous, ...result.items]); setPage(result); failedCursor.current = null;
    } catch (caught) {
      if (contextSignal.aborted || controller.signal.aborted || request !== sequence.current) return;
      const message = caught instanceof Error ? caught.message : "Project Alpha contact roles could not be loaded.";
      if (caught instanceof ApiError && [401, 403, 404, 409].includes(caught.status)) onInvalidated(message, caught.status);
      else { setError(message); failedCursor.current = cursor; }
    } finally {
      if (!contextSignal.aborted && !controller.signal.aborted && request === sequence.current) { pending.current = null; setBusy(false); }
    }
  };
  const message = page ? stateMessage(page) : null, cursor = error ? failedCursor.current : page?.nextCursor;
  return <Card title="Project Alpha contact roles"><section className="pa-contact-roles" aria-label="Project Alpha contact roles" aria-busy={busy}>
    <p>Read-only role metadata from the selected Project Alpha snapshot. These roles do not grant portal or Operations access.</p>
    {message && <p className="pa-contact-roles-state">{message}</p>}
    {items.length > 0 && <ul>{items.map((item, index) => <li key={JSON.stringify([item.scopeType, item.scopeDisplayName, item.role, item.contactDisplayName, item.sourceVersion, index])}>
      <div><strong>{item.contactDisplayName}</strong><small>{label(item.role)} · {label(item.scopeType)}: {item.scopeDisplayName}</small>
        <small>Client: {item.clientDisplayName} · Source version: {item.sourceVersion}</small></div>
      <div className="pa-contact-role-flags">
        {item.primary && <span>Primary contact</span>}{item.primaryBilling && <span>Primary billing</span>}
        {item.sendProjectInvoices && <span>Receives project invoices</span>}{item.canViewInvoiceLinks && <span>Can view invoice links</span>}
      </div>
    </li>)}</ul>}
    {items.length > 0 && <p role="status">{items.length} role assignments shown{busy ? " · Loading…" : ""}</p>}
    {error && <p role="alert">{error}</p>}
    {(page?.hasMore || error) && <button type="button" className="button-ghost" aria-disabled={busy}
      onClick={() => { if (!busy && cursor) void load(cursor); }}>{busy ? "Loading contact roles…" : error ? "Retry contact roles" : "Load more contact roles"}</button>}
  </section></Card>;
}
