import { useEffect, useMemo, useState } from "react";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import type { Permission } from "@ltds/shared";
import { api } from "./api";
import { ClientRequestWorkflow } from "./ClientRequestWorkflow";

interface ContactAccess {
  capability: string;
  effect: "allow" | "deny";
  scope_type: string;
  scope_public_id: string;
  scope_label: string;
}
interface ClientContact {
  workspace_id: string;
  public_id: string;
  display_name: string;
  email_hint: string;
  status: string;
  identity_id: string | null;
  has_workspace_access: number;
  blocked: number;
  access: ContactAccess[];
  invitation: null | { status: string; email_status: string | null };
}
interface ClientSummary {
  workspace_id: string;
  kind: "organization" | "standalone_client";
  route_kind: "organizations" | "standalone";
  public_id: string;
  display_name: string;
  status: string;
  portal_status: string;
  account_count: number;
  project_count: number;
  request_count: number;
  contacts: ClientContact[];
}
interface HubResponse {
  clients: ClientSummary[];
  capabilities: { directory: boolean; requests: boolean; delivery: boolean; viewer: boolean };
}
interface ClientDetailResponse {
  client: ClientSummary;
  contacts: ClientContact[];
  accounts: Array<{ id: string; display_name: string; status: string }>;
  projects: Array<{ id: string; project_name: string; client_name: string; active: number; can_request_service: number }>;
  requests: Array<{ id: string; title: string; status: string; project_name: string | null; created_at: string }>;
  deliveryGrants: Array<{ share_id: string; label: string | null; r2_prefix: string; project_name: string; revoked_at: string | null; expires_at: string | null }>;
  authenticatedDeliveryGrants: Array<{ id: string; status: string; r2_prefix: string; audience_type: string; expires_at: string | null }>;
  viewerGrants: Array<{ id: string; status: string; scope_type: string; project_name: string; model_title: string | null; authorization_expires_at: string | null }>;
  capabilities: HubResponse["capabilities"];
}

function date(value?: string | null): string {
  if (!value) return "No expiry";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function tone(status: string): "neutral" | "success" | "warning" | "danger" {
  return status === "active" || status === "accepted_linked" || status === "completed"
    ? "success"
    : status === "revoked" || status === "blocked" || status === "declined" || status === "cancelled"
      ? "danger"
      : status === "submitted" || status === "under_review" || status === "expired"
        ? "warning"
        : "neutral";
}

function useClientHub<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    if (!path) return () => { active = false; };
    void api<T>(path).then(value => { if (active) setData(value); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Client Hub could not be loaded"); });
    return () => { active = false; };
  }, [path]);
  return { data, error };
}

function clientRoute(): { kind: "organizations" | "standalone"; publicId: string } | null {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] !== "clients" || !["organizations", "standalone"].includes(parts[1] || "") || !parts[2]) return null;
  return { kind: parts[1] as "organizations" | "standalone", publicId: parts[2] };
}

function ContactList({ contacts }: { contacts: ClientContact[] }) {
  if (!contacts.length) return <EmptyState title="No client logins" detail="Eligible contacts and verified logins will appear here after synchronization." />;
  return <div className="client-hub-contact-list">{contacts.map(contact => {
    const status = contact.blocked ? "blocked" : contact.identity_id && contact.has_workspace_access ? "active" : "eligible";
    return <article key={contact.public_id}>
      <div>
        <strong>{contact.display_name}</strong>
        <small>{contact.email_hint || "No portal login yet"}</small>
      </div>
      <StatusPill tone={tone(status)}>{status}</StatusPill>
      <small>{contact.access.length
        ? contact.access.map(item => `${item.effect === "deny" ? "Denied" : "Allowed"}: ${item.scope_label} (${item.capability})`).join(" · ")
        : "No project or content access explicitly granted"}</small>
    </article>;
  })}</div>;
}

function ClientDirectory({ clients }: { clients: ClientSummary[] }) {
  const organizations = clients.filter(client => client.kind === "organization");
  const standalone = clients.filter(client => client.kind === "standalone_client");
  const group = (title: string, values: ClientSummary[]) => <Card title={`${title} (${values.length})`}>
    {values.length ? <div className="client-hub-directory">{values.map(client => <details key={client.workspace_id}>
      <summary>
        <span><strong>{client.display_name}</strong><small>{client.project_count} projects · {client.request_count} requests · {client.contacts.length} contacts</small></span>
        <StatusPill tone={tone(client.portal_status)}>{client.portal_status.replaceAll("_", " ")}</StatusPill>
      </summary>
      <ContactList contacts={client.contacts} />
      <a className="button-orange button-small" href={`/clients/${client.route_kind}/${encodeURIComponent(client.public_id)}`}>Open client workspace</a>
    </details>)}</div> : <EmptyState title={`No ${title.toLowerCase()}`} detail="Synchronized client records will appear here." />}
  </Card>;
  return <div className="client-hub-groups">{group("Organizations", organizations)}{group("Standalone clients", standalone)}</div>;
}

