import { useEffect, useMemo, useRef, useState } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { api } from "./api";
import "./ClientPortalBootstrap.css";

interface BootstrapAccount {
  id: string;
  displayName: string;
  status: string;
  projectAlphaClientId: string | null;
  projectAlphaOrganizationId: string | null;
  updatedAt: string;
  verifiedIdentityCount: number;
  activeMemberCount: number;
  activeManagerCount: number;
  activationState: "unlinked" | "linked" | "projection_missing" | "manual_review" | "projected";
}

interface BootstrapSource {
  clientId: string;
  clientName: string;
  organizationId: string | null;
  organizationName: string | null;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
}

interface BootstrapState {
  workspaceMigrationApplied: boolean;
  accounts: BootstrapAccount[];
  sources: BootstrapSource[];
}

function sourceLabel(source: BootstrapSource): string {
  return source.organizationName
    ? `${source.organizationName} — ${source.clientName}`
    : `${source.clientName} — standalone client`;
}

function memberSummary(account: BootstrapAccount): string {
  const members = `${account.activeMemberCount.toLocaleString()} verified active member${account.activeMemberCount === 1 ? "" : "s"}`;
  const managers = `${account.activeManagerCount.toLocaleString()} manager${account.activeManagerCount === 1 ? "" : "s"}`;
  return `${members} · ${managers}`;
}

