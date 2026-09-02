import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./ClientPortalAccessPanel.css";

export interface PortalPageMetadata {
  available: boolean;
  reason: "workspace_unavailable" | "identity_unlinked" | "identity_conflict" | null;
  nextCursor: string | null;
  hasMore: boolean;
  returned: number;
  limit: number;
}
interface PortalRecord { row_key?: string; id?: string; contact_key?: string }
export interface PortalInvitation extends PortalRecord {
  id: string; status: string; created_at?: string; expires_at?: string | null;
  accepted_at?: string | null; revoked_at?: string | null;
  email_status: string | null; attempts?: number | null; last_error_code?: string | null;
}
export interface PortalIdentitySummary extends PortalRecord {
  workspace_id: string; workspace_name?: string; public_id: string; display_name: string; email_hint: string;
  status: string; identity_id: string | null; has_workspace_access: number; blocked: number;
  binding_status: string; principalContextVersion: string;
  hasExplicitAccess: boolean; accessLoaded: false; invitation: PortalInvitation | null;
  effectiveEmailBlockCount: number; effectiveSubjectBlock: boolean; removableEmailBlockId: string | null;
  workspaceAccessSuspended?: boolean; workspaceDenialCount?: number;
  removableWorkspaceDenialId?: string | null; removableWorkspaceDenialUpdatedAt?: string | null;
  actions: { canRetryInvitation: boolean; canCreateEmailBlock: boolean; canReviewEligibilityBlocks: boolean;
    canSuspendWorkspaceAccess?: boolean; canReactivateWorkspaceAccess?: boolean };
}
interface PortalPage<T> {
  items: T[]; page: PortalPageMetadata; contextVersion: string; refreshedAt: string;
  principalContextVersion?: string;
}
export interface PortalIdentityPage extends PortalPage<PortalIdentitySummary> {
  capabilities: { canManagePortal: boolean; canManageEligibilityBlocks: boolean; canManageWorkspaceAccess?: boolean;
    canReviewIdentityDetails?: boolean };
}
interface AccessRule extends PortalRecord {
  id: string; capability: string; effect: "allow" | "deny"; scope_type: string; scope_public_id: string;
  scope_label: string; status: string; valid_from: string; expires_at: string | null;
  revoked_at: string | null; effective_now: boolean; source_type: string;
}
interface EligibilityBlock extends PortalRecord {
  id: string; match_type: "email" | "issuer_subject"; normalized_email: string | null; reason_code: string;
  status: string; valid_from: string; expires_at: string | null; created_at: string; revoked_at: string | null;
  effective_now: boolean; global_scope: true; canRevoke: boolean;
}
type IdentityQuery = { q: string; link: "all" | "linked" | "unlinked" | "conflict"; blocked: "all" | "yes" | "no"; principalStatus: "active" | "suspended" | "revoked" | "all" };
type Mutation = { identity: PortalIdentitySummary;
  action: "block" | "unblock" | "retry" | "workspace_suspend" | "workspace_reactivate"; blockId?: string };

