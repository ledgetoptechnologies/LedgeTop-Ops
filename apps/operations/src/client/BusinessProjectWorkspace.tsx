import { useEffect, useRef, useState } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import type { Permission } from "@ltds/shared";
import { api, ApiError } from "./api";
import { ClientHub } from "./ClientHub";
import type { InvitationAdministrationAccess } from "./invitation-administration-api";
import { ClientBusinessActivity } from "./ClientBusinessActivity";
import { clientDirectoryReturnPath } from "./ClientDirectory";
import { businessProjectClientPath, clientWorkspaceFilters, readBusinessProjectRoute, type BusinessProjectRoute } from "./business-project-route";
import "./BusinessProjectWorkspace.css";

export interface BusinessProjectDetail {
  canonicalRoot: { sourceId: string; rootNamespace: "business" | "portal" | "account"; kind: "organization" | "standalone_client"; publicId: string };
  client: { display_name: string; detail_path: string };
  contextVersion: string;
  refreshedAt: string;
  project: { id: string; name: string; status: string | null; description: string | null; start_date: string | null; end_date: string | null;
    created_at: string | null; manager: { id: string; display_name: string | null } | null };
  linkedContact: { id: string; display_name: string | null; email: string | null; phone: string | null; sourceField: "project.client_id" } | null;
  availability: { linkedContact: "available" | "not_projected" | "unavailable"; siteContacts: "not_projected"; billingContacts: "not_projected"; projectMemory: "not_projected" };
}