export function ClientPortalBootstrap({ onChanged }: { onChanged?: () => void }) {
  const [opened, setOpened] = useState(false);
  const [state, setState] = useState<BootstrapState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [accountId, setAccountId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const load = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true); setError("");
    try {
      const result = await api<BootstrapState>("/api/admin/client-account-activation", { signal: request.signal });
      if (request.signal.aborted) return;
      setState(result);
    } catch (caught) {
      if (!request.signal.aborted) setError(caught instanceof Error ? caught.message : "Client portal setup could not be loaded.");
    } finally {
      if (controller.current === request) { controller.current = null; setLoading(false); }
    }
  };

  useEffect(() => {
    if (opened && !state && !loading) void load();
    return () => controller.current?.abort();
  }, [opened]);

  const eligible = state?.accounts.filter(account => account.status === "active"
    && (account.activationState === "unlinked" || account.activationState === "projection_missing")) ?? [];
  const accountNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of state?.accounts ?? []) {
      const label = item.displayName.trim().toLocaleLowerCase();
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return counts;
  }, [state]);
  const uniqueEligible = eligible.filter(item => (accountNames.get(item.displayName.trim().toLocaleLowerCase()) || 0) === 1);
  const account = eligible.find(item => item.id === accountId) ?? uniqueEligible[0] ?? null;
  const accountAmbiguous = Boolean(account && (accountNames.get(account.displayName.trim().toLocaleLowerCase()) || 0) > 1);
  const sourceNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of state?.sources ?? []) {
      const label = sourceLabel(source).toLocaleLowerCase();
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return counts;
  }, [state]);
  const sources = state?.sources ?? [];
  const linkedSource = account?.activationState === "projection_missing"
    ? sources.find(item => item.clientId === account.projectAlphaClientId) ?? null : null;
  const source = linkedSource ?? sources.find(item => item.clientId === sourceId) ?? null;
  const sourceAmbiguous = Boolean(source && !linkedSource && (sourceNames.get(sourceLabel(source).toLocaleLowerCase()) || 0) > 1);
  const ready = Boolean(state?.workspaceMigrationApplied && account && source && account.activeMemberCount > 0 && !accountAmbiguous && !sourceAmbiguous);

  useEffect(() => {
    if (!accountId && uniqueEligible[0]) setAccountId(uniqueEligible[0].id);
  }, [accountId, uniqueEligible]);
  useEffect(() => {
    setReviewing(false);
    if (account?.activationState === "projection_missing") setSourceId(account.projectAlphaClientId || "");
    else if (sourceId && !sources.some(item => item.clientId === sourceId)) setSourceId("");
  }, [account?.id, account?.activationState, account?.projectAlphaClientId]);

  const activate = async () => {
    if (!ready || !account || !source || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await api(`/api/admin/client-account-activation/${encodeURIComponent(account.id)}`, {
        method: "POST",
        body: JSON.stringify({ projectAlphaClientId: source.clientId, expectedUpdatedAt: account.updatedAt }),
      });
      setMessage(`Portal workspace created for ${account.displayName}. Its existing verified members and explicit access rules were projected.`);
      setReviewing(false); setAccountId(""); setSourceId("");
      await load();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal setup could not be confirmed. Refresh its status before retrying.");
    } finally { setBusy(false); }
  };

  const projected = state?.accounts.filter(item => item.activationState === "projected").length ?? 0;
  const blocked = eligible.filter(item => item.activeMemberCount === 0);
  const manualReview = state?.accounts.filter(item => item.activationState === "manual_review").length ?? 0;

  return <Card title="Portal workspace coverage">
    <section id="client-portal-setup" className="client-portal-bootstrap" aria-label="Portal workspace coverage">
      <div className="client-portal-bootstrap-intro">
        <div><p>Project Alpha-backed client accounts are reconciled automatically after a successful sync.</p>
          <small>Workspace creation never grants access by itself. Only existing verified members and explicit grants are projected, and access can still be revoked from the client workspace.</small></div>
        <button type="button" className="button-ghost" aria-expanded={opened} aria-controls="client-portal-bootstrap-workflow"
          onClick={() => setOpened(value => !value)}>{opened ? "Close exceptions" : "Review legacy exceptions"}</button>
      </div>
      {opened && <div id="client-portal-bootstrap-workflow" className="client-portal-bootstrap-workflow" aria-busy={loading || busy}>
        {loading && !state && <p role="status">Checking portal setup readiness…</p>}
        {error && <div className="client-portal-bootstrap-error" role="alert"><p>{error}</p>
          <button type="button" className="button-ghost" disabled={loading || busy} onClick={() => void load()}>Refresh setup status</button></div>}
        {state && <>
          <ol className="client-portal-bootstrap-stages" aria-label="Portal setup stages">
            <li><strong>1. Eligibility</strong><span>Existing active client account and verified identity</span></li>
            <li><strong>2. Workspace</strong><span>One exact Project Alpha organization or standalone client</span></li>
            <li><strong>3. Membership</strong><span>Only existing verified account members</span></li>
            <li><strong>4. Access</strong><span>Only existing role and project grants</span></li>
          </ol>
          {!state.workspaceMigrationApplied && <p className="client-portal-bootstrap-warning" role="alert">Portal workspace storage is not ready in this deployment. Apply the Client portal migrations before setup.</p>}
          {eligible.length ? <div className="client-portal-bootstrap-form">
            <label>Existing client portal account
              <select value={account?.id || ""} disabled={busy} onChange={event => { setAccountId(event.target.value); setSourceId(""); setMessage(""); }}>
                {eligible.map(item => {
                  const duplicate = (accountNames.get(item.displayName.trim().toLocaleLowerCase()) || 0) > 1;
                  return <option key={item.id} value={item.id} disabled={duplicate}>{item.displayName}{item.activationState === "projection_missing" ? " — finish existing setup" : ""}{duplicate ? " — duplicate name; review client accounts" : ""}</option>;
                })}
              </select>
            </label>
            <label>Project Alpha workspace root
              <select value={source?.clientId || ""} disabled={busy || account?.activationState === "projection_missing"}
                onChange={event => { setSourceId(event.target.value); setReviewing(false); setMessage(""); }}>
                <option value="">Select an exact Project Alpha client</option>
                {sources.map(item => {
                  const duplicate = (sourceNames.get(sourceLabel(item).toLocaleLowerCase()) || 0) > 1;
                  return <option key={item.clientId} value={item.clientId} disabled={duplicate}>{sourceLabel(item)}{duplicate ? " — duplicate name; review in Project Alpha" : ""}</option>;
                })}
              </select>
            </label>
            {account && <div className="client-portal-bootstrap-readiness">
              <div><span>Eligibility</span><StatusPill tone={account.activeMemberCount ? "success" : "warning"}>{account.activeMemberCount ? "Verified" : "Member needed"}</StatusPill></div>
              <p>{memberSummary(account)}. {account.verifiedIdentityCount.toLocaleString()} current verified identity record{account.verifiedIdentityCount === 1 ? "" : "s"}.</p>
              {!account.activeMemberCount && <p>No workspace will be activated from this screen until this account has an explicit, verified member. Add or verify that membership through the existing client identity workflow first.</p>}
            </div>}
            {accountAmbiguous && <p className="client-portal-bootstrap-warning" role="alert">Client portal accounts have indistinguishable names. Rename or review those accounts before setup; this screen will not ask you to choose by an opaque identifier.</p>}
            {sourceAmbiguous && <p className="client-portal-bootstrap-warning" role="alert">Project Alpha contains indistinguishable client names. Resolve the duplicate there before setup; this screen will not ask you to choose by an opaque identifier.</p>}
            {!reviewing ? <button type="button" className="button-orange" disabled={!ready || busy} onClick={() => setReviewing(true)}>Review portal setup</button>
              : account && source && <div className="client-portal-bootstrap-review">
                <h3>Review before creating access</h3>
                <dl><dt>Portal account</dt><dd>{account.displayName}</dd><dt>Project Alpha root</dt><dd>{sourceLabel(source)}</dd>
                  <dt>Membership projected</dt><dd>{memberSummary(account)}</dd><dt>Initial access</dt><dd>Existing workspace, manager, and project grants only</dd></dl>
                <p>Members are eligible by default only because they already have a verified identity and explicit membership in this account. Any sign-in block or revoked membership still denies access.</p>
                <div><button type="button" className="button-ghost" disabled={busy} onClick={() => setReviewing(false)}>Back</button>
                  <button type="button" className="button-orange" disabled={busy} onClick={() => void activate()}>{busy ? "Creating portal workspace…" : "Create workspace and memberships"}</button></div>
              </div>}
          </div> : <EmptyState title="No client account is ready for setup" detail={manualReview
            ? `${manualReview} account${manualReview === 1 ? " needs" : "s need"} manual projection review before setup.`
            : projected ? "All exact-linked active client portal accounts are already projected." : "Automatic reconciliation is waiting for an exact Project Alpha link and a verified client membership."} />}
          {!!blocked.length && <p className="client-portal-bootstrap-warning">{blocked.length} active account{blocked.length === 1 ? " has" : "s have"} no verified active member and cannot produce a usable portal workspace yet.</p>}
          {!!projected && <p className="client-portal-bootstrap-footnote">{projected} client portal workspace{projected === 1 ? " is" : "s are"} already projected.</p>}
        </>}
        {message && <p className="client-portal-bootstrap-success" role="status">{message}</p>}
      </div>}
    </section>
  </Card>;
}