function readQuery(): IdentityQuery {
  const query = new URLSearchParams(location.search), link = query.get("login_link"), blocked = query.get("login_blocked"), status = query.get("login_status");
  return { q: (query.get("login_q") || "").trim().slice(0, 200),
    link: link === "linked" || link === "unlinked" || link === "conflict" ? link : "all",
    blocked: blocked === "yes" || blocked === "no" ? blocked : "all",
    principalStatus: status === "suspended" || status === "revoked" || status === "all" ? status : "active" };
}
function defaultQuery(query: IdentityQuery) { return !query.q && query.link === "all" && query.blocked === "all" && query.principalStatus === "active"; }
function identityKey(identity: PortalIdentitySummary) { return JSON.stringify([identity.workspace_id, identity.public_id]); }
function recordKey(item: PortalRecord) { return item.row_key || item.contact_key || item.id || ""; }
function date(value: string | null | undefined) {
  if (!value) return "No expiry";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.valueOf()) ? parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : value;
}
function badge(identity: PortalIdentitySummary): { text: string; tone: "danger" | "success" | "warning" | "neutral" } {
  if (identity.blocked) return { text: "Sign-in blocked", tone: "danger" };
  if (identity.workspaceAccessSuspended) return { text: "Access paused for this workspace", tone: "warning" };
  if (identity.binding_status === "conflict") return { text: "Login link needs review", tone: "warning" };
  if (identity.identity_id && identity.has_workspace_access) return { text: "Portal membership active", tone: "success" };
  return identity.identity_id ? { text: "Login linked · no portal membership", tone: "neutral" } : { text: "Login not linked", tone: "neutral" };
}
function isContextFailure(error: unknown) { return error instanceof ApiError && [401, 403, 404, 409].includes(error.status); }
function unavailableMessage(reason: PortalPageMetadata["reason"]) {
  return reason === "identity_unlinked" ? "This contact has no linked portal login. No identity-specific access rules can be shown."
    : reason === "identity_conflict" ? "This login link needs review before identity-specific access rules can be shown."
      : "A verified portal workspace is required before login records can be shown.";
}

/** One independent live listing. Root/principal changes invalidate the whole
 * workspace; ordinary network errors leave unrelated sections intact. */
function usePortalPage<T extends PortalRecord>({ path, initial, contextVersion, principalContextVersion, contextSignal, onInvalidated }: {
  path: string; initial?: PortalPage<T>; contextVersion: string; principalContextVersion?: string;
  contextSignal: AbortSignal; onInvalidated: (message: string) => void;
}) {
  const [state, setState] = useState<{ path: string; value: PortalPage<T> | null; busy: boolean; error: string; continued: boolean }>({ path, value: initial || null, busy: !initial, error: "", continued: false });
  const active = useRef(true), controller = useRef<AbortController | null>(null), sequence = useRef(0), initialConsumed = useRef(false);
  const invalidateRef = useRef(onInvalidated); invalidateRef.current = onInvalidated;
  const validate = (value: PortalPage<T>, previousCursor?: string) => {
    if (value.contextVersion !== contextVersion || (principalContextVersion && value.principalContextVersion !== principalContextVersion))
      throw new ApiError("Portal identity or access changed. Refresh this client workspace.", 409, {});
    if (!Array.isArray(value.items) || !value.page || (value.page.hasMore && (!value.page.nextCursor || value.page.nextCursor === previousCursor)))
      throw new ApiError("This portal listing cannot be continued safely. Refresh this client workspace.", 409, {});
    return value;
  };
  const load = async (more = false) => {
    if (contextSignal.aborted || controller.current) return;
    const previous = state.path === path ? state.value : null;
    if (more && (!previous?.page.available || !previous.page.hasMore || !previous.page.nextCursor)) return;
    const abort = new AbortController(), request = ++sequence.current;
    controller.current = abort;
    setState(current => ({ path, value: more ? current.value : null, busy: true, error: "", continued: more && current.continued }));
    try {
      const url = new URL(path, location.origin);
      url.searchParams.set("limit", more ? "25" : "5");
      if (more) url.searchParams.set("cursor", previous!.page.nextCursor!);
      const value = await api<PortalPage<T>>(`${url.pathname}${url.search}`, { signal: abort.signal });
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      validate(value, more ? previous!.page.nextCursor! : undefined);
      setState(current => {
        const items = new Map((more ? current.value?.items || [] : []).map(item => [recordKey(item), item]));
        for (const item of value.items) items.set(recordKey(item), item);
        return { path, value: { ...value, items: [...items.values()] }, busy: false, error: "", continued: more };
      });
    } catch (error) {
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      const message = error instanceof Error ? error.message : "These portal records could not be loaded.";
      if (isContextFailure(error)) {
        setState({ path, value: null, busy: false, error: message, continued: false });
        invalidateRef.current(message);
      } else setState(current => ({ ...current, busy: false, error: message }));
    } finally {
      if (active.current && sequence.current === request) controller.current = null;
    }
  };
  useEffect(() => {
    active.current = true;
    const abort = () => { sequence.current += 1; controller.current?.abort(); controller.current = null; };
    contextSignal.addEventListener("abort", abort);
    if (!initialConsumed.current && initial) {
      initialConsumed.current = true;
      try { setState({ path, value: validate(initial), busy: false, error: "", continued: false }); }
      catch (error) { invalidateRef.current(error instanceof Error ? error.message : "Refresh the client workspace."); }
    } else { initialConsumed.current = true; void load(); }
    return () => { active.current = false; abort(); contextSignal.removeEventListener("abort", abort); };
  }, [path, contextVersion, principalContextVersion, contextSignal]);
  const visible = state.path === path ? state : { path, value: null, busy: true, error: "", continued: false };
  return { ...visible, more: () => void load(true), retry: () => void load(Boolean(visible.value)) };
}