function ClientWorkspace({ route }: { route: NonNullable<ReturnType<typeof clientRoute>> }) {
  const state = useClientHub<ClientDetailResponse>(`/api/client-hub/${route.kind}/${encodeURIComponent(route.publicId)}`);
  if (!state.data && !state.error) return <Loading />;
  if (!state.data) return <Card><EmptyState title="Client workspace unavailable" detail={state.error} /></Card>;
  const data = state.data;
  return <>
    <a className="button-ghost button-small client-hub-back" href="/clients">← Client Hub</a>
    <div className="client-hub-title">
      <div><small>{data.client.kind === "organization" ? "Organization" : "Standalone client"}</small><h2>{data.client.display_name}</h2></div>
      <StatusPill tone={tone(data.client.portal_status)}>{data.client.portal_status.replaceAll("_", " ")}</StatusPill>
    </div>
    <div className="dashboard-grid client-hub-detail-grid">
      <Card title="Contacts and logins"><ContactList contacts={data.contacts} /></Card>
      <Card title="Accounts">{data.accounts.length ? <div className="simple-rows">{data.accounts.map(account => <div key={account.id}><div><strong>{account.display_name}</strong><small>Explicit account record</small></div><StatusPill tone={tone(account.status)}>{account.status}</StatusPill></div>)}</div> : <EmptyState title="No accounts" detail="No linked portal account is active." />}</Card>
      <Card title="Projects and access">{data.projects.length ? <div className="simple-rows">{data.projects.map(project => <div key={`${project.id}:${project.project_name}`}><div><strong>{project.project_name}</strong><small>{project.client_name} · {project.can_request_service ? "Requests allowed" : "View access only"}</small></div><StatusPill tone={project.active ? "success" : "neutral"}>{project.active ? "active" : "inactive"}</StatusPill></div>)}</div> : <EmptyState title="No project access" detail="Projects remain unavailable until explicitly granted." />}</Card>
      {data.capabilities.delivery && <Card title="Delivery access">{data.deliveryGrants.length || data.authenticatedDeliveryGrants.length ? <div className="simple-rows">
        {data.deliveryGrants.map(grant => <div key={grant.share_id}><div><strong>{grant.label || grant.project_name}</strong><small>{grant.r2_prefix} · {date(grant.expires_at)}</small></div><StatusPill tone={tone(grant.revoked_at ? "revoked" : "active")}>{grant.revoked_at ? "revoked" : "active"}</StatusPill></div>)}
        {data.authenticatedDeliveryGrants.map(grant => <div key={grant.id}><div><strong>{grant.r2_prefix}</strong><small>{grant.audience_type} audience · {date(grant.expires_at)}</small></div><StatusPill tone={tone(grant.status)}>{grant.status}</StatusPill></div>)}
      </div> : <EmptyState title="No delivery access" detail="Folders and files remain unavailable until explicitly shared." />}</Card>}
      {data.capabilities.viewer && <Card title="3D Viewer access">{data.viewerGrants.length ? <div className="simple-rows">{data.viewerGrants.map(grant => <div key={grant.id}><div><strong>{grant.model_title || grant.project_name}</strong><small>{grant.scope_type} access · {date(grant.authorization_expires_at)}</small></div><StatusPill tone={tone(grant.status)}>{grant.status}</StatusPill></div>)}</div> : <EmptyState title="No Viewer access" detail="Models remain unavailable until explicitly granted." />}</Card>}
      {data.capabilities.requests && <Card title="Request history">{data.requests.length ? <div className="simple-rows">{data.requests.map(request => <a key={request.id} href={`/clients/requests/${encodeURIComponent(request.id)}`}><div><strong>{request.title}</strong><small>{request.project_name || "Account request"} · {date(request.created_at)}</small></div><StatusPill tone={tone(request.status)}>{request.status.replaceAll("_", " ")}</StatusPill></a>)}</div> : <EmptyState title="No requests" detail="This client has not submitted a service request." />}</Card>}
    </div>
  </>;
}

export function ClientHub({ mapToken, permissions }: { mapToken: string | null; permissions: Permission[] }) {
  const selectedRequest = location.pathname.startsWith("/clients/requests/") || location.pathname.startsWith("/operations/client-requests/");
  const route = clientRoute();
  const canReview = permissions.includes("operations.manage");
  const canViewDirectory = permissions.includes("team.view");
  const state = useClientHub<HubResponse>(!route && !selectedRequest && canViewDirectory ? "/api/client-hub" : null);
  const clients = useMemo(() => state.data?.clients || [], [state.data]);
  if (selectedRequest)
    return canReview ? <ClientRequestWorkflow mapToken={mapToken} basePath="/clients/requests" /> : <Card><EmptyState title="Request unavailable" detail="Request-review access is required." /></Card>;
  if (route) return canViewDirectory ? <ClientWorkspace route={route} /> : <Card><EmptyState title="Client unavailable" detail="Client-directory access is required." /></Card>;
  return <>
    {canReview && <section className="client-hub-queue"><ClientRequestWorkflow mapToken={mapToken} basePath="/clients/requests" pendingOnly /></section>}
    {canViewDirectory && <section>
      <div className="client-hub-section-heading"><div><h2>Clients</h2><p>Organizations and standalone clients with their contacts, access, and shared work.</p></div></div>
      {state.error ? <Card><EmptyState title="Client directory unavailable" detail={state.error} /></Card> : !state.data ? <Loading /> : <ClientDirectory clients={clients} />}
    </section>}
  </>;
}