function displayDate(value: string | null, calendar = false): string {
  if (!value) return "Not recorded";
  if (calendar && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  return Number.isFinite(date.valueOf()) ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Date not verified";
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";
function matchesRoute(detail: unknown, route: BusinessProjectRoute): detail is BusinessProjectDetail {
  if (!record(detail) || !record(detail.canonicalRoot) || !record(detail.project) || !record(detail.client) || !record(detail.availability)) return false;
  const { project, canonicalRoot: root, client, availability, linkedContact: contact } = detail;
  return typeof detail.contextVersion === "string" && detail.contextVersion.length > 0 && typeof detail.refreshedAt === "string"
    && typeof client.display_name === "string" && typeof client.detail_path === "string" && typeof project.name === "string"
    && [project.status, project.description, project.start_date, project.end_date, project.created_at].every(nullableText)
    && (project.manager === null || (record(project.manager) && typeof project.manager.id === "string" && nullableText(project.manager.display_name)))
    && typeof availability.linkedContact === "string" && ["available", "not_projected", "unavailable"].includes(availability.linkedContact)
    && [availability.siteContacts, availability.billingContacts, availability.projectMemory].every(value => value === "not_projected")
    && (contact === null ? availability.linkedContact !== "available" : record(contact) && contact.sourceField === "project.client_id"
      && typeof contact.id === "string" && [contact.display_name, contact.email, contact.phone].every(nullableText))
    && project.id === route.projectId && root.sourceId === route.sourceId && root.rootNamespace === route.rootNamespace
    && root.publicId === route.publicId && root.kind === (route.kind === "organizations" ? "organization" : "standalone_client");
}
function projectTone(status: string | null): "success" | "warning" | "danger" | "neutral" {
  return status === "completed" ? "success" : status === "overdue" ? "warning" : status === "cancelled" ? "danger" : "neutral";
}

function ProjectWorkspace({ route }: { route: BusinessProjectRoute }) {
  const clientPath = businessProjectClientPath(route), backPath = `${clientPath}${clientWorkspaceFilters(location.search)}`;
  const requestPath = `/api${clientPath.replace("/clients/", "/client-hub/")}/business-projects/${encodeURIComponent(route.projectId)}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ data: BusinessProjectDetail | null; error: string; status: number | null; busy: boolean }>({ data: null, error: "", status: null, busy: true });
  const pending = useRef<AbortController | null>(null), sequence = useRef(0), refreshing = useRef(true);
  useEffect(() => {
    const controller = new AbortController(), request = ++sequence.current;
    pending.current = controller; refreshing.current = true;
    setState({ data: null, error: "", status: null, busy: true });
    void api<BusinessProjectDetail>(requestPath, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || request !== sequence.current) return;
      if (!matchesRoute(value, route)) throw new ApiError("The project or client context changed. Refresh this workspace.", 409, {});
      refreshing.current = false; setState({ data: value, error: "", status: null, busy: false });
    }).catch(error => {
      if (controller.signal.aborted || request !== sequence.current) return;
      refreshing.current = false; setState({ data: null, error: error instanceof Error ? error.message : "This project could not be loaded.", status: error instanceof ApiError ? error.status : null, busy: false });
    });
    return () => { sequence.current += 1; controller.abort(); if (pending.current === controller) pending.current = null; };
  }, [requestPath, revision]);
  const refresh = () => {
    if (refreshing.current) return;
    refreshing.current = true;
    pending.current?.abort(); sequence.current += 1;
    setState({ data: null, error: "", status: null, busy: true });
    setRevision(value => value + 1);
  };
  const invalidate = (message: string, status = 409) => {
    pending.current?.abort(); sequence.current += 1; refreshing.current = false;
    setState({ data: null, error: message, status, busy: false });
  };
  const detail = state.data, project = detail?.project;
  return <section className="business-project-workspace" aria-label="Business project workspace" aria-busy={state.busy}>
    <nav className="business-project-breadcrumbs" aria-label="Project breadcrumbs">
      <a href={clientDirectoryReturnPath()}>Client Hub</a><span aria-hidden="true">/</span>
      <a href={backPath}>{detail?.client.display_name || "Back to client"}</a><span aria-hidden="true">/</span>
      <span aria-current="page">{project?.name || "Business project"}</span>
    </nav>
    <div className="business-project-heading"><div><small>Business project</small><h2>{project?.name || "Project workspace"}</h2></div>
      <button type="button" className="button-ghost" aria-disabled={state.busy} onClick={refresh}>{state.busy ? "Loading project…" : "Refresh project"}</button></div>
    {state.busy && <p role="status">Loading the project and its linked contact…</p>}
    {state.error && <Card><div role="alert"><EmptyState title={state.status === 403 ? "Project access required" : state.status === 404 ? "Project unavailable" : state.status === 409 ? "Project workspace needs refreshing" : "Project could not be loaded"}
      detail={state.error} /></div><div className="business-project-recovery">
        <button type="button" className="button-orange" onClick={refresh}>{state.status === 409 ? "Reload project workspace" : "Retry project"}</button>
        <a className="button-ghost" href={backPath}>Back to client workspace</a>
      </div></Card>}
    {detail && project && <>
      <p className="business-project-intro">This is the business project recorded in Project Alpha. Portal membership and shared files are managed separately in the client workspace.</p>
      <div className="business-project-grid">
        <Card title="Project overview"><dl className="business-project-facts">
          <div><dt>Status</dt><dd><StatusPill tone={projectTone(project.status)}>{project.status?.replaceAll("_", " ") || "Status not recorded"}</StatusPill></dd></div>
          <div><dt>Project manager</dt><dd>{project.manager?.display_name || "Not recorded"}</dd></div>
          <div><dt>Start date</dt><dd>{displayDate(project.start_date, true)}</dd></div>
          <div><dt>End date</dt><dd>{displayDate(project.end_date, true)}</dd></div>
          <div><dt>Project created</dt><dd>{displayDate(project.created_at)}</dd></div>
        </dl><h3>Description</h3><p className="business-project-description">{project.description?.trim() || "No project description was included in the synchronized record."}</p></Card>
        <Card title="Project Alpha linked contact">
          <p>This contact is linked to the project in Project Alpha. Specific site and billing roles are not verified by this view. A contact record does not grant portal access.</p>
          {detail.availability.linkedContact === "available" && detail.linkedContact ? <dl className="business-project-facts">
            <div><dt>Name</dt><dd>{detail.linkedContact.display_name || "Not provided"}</dd></div>
            <div><dt>Email</dt><dd>{detail.linkedContact.email || "Not provided"}</dd></div>
            <div><dt>Phone</dt><dd>{detail.linkedContact.phone || "Not provided"}</dd></div>
          </dl> : <p>{detail.availability.linkedContact === "unavailable" ? "The referenced contact is not available in the synchronized records."
            : "A linked-contact reference was not included in the synchronized project record."}</p>}
        </Card>
      </div>
      <ClientBusinessActivity key={revision} root={detail.canonicalRoot} projectId={project.id} contextVersion={detail.contextVersion}
        contextSignal={pending.current!.signal} onInvalidated={invalidate} />
      <p className="business-project-availability">Site/billing contact assignments and project notes are not provided by this connection yet.</p>
      <p className="business-project-refreshed">Project records refreshed {displayDate(detail.refreshedAt)}. A record refresh does not indicate project activity.</p>
    </>}
  </section>;
}

/** Project routes live inside Client Hub without expanding a client card inline. */
export function ClientHubWorkspaceRouter({ mapToken, permissions, feedbackEnabled=false, invitationAccess }: { mapToken: string | null; permissions: Permission[]; feedbackEnabled?: boolean; invitationAccess?: InvitationAdministrationAccess }) {
  const [, setLocationRevision] = useState(0);
  useEffect(() => {
    const sync = () => setLocationRevision(value => value + 1);
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  const route = readBusinessProjectRoute(location.pathname);
  if (!route) return <ClientHub mapToken={mapToken} permissions={permissions} feedbackEnabled={feedbackEnabled} invitationAccess={invitationAccess} />;
  if ("invalid" in route) return <Card><EmptyState title="Project link unavailable" detail="This project link is invalid." /><a href={clientDirectoryReturnPath()}>Back to Client Hub</a></Card>;
  if (!permissions.includes("team.view")) return <Card><EmptyState title="Project unavailable" detail="Client-directory access is required." /><a href={clientDirectoryReturnPath()}>Back to Client Hub</a></Card>;
  return <ProjectWorkspace key={JSON.stringify(route)} route={route} />;
}