function PageActions<T extends PortalRecord>({ listing, label }: { listing: ReturnType<typeof usePortalPage<T>>; label: string }) {
  const { value, busy, error, continued } = listing;
  const canLoad = Boolean(value?.page.available && value.page.hasMore && value.page.nextCursor);
  return <div className="portal-access-page-actions">
    <p role="status">{value ? `${value.items.length.toLocaleString()} shown${busy ? " · Loading more…" : ""}` : busy ? "Loading…" : ""}</p>
    {error && <p className="portal-access-error" role="alert">{error}</p>}
    {(error || canLoad || continued) && <button type="button" className="button-ghost" aria-disabled={busy || (!error && !canLoad)}
      onClick={() => { if (!busy) { if (error) listing.retry(); else if (canLoad) listing.more(); } }}>
      {busy ? `Loading ${label}…` : error ? `Retry ${label}` : canLoad ? `Load more ${label}` : `All ${label} loaded`}
    </button>}
  </div>;
}

function IdentityRecords<T extends PortalRecord>({ path, label, identity, contextVersion, contextSignal, onInvalidated, children }: {
  path: string; label: string; identity: PortalIdentitySummary; contextVersion: string; contextSignal: AbortSignal;
  onInvalidated: (message: string) => void; children: (items: T[]) => ReactNode;
}) {
  const listing = usePortalPage<T>({ path, contextVersion, contextSignal, principalContextVersion: identity.principalContextVersion, onInvalidated });
  return <section className="portal-access-records" aria-label={`${label} for ${identity.display_name}`} aria-busy={listing.busy}>
    {listing.value?.page.available === false ? <p>{unavailableMessage(listing.value.page.reason)}</p> : <>
      {listing.value && (listing.value.items.length ? children(listing.value.items) : <p>No matching records.</p>)}
      <PageActions listing={listing} label={label.toLowerCase()} />
    </>}
  </section>;
}

