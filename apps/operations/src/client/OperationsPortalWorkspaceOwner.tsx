import { useEffect, useState, type FormEvent } from "react";
import { operationsWorkspaceCsrf, recoverOperationsWorkspacePublication, reserveAndPublishOperationsFolder,
  reserveAndPublishOperationsWorkspace, revokeAndPublishOperationsFolder }
  from "./operations-portal-workspace-owner-api";

type RootKind = "organization" | "standalone_client";
const integer = (value: string) => Number.parseInt(value, 10);
type FolderAction = "reserve" | "revoke";
function FolderMutation({ action, csrf, busy, setBusy, setError, setResult, setRecoverOperationId }: Readonly<{
  action: FolderAction; csrf: string; busy: boolean; setBusy(value: boolean): void; setError(value: string): void;
  setResult(value: string): void; setRecoverOperationId(value: string): void;
}>) {
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResult("");
    const data = new FormData(event.currentTarget), value = (name: string) => String(data.get(name) ?? "").trim();
    try {
      const reason = value("folderReason"), publicationOperationId = crypto.randomUUID();
      const folder = action === "reserve" ? { operationId: crypto.randomUUID(), targetId: value("folderTargetId"),
        reservationId: value("reservationId"), expectedRevision: 0,
        expectedWorkspaceRevision: integer(value("expectedWorkspaceRevision")), externalProjectId: value("externalProjectId"),
        projectVersion: integer(value("projectVersion")), opsFolderProjectId: value("opsFolderProjectId"),
        opsDivisionId: value("opsDivisionId"), baseR2Prefix: value("baseR2Prefix"),
        baseMatchMethod: value("baseMatchMethod"), baseConfirmedBy: value("baseConfirmedBy"),
        baseConfirmedAt: value("baseConfirmedAt"), clientFolderBindingId: value("clientFolderBindingId"),
        selectedR2Prefix: value("selectedR2Prefix"), reason }
        : { operationId: crypto.randomUUID(), targetId: value("folderTargetId"), reservationId: value("reservationId"),
          expectedRevision: integer(value("folderRevision")), reason };
      const body = pending ?? { folder, publication: { operationId: publicationOperationId,
        publicationId: crypto.randomUUID(), snapshotId: crypto.randomUUID(), checkpointId: crypto.randomUUID(),
        invocationId: crypto.randomUUID(), expectedRevision: integer(value("publicationRevision")), reason } };
      setPending(body); const publication = body.publication;
      if (publication && typeof publication === "object" && "operationId" in publication
        && typeof publication.operationId === "string") setRecoverOperationId(publication.operationId);
      const response = action === "reserve" ? await reserveAndPublishOperationsFolder(csrf, body)
        : await revokeAndPublishOperationsFolder(csrf, body);
      setResult(JSON.stringify(response, null, 2));
      if (response && typeof response === "object" && "publicationState" in response
        && response.publicationState === "acknowledged") setPending(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "request_failed"); }
    finally { setBusy(false); }
  }
  return <form className="form-card" onSubmit={submit}><h2>{action === "reserve" ? "Reserve and publish selected folder" : "Revoke and publish selected folder"}</h2>
    <p>Copy exact immutable IDs and versions from the confirmed Operations source. No folder is discovered by this page.</p>
    <label>Workspace target UUID<input name="folderTargetId" required /></label>
    <label>Folder reservation UUID<input name="reservationId" required /></label>
    {action === "reserve" ? <>
      <label>Expected workspace revision<input name="expectedWorkspaceRevision" type="number" min="1" step="1" required /></label>
      <label>External project ID<input name="externalProjectId" maxLength={191} required /></label>
      <label>Project version<input name="projectVersion" type="number" min="1" step="1" required /></label>
      <label>Operations folder project ID<input name="opsFolderProjectId" maxLength={191} required /></label>
      <label>Operations division ID<input name="opsDivisionId" maxLength={191} required /></label>
      <label>Confirmed base R2 prefix<input name="baseR2Prefix" maxLength={1000} required /></label>
      <label>Base match method<input name="baseMatchMethod" maxLength={40} required /></label>
      <label>Base confirmed by<input name="baseConfirmedBy" maxLength={191} required /></label>
      <label>Base confirmed at<input name="baseConfirmedAt" maxLength={64} placeholder="ISO timestamp" required /></label>
      <label>Client folder binding ID<input name="clientFolderBindingId" maxLength={200} required /></label>
      <label>Exact selected R2 prefix<input name="selectedR2Prefix" maxLength={1000} required /></label>
    </> : <label>Current folder revision<input name="folderRevision" type="number" min="1" step="1" required /></label>}
    <label>Current publication revision<input name="publicationRevision" type="number" min="0" step="1" required /></label>
    <label>Reason<textarea name="folderReason" maxLength={500} required /></label>
    <button className="button-orange" disabled={busy || !csrf}>{action === "reserve" ? "Reserve folder and publish" : "Revoke folder and publish"}</button>
    {pending && <><p role="status">Exact folder and publication IDs are retained for safe replay.</p>
      <button type="button" className="button-ghost" disabled={busy} onClick={() => setPending(null)}>Discard retained request</button></>}
  </form>;
}
export function OperationsPortalWorkspaceOwner() {
  const [csrf, setCsrf] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [rootKind, setRootKind] = useState<RootKind>("organization");
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [recoverOperationId, setRecoverOperationId] = useState("");
  useEffect(() => { void operationsWorkspaceCsrf().then(setCsrf).catch(() => setError("This staging-only capability is unavailable.")); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResult("");
    const data = new FormData(event.currentTarget), text = (name: string) => String(data.get(name) ?? "").trim();
    try {
      const body = pending ?? { workspace: { operationId: crypto.randomUUID(), targetId: text("targetId"),
        clientAuthorityId: text("clientAuthorityId"), workspaceId: text("workspaceId"), rootKind,
        rootRecordId: text("rootRecordId"), rootRecordVersion: integer(text("rootRecordVersion")),
        relationshipVersion: rootKind === "organization" ? null : integer(text("relationshipVersion")),
        expectedRevision: 0, reason: text("reason") }, publication: { operationId: crypto.randomUUID(),
        publicationId: crypto.randomUUID(), snapshotId: crypto.randomUUID(), checkpointId: crypto.randomUUID(),
        invocationId: crypto.randomUUID(), expectedRevision: 0, reason: text("reason") } };
      setPending(body);
      const publication = body.publication;
      if (publication && typeof publication === "object" && "operationId" in publication
        && typeof publication.operationId === "string") setRecoverOperationId(publication.operationId);
      const response = await reserveAndPublishOperationsWorkspace(csrf, body);
      setResult(JSON.stringify(response, null, 2));
      if (response && typeof response === "object" && "publicationState" in response
        && response.publicationState === "acknowledged") setPending(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "request_failed"); }
    finally { setBusy(false); }
  }
  return <><header className="topbar"><a href="/">Exit workspace publication</a></header><main>
    <section className="page-heading"><p className="eyebrow">Staging owner control</p><h1>Create and publish a client workspace</h1>
      <p>Enter immutable directory IDs and source versions. This does not search or match by name or email.</p></section>
    <form className="form-card" onSubmit={submit}>
      <label>Target UUID<input name="targetId" required /></label>
      <label>Client authority UUID<input name="clientAuthorityId" required /></label>
      <label>Client portal workspace ID<input name="workspaceId" required maxLength={200} /></label>
      <label>Root type<select value={rootKind} onChange={event => setRootKind(event.target.value as RootKind)}>
        <option value="organization">Organization</option><option value="standalone_client">Standalone client</option>
      </select></label>
      <label>Exact root record ID<input name="rootRecordId" required maxLength={191} /></label>
      <label>Root record version<input name="rootRecordVersion" required type="number" min="1" step="1" /></label>
      {rootKind === "standalone_client" && <label>Client relationship version<input name="relationshipVersion" required type="number" min="1" step="1" /></label>}
      <label>Reason<textarea name="reason" required maxLength={500} /></label>
      <p>This creates the exact target once, takes a complete snapshot, and privately publishes it to the staging Clients service.</p>
      <button className="button-orange" disabled={busy || !csrf}>{busy ? "Publishing…" : "Create and publish exact workspace"}</button>
      {pending && <><p role="status">The exact request IDs are retained. Submit again to replay safely.</p>
        <button type="button" className="button-ghost" disabled={busy} onClick={() => setPending(null)}>Discard retained request</button></>}
    </form>
    <FolderMutation action="reserve" csrf={csrf} busy={busy} setBusy={setBusy} setError={setError}
      setResult={setResult} setRecoverOperationId={setRecoverOperationId} />
    <FolderMutation action="revoke" csrf={csrf} busy={busy} setBusy={setBusy} setError={setError}
      setResult={setResult} setRecoverOperationId={setRecoverOperationId} />
    <section className="form-card"><h2>Recover an uncertain publication</h2>
      <p>Use only the publication operation UUID from a request whose transport result was uncertain.</p>
      <label>Publication operation UUID<input value={recoverOperationId} onChange={event => setRecoverOperationId(event.target.value.trim())} /></label>
      <button className="button-ghost" disabled={busy || !csrf} onClick={() => { setBusy(true); setError("");
        void recoverOperationsWorkspacePublication(csrf, recoverOperationId, "Owner-requested staging publication recovery")
          .then(value => setResult(JSON.stringify(value, null, 2))).catch(caught => setError(caught instanceof Error ? caught.message : "request_failed"))
          .finally(() => setBusy(false)); }}>Check and recover publication</button>
    </section>{error && <p role="alert">{error}</p>}{result && <pre aria-live="polite">{result}</pre>}
  </main></>;
}