function IdentityRow({ identity, basePath, contextVersion, contextSignal, capabilities, onInvalidated, mutate, busy, feedback }: {
  identity: PortalIdentitySummary; basePath: string; contextVersion: string; contextSignal: AbortSignal;
  capabilities: PortalIdentityPage["capabilities"]; onInvalidated: (message: string) => void;
  mutate: (mutation: Mutation) => void; busy: boolean; feedback?: { message: string; error: boolean; retry?: Mutation };
}) {
  const [opened, setOpened] = useState({ access: false, invitations: false, blocks: false });
  const id = useId(), status = badge(identity);
  const path = (collection: string) => `${basePath}/identities/${encodeURIComponent(identity.public_id)}/${collection}?${new URLSearchParams({ expectedPrincipalContext: identity.principalContextVersion })}`;
  const props = { identity, contextVersion, contextSignal, onInvalidated };
  const canBlock = capabilities.canManageEligibilityBlocks && identity.actions.canCreateEmailBlock;
  const canUnblock = capabilities.canManageEligibilityBlocks && Boolean(identity.removableEmailBlockId);
  const canSuspendWorkspace = capabilities.canManageWorkspaceAccess && identity.actions.canSuspendWorkspaceAccess;
  const canReactivateWorkspace = capabilities.canManageWorkspaceAccess && identity.actions.canReactivateWorkspaceAccess
    && identity.removableWorkspaceDenialId && identity.removableWorkspaceDenialUpdatedAt;
  return <article className="portal-access-person" aria-label={`Portal login for ${identity.display_name}`}>
    <header><div><h3>{identity.display_name}</h3><p>{identity.email_hint || "Email not available"}</p>
      {identity.status !== "active" && <small>Login record status: {identity.status}</small>}</div><StatusPill tone={status.tone}>{status.text}</StatusPill></header>
    {identity.effectiveSubjectBlock && <p>A global identity rule blocks sign-in. Email changes alone will not remove that rule.</p>}
    {identity.invitation && <p className="portal-access-summary">Latest invitation: {identity.invitation.status} · Email delivery: {identity.invitation.email_status || "not reported"}</p>}
    {capabilities.canReviewIdentityDetails !== false && <div className="portal-access-tools">
      <button type="button" className="button-ghost" aria-expanded={opened.access} aria-controls={`${id}-access`} onClick={() => setOpened(value => ({ ...value, access: !value.access }))}>{opened.access ? "Hide access" : "Show access"}</button>
      {identity.email_hint && <button type="button" className="button-ghost" aria-expanded={opened.invitations} aria-controls={`${id}-invitations`} onClick={() => setOpened(value => ({ ...value, invitations: !value.invitations }))}>Invitations to this email</button>}
      {identity.actions.canReviewEligibilityBlocks && <button type="button" className="button-ghost" aria-expanded={opened.blocks} aria-controls={`${id}-blocks`} onClick={() => setOpened(value => ({ ...value, blocks: !value.blocks }))}>Sign-in blocks</button>}
    </div>}
    {opened.access && <div id={`${id}-access`}><p>These are explicit access rules, not a guarantee of effective access. Membership, restrictions, and current permissions still apply.</p>
      <IdentityRecords<AccessRule> {...props} path={path("access")} label="Access rules">{items => <ul>{items.map(rule => <li key={recordKey(rule)}>
        <strong>{rule.scope_label || rule.scope_public_id}</strong><span>{rule.effect === "deny" ? "Deny rule" : "Allow rule"} · {rule.capability.replaceAll("_", " ")}</span>
        <small>{rule.effective_now ? "Active rule" : "Inactive rule"} · {date(rule.expires_at)}</small>
      </li>)}</ul>}</IdentityRecords>
    </div>}
    {opened.invitations && <div id={`${id}-invitations`}><p>Invitations sent to this email in this client workspace. This is not a verified history of the person.</p>
      <IdentityRecords<PortalInvitation> {...props} path={path("invitations")} label="Invitations">{items => <ul>{items.map(invitation => <li key={recordKey(invitation)}>
        <strong>{invitation.status}</strong><span>Email delivery: {invitation.email_status || "not reported"}</span>
        <small>{invitation.created_at ? `Created ${date(invitation.created_at)} · ` : ""}Expires {date(invitation.expires_at)}</small>
        {invitation.last_error_code && <small>Delivery issue: {invitation.last_error_code}</small>}
      </li>)}</ul>}</IdentityRecords>
    </div>}
    {opened.blocks && <div id={`${id}-blocks`}><p>These sign-in blocks apply across all client workspaces. Removing one does not create project or file access.</p>
      <IdentityRecords<EligibilityBlock> {...props} path={path("eligibility-blocks")} label="Sign-in blocks">{items => <ul>{items.map(block => <li key={recordKey(block)}>
        <strong>{block.match_type === "email" ? "Global email block" : "Global identity rule"}</strong><span>{block.effective_now ? "Currently blocking sign-in" : "Not currently in effect"}</span>
        <small>{block.reason_code.replaceAll("_", " ")} · {date(block.expires_at)}</small>
        {block.match_type === "email" && block.canRevoke && capabilities.canManageEligibilityBlocks && <button type="button" className="button-ghost" disabled={busy}
          onClick={() => mutate({ identity, action: "unblock", blockId: block.id })}>Remove sign-in block</button>}
      </li>)}</ul>}</IdentityRecords>
    </div>}
    <div className="portal-access-tools">
      {capabilities.canManagePortal && identity.actions.canRetryInvitation && <button type="button" className="button-ghost" disabled={busy} onClick={() => mutate({ identity, action: "retry" })}>Retry invitation delivery</button>}
      {canSuspendWorkspace && <button type="button" className="button-danger" disabled={busy}
        onClick={() => mutate({ identity, action: "workspace_suspend" })}>Pause access to this workspace</button>}
      {canReactivateWorkspace && <button type="button" className="button-ghost" disabled={busy}
        onClick={() => mutate({ identity, action: "workspace_reactivate", blockId: identity.removableWorkspaceDenialId! })}>Restore access to this workspace</button>}
      {(identity.workspaceDenialCount || 0) > 1 && <small>Multiple workspace restrictions apply. Review the access audit before restoring access.</small>}
      {canBlock && <button type="button" className="button-danger" disabled={busy} onClick={() => mutate({ identity, action: "block" })}>Block portal sign-in</button>}
      {canUnblock && <button type="button" className="button-ghost" disabled={busy} onClick={() => mutate({ identity, action: "unblock", blockId: identity.removableEmailBlockId! })}>Remove sign-in block</button>}
      {identity.effectiveEmailBlockCount > 1 && identity.actions.canReviewEligibilityBlocks && <small>Multiple email blocks apply. Review Sign-in blocks before removing a block.</small>}
    </div>
    {feedback && <div className={feedback.error ? "portal-access-error" : "portal-access-feedback"} role={feedback.error ? "alert" : "status"}>
      <p>{feedback.message}</p>{feedback.retry && <button type="button" className="button-ghost" disabled={busy} onClick={() => mutate(feedback.retry!)}>Retry action</button>}
    </div>}
  </article>;
}

export function ClientPortalAccessPanel({ initialPage, basePath, contextVersion, contextSignal, onInvalidated, onChanged, feedback }: {
  initialPage: PortalIdentityPage; basePath: string; contextVersion: string; contextSignal: AbortSignal;
  onInvalidated: (message: string) => void; onChanged: (message: string) => void; feedback?: string;
}) {
  const [query, setQuery] = useState(readQuery), [draft, setDraft] = useState(readQuery);
  const [mutationFeedback, setMutationFeedback] = useState<Record<string, { message: string; error: boolean; retry?: Mutation }>>({});
  const [busy, setBusy] = useState(false);
  const claimed = useRef(false), active = useRef(true), pending = useRef<AbortController | null>(null);
  const attempts = useRef(new Map<string, string>());
  const formId = useId();
  useEffect(() => {
    active.current = true;
    const sync = () => { const next = readQuery(); setQuery(next); setDraft(next); };
    const abort = () => pending.current?.abort();
    addEventListener("popstate", sync); contextSignal.addEventListener("abort", abort);
    return () => { active.current = false; abort(); removeEventListener("popstate", sync); contextSignal.removeEventListener("abort", abort); };
  }, [contextSignal]);
  const parameters = new URLSearchParams({ q: query.q, link: query.link, blocked: query.blocked, principalStatus: query.principalStatus });
  const listing = usePortalPage<PortalIdentitySummary>({ path: `${basePath}/identities${initialPage.page.available ? `?${parameters}` : ""}`, initial: !initialPage.page.available || defaultQuery(query) ? initialPage : undefined,
    contextVersion, contextSignal, onInvalidated });
  const capabilities = (listing.value as PortalIdentityPage | null)?.capabilities || initialPage.capabilities;
  const search = (next: IdentityQuery) => {
    const normalized = { ...next, q: next.q.trim().slice(0, 200) }, url = new URL(location.href);
    for (const [key, value, empty] of [["login_q", normalized.q, ""], ["login_link", normalized.link, "all"], ["login_blocked", normalized.blocked, "all"], ["login_status", normalized.principalStatus, "active"]]) {
      if (value === empty) url.searchParams.delete(key!); else url.searchParams.set(key!, value!);
    }
    if (`${url.pathname}${url.search}` !== `${location.pathname}${location.search}`) history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    setQuery(normalized); setDraft(normalized);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); search(draft); };
  const mutate = async (mutation: Mutation) => {
    if (claimed.current || contextSignal.aborted) return;
    const { identity, action, blockId } = mutation;
    if (action === "retry" ? !capabilities.canManagePortal || !identity.actions.canRetryInvitation
      : action === "workspace_suspend" ? !capabilities.canManageWorkspaceAccess || !identity.actions.canSuspendWorkspaceAccess
        : action === "workspace_reactivate" ? !capabilities.canManageWorkspaceAccess || !identity.actions.canReactivateWorkspaceAccess
          || !blockId || !identity.removableWorkspaceDenialUpdatedAt
          : !capabilities.canManageEligibilityBlocks || (action === "block" && !identity.actions.canCreateEmailBlock) || (action === "unblock" && !blockId)) return;
    if (action !== "retry" && !confirm(action === "block"
      ? `Block portal sign-in for ${identity.email_hint} across ALL client workspaces? Existing project and file permissions are not deleted.`
      : action === "unblock" ? `Remove this GLOBAL email sign-in block for ${identity.email_hint}? This affects all client workspaces. Other blocks, memberships, and content permissions still apply.`
        : action === "workspace_suspend" ? `Pause portal access for ${identity.display_name} in ${identity.workspace_name || "this client workspace"}? Their Project Alpha membership is preserved and other client workspaces are not affected.`
          : `Restore portal access for ${identity.display_name} in ${identity.workspace_name || "this client workspace"}? Other restrictions and content permissions still apply.`)) return;
    claimed.current = true; setBusy(true);
    const key = identityKey(identity), operation = JSON.stringify([key, identity.principalContextVersion, action, blockId || ""]);
    const idempotencyKey = attempts.current.get(operation) || crypto.randomUUID(); attempts.current.set(operation, idempotencyKey);
    const abort = new AbortController(); pending.current = abort;
    setMutationFeedback(value => ({ ...value, [key]: { message: "Saving…", error: false } }));
    try {
      const url = action === "retry" ? `/api/team/clients/${encodeURIComponent(identity.workspace_id)}/${encodeURIComponent(identity.public_id)}/invitation/retry`
        : action === "block" ? "/api/team/clients/eligibility-blocks"
          : action === "unblock" ? `/api/team/clients/eligibility-blocks/${encodeURIComponent(blockId!)}/revoke`
            : `${basePath}/identities/${encodeURIComponent(identity.public_id)}/workspace-access/${action === "workspace_suspend" ? "suspend" : "reactivate"}`;
      const result = await api<{ outcome?: string }>(url, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, signal: abort.signal,
        ...(action === "retry" ? {} : { body: JSON.stringify(action === "block"
          ? { matchType: "email", email: identity.email_hint, reasonCode: "operator_opt_out", expiresAt: null }
          : action === "unblock" ? { reasonCode: "operator_opt_in" }
            : action === "workspace_suspend" ? { expectedContextVersion: contextVersion,
              expectedPrincipalContext: identity.principalContextVersion, reasonCode: "operator_workspace_pause" }
              : { expectedContextVersion: contextVersion, expectedPrincipalContext: identity.principalContextVersion,
                reasonCode: "operator_workspace_restore", denialId: blockId,
                expectedUpdatedAt: identity.removableWorkspaceDenialUpdatedAt }) }) });
      if (!active.current || abort.signal.aborted || contextSignal.aborted) return;
      attempts.current.delete(operation);
      const message = action === "block" ? `Global sign-in block saved for ${identity.email_hint}.`
        : action === "unblock" ? `Global email block removed for ${identity.email_hint}. Other access rules still apply.`
          : action === "workspace_suspend" ? `Portal access paused for ${identity.display_name} in this client workspace.`
            : action === "workspace_reactivate" ? `Portal access restored for ${identity.display_name} in this client workspace. Other access rules still apply.`
          : result.outcome === "queued" ? `Invitation delivery queued for ${identity.email_hint}.`
            : result.outcome === "already_queued" ? "Invitation delivery is already queued."
              : "This invitation cannot be retried. Refreshing its current status.";
      setMutationFeedback(value => ({ ...value, [key]: { message, error: false } }));
      onChanged(message);
    } catch (error) {
      if (!active.current || abort.signal.aborted || contextSignal.aborted) return;
      const message = error instanceof Error ? error.message : "This action could not be confirmed.";
      if (isContextFailure(error)) onInvalidated(message);
      else {
        const uncertain = !(error instanceof ApiError) || error.status >= 500;
        if (!uncertain) attempts.current.delete(operation);
        setMutationFeedback(value => ({ ...value, [key]: { message: uncertain ? `${message} Retry safely with the same request, or refresh to check the current state.` : message, error: true, retry: mutation } }));
      }
    } finally {
      if (active.current && !contextSignal.aborted) { claimed.current = false; pending.current = null; setBusy(false); }
    }
  };
  return <Card title="Portal logins"><section className="portal-access-panel" aria-label="Portal logins">
    <p>Business contacts do not grant portal login or file access. Portal membership and shared content are authorized separately.</p>
    {feedback && <p className="portal-access-feedback" role="status">{feedback}</p>}
    {(listing.value || initialPage).page.available === false ? <p>{unavailableMessage((listing.value || initialPage).page.reason)}</p> : <>
      <form onSubmit={submit} className="portal-access-search">
        <label htmlFor={`${formId}-query`}>Search portal logins</label>
        <div><input id={`${formId}-query`} type="search" maxLength={200} value={draft.q} onChange={event => setDraft(value => ({ ...value, q: event.target.value }))} placeholder="Name or email" />
          <button type="submit" className="button-orange">Search logins</button><button type="button" className="button-ghost" onClick={() => search({ q: "", link: "all", blocked: "all", principalStatus: "active" })}>Clear login filters</button></div>
        <div className="portal-access-filters">
          <label>Login link<select value={draft.link} onChange={event => setDraft(value => ({ ...value, link: event.target.value as IdentityQuery["link"] }))}>
            <option value="all">All login links</option><option value="linked">Linked</option><option value="unlinked">Not linked</option><option value="conflict">Needs review</option></select></label>
          <label>Sign-in blocks<select value={draft.blocked} onChange={event => setDraft(value => ({ ...value, blocked: event.target.value as IdentityQuery["blocked"] }))}>
            <option value="all">All sign-in states</option><option value="yes">Blocked</option><option value="no">Not blocked</option></select></label>
          <label>Login record status<select value={draft.principalStatus} onChange={event => setDraft(value => ({ ...value, principalStatus: event.target.value as IdentityQuery["principalStatus"] }))}>
            <option value="active">Active records</option><option value="suspended">Suspended records</option><option value="revoked">Revoked records</option><option value="all">All record statuses</option></select></label>
        </div>
      </form>
      {listing.value?.items.length === 0 && <EmptyState title="No matching portal logins" detail="Try another name, email, or filter. Business contacts are listed separately." />}
      <div className="portal-access-people" aria-busy={listing.busy}>{listing.value?.items.map(identity => <IdentityRow key={`${identityKey(identity)}:${identity.principalContextVersion}`}
        identity={identity} basePath={basePath} contextVersion={contextVersion} contextSignal={contextSignal} capabilities={capabilities}
        onInvalidated={onInvalidated} mutate={mutation => void mutate(mutation)} busy={busy} feedback={mutationFeedback[identityKey(identity)]} />)}</div>
      <PageActions listing={listing} label="portal logins" />
      <button type="button" className="button-ghost" disabled={busy} onClick={() => onChanged("")}>Refresh portal access</button>
      {listing.value?.refreshedAt && <small>Portal records refreshed {date(listing.value.refreshedAt)}. Later changes appear after refresh.</small>}
    </>}
  </section></Card>;
}
