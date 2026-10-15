import { useEffect, useState, type FormEvent } from "react";
import { operationsWorkspaceCsrf, recoverOperationsWorkspacePublication, reserveAndPublishOperationsFolder,
  reserveAndPublishOperationsWorkspace, refreshAndPublishOperationsWorkspace, revokeAndPublishOperationsFolder,
  lookupOperationsProjectFolder, confirmOperationsProjectFolder }
  from "./operations-portal-workspace-owner-api";
import type { OperationsPortalSharedProjectFolder } from "../worker/operations-portal-shared-project-folders";
import { assertSameFolderRetry, assertSameWorkspaceRetry } from "./operations-folder-retry";

type RootKind = "organization" | "standalone_client";
const integer = (value: string) => Number.parseInt(value, 10);
type FolderAction = "reserve" | "revoke";
type RefreshPublicationRequest = Readonly<{ targetId: string; publication: Readonly<{
  operationId: string; publicationId: string; snapshotId: string; checkpointId: string; invocationId: string;
  expectedRevision: number; reason: string;
}> }>;
export function prepareOperationsWorkspaceRefreshRequest(pending: RefreshPublicationRequest | null,
  targetId: string, expectedRevision: number, reason: string): RefreshPublicationRequest {
  if (pending) {
    if (pending.targetId !== targetId || pending.publication.expectedRevision !== expectedRevision
      || pending.publication.reason !== reason)
      throw new Error("Discard the retained refresh request before changing its target, revision, or reason.");
    return pending;
  }
  return { targetId, publication: { operationId: crypto.randomUUID(), publicationId: crypto.randomUUID(),
    snapshotId: crypto.randomUUID(), checkpointId: crypto.randomUUID(), invocationId: crypto.randomUUID(),
    expectedRevision, reason } };
}
function RefreshPublication({ csrf, busy, setBusy, setError, setResult, setRecoverOperationId }: Readonly<{
  csrf: string; busy: boolean; setBusy(value: boolean): void; setError(value: string): void;
  setResult(value: string): void; setRecoverOperationId(value: string): void;
}>) {
  const [pending, setPending] = useState<RefreshPublicationRequest | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResult("");
    const data = new FormData(event.currentTarget), value = (name: string) => String(data.get(name) ?? "").trim();
    try {
      const body = prepareOperationsWorkspaceRefreshRequest(pending, value("refreshTargetId"),
        integer(value("refreshPublicationRevision")), value("refreshReason"));
      setPending(body); setRecoverOperationId(body.publication.operationId);
      const response = await refreshAndPublishOperationsWorkspace(csrf, body);
      setResult(JSON.stringify(response, null, 2));
      if (response && typeof response === "object" && "publicationState" in response
        && response.publicationState === "acknowledged") setPending(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "request_failed"); }
    finally { setBusy(false); }
  }
  return <form className="form-card" onSubmit={submit}><h2>Refresh and publish current workspace topology</h2>
    <p>This publishes a fresh snapshot of current workspace membership. It does not grant or revoke a folder or recipient.</p>
    <label>Workspace target UUID<input name="refreshTargetId" required /></label>
    <label>Current publication revision<input name="refreshPublicationRevision" type="number" min="1" step="1" required /></label>
    <label>Reason<textarea name="refreshReason" maxLength={500} required /></label>
    <button className="button-orange" disabled={busy || !csrf}>{busy ? "Publishing…" : "Refresh and publish current topology"}</button>
    {pending && <><p role="status">Exact publication IDs are retained. Submit again unchanged to replay safely.</p>
      <button type="button" className="button-ghost" disabled={busy} onClick={() => setPending(null)}>Discard retained refresh</button></>}
  </form>;
}
function FolderProof({ csrf, busy, setBusy, setError, proof, setProof }: Readonly<{
  csrf: string; busy: boolean; setBusy(value: boolean): void; setError(value: string): void;
  proof: OperationsPortalSharedProjectFolder | null; setProof(value: OperationsPortalSharedProjectFolder | null): void;
}>) {
  const [targetId, setTargetId] = useState(""), [externalProjectId, setExternalProjectId] = useState("");
  const [divisionId, setDivisionId] = useState(""), [prefix, setPrefix] = useState("");
  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setProof(null);
    try { const current = await lookupOperationsProjectFolder(targetId.trim(), externalProjectId.trim());
      setProof(current); setDivisionId(current.association?.opsDivisionId ?? ""); setPrefix(current.association?.baseR2Prefix ?? "");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "request_failed"); }
    finally { setBusy(false); }
  }
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!proof) return; setBusy(true); setError("");
    try { setProof(await confirmOperationsProjectFolder(csrf, { targetId: proof.targetId, externalProjectId: proof.externalProjectId,
      expectedProjectVersion: proof.projectVersion, expectedAssociation: proof.association,
      opsDivisionId: divisionId.trim(), baseR2Prefix: prefix.trim() }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "request_failed"); }
    finally { setBusy(false); }
  }
  return <section className="form-card"><h2>Load and confirm a native project folder</h2>
    <p>Select an exact shared project within this workspace. Confirmation does not share data or change public links.</p>
    <form onSubmit={lookup}>
      <label>Workspace target UUID<input value={targetId} required onChange={event => { setTargetId(event.target.value); setProof(null); }} /></label>
      <label>External project ID<input value={externalProjectId} maxLength={191} required onChange={event => { setExternalProjectId(event.target.value); setProof(null); }} /></label>
      <button type="submit" className="button-ghost" disabled={busy || !csrf}>Load authorized project folder</button>
    </form>
    {proof && <><p role="status">{proof.projectName} — project version {proof.projectVersion}. {proof.association ? "Folder proof loaded." : "No confirmed folder yet."}</p>
      <form onSubmit={confirm}>
        <label>Destination division ID<input value={divisionId} maxLength={191} required onChange={event => setDivisionId(event.target.value)} /></label>
        <label>Exact base R2 prefix<input value={prefix} maxLength={1000} required onChange={event => setPrefix(event.target.value)} /></label>
        <button type="submit" className="button-ghost" disabled={busy || !csrf}>Confirm exact native folder</button>
      </form></>}
  </section>;
}
function FolderMutation({ action, csrf, busy, setBusy, setError, setResult, setRecoverOperationId, folderProof }: Readonly<{
  action: FolderAction; csrf: string; busy: boolean; setBusy(value: boolean): void; setError(value: string): void;
  setResult(value: string): void; setRecoverOperationId(value: string): void; folderProof?: OperationsPortalSharedProjectFolder | null;
}>) {
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResult("");
    const data = new FormData(event.currentTarget), value = (name: string) => String(data.get(name) ?? "").trim();
    try {
      if (action === "reserve" && (!folderProof?.association || folderProof.targetId !== value("folderTargetId")
        || folderProof.externalProjectId !== value("externalProjectId"))) throw new Error("Load and confirm the exact project folder first.");
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
      assertSameFolderRetry(pending, folder, integer(value("publicationRevision")), reason);
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
    <p>{action === "reserve" ? "Project and folder proof fields below are loaded from the authorized Operations source." : "Revoke only the exact selected reservation."}</p>
    <label>Workspace target UUID{action === "reserve" ? <input name="folderTargetId" required readOnly value={folderProof?.targetId ?? ""} /> : <input name="folderTargetId" required />}</label>
    <label>Folder reservation UUID<input name="reservationId" required /></label>
    {action === "reserve" ? <>
      <label>Expected workspace revision<input name="expectedWorkspaceRevision" type="number" min="1" step="1" required /></label>
      <label>External project ID<input name="externalProjectId" readOnly value={folderProof?.externalProjectId ?? ""} required /></label>
      <label>Project version<input name="projectVersion" readOnly value={folderProof?.projectVersion ?? ""} required /></label>
      <label>Operations folder project ID<input name="opsFolderProjectId" readOnly value={folderProof?.association?.opsFolderProjectId ?? ""} required /></label>
      <label>Operations division ID<input name="opsDivisionId" readOnly value={folderProof?.association?.opsDivisionId ?? ""} required /></label>
      <label>Confirmed base R2 prefix<input name="baseR2Prefix" readOnly value={folderProof?.association?.baseR2Prefix ?? ""} required /></label>
      <label>Base match method<input name="baseMatchMethod" readOnly value={folderProof?.association?.baseMatchMethod ?? ""} required /></label>
      <label>Base confirmed by<input name="baseConfirmedBy" readOnly value={folderProof?.association?.baseConfirmedBy ?? ""} required /></label>
      <label>Base confirmed at<input name="baseConfirmedAt" readOnly value={folderProof?.association?.baseConfirmedAt ?? ""} required /></label>
      <label>Client folder binding ID<input name="clientFolderBindingId" maxLength={200} required /></label>
      <label>Exact selected R2 prefix<input name="selectedR2Prefix" maxLength={1000} required /></label>
    </> : <label>Current folder revision<input name="folderRevision" type="number" min="1" step="1" required /></label>}
    <label>Current publication revision<input name="publicationRevision" type="number" min="0" step="1" required /></label>
    <label>Reason<textarea name="folderReason" maxLength={500} required /></label>
    <button className="button-orange" disabled={busy || !csrf || (action === "reserve" && !folderProof?.association)}>{action === "reserve" ? "Reserve folder and publish" : "Revoke folder and publish"}</button>
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
  const [folderProof, setFolderProof] = useState<OperationsPortalSharedProjectFolder | null>(null);
  useEffect(() => { void operationsWorkspaceCsrf().then(setCsrf).catch(() => setError("This staging-only capability is unavailable.")); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResult("");
    const data = new FormData(event.currentTarget), text = (name: string) => String(data.get(name) ?? "").trim();
    try {
      const workspace = { operationId: crypto.randomUUID(), targetId: text("targetId"),
        clientAuthorityId: text("clientAuthorityId"), workspaceId: text("workspaceId"), rootKind,
        rootRecordId: text("rootRecordId"), rootRecordVersion: integer(text("rootRecordVersion")),
        relationshipVersion: rootKind === "organization" ? null : integer(text("relationshipVersion")),
        expectedRevision: 0, reason: text("reason") };
      assertSameWorkspaceRetry(pending, workspace);
      const body = pending ?? { workspace, publication: { operationId: crypto.randomUUID(),
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
    <RefreshPublication csrf={csrf} busy={busy} setBusy={setBusy} setError={setError} setResult={setResult}
      setRecoverOperationId={setRecoverOperationId} />
    <FolderProof csrf={csrf} busy={busy} setBusy={setBusy} setError={setError} proof={folderProof} setProof={setFolderProof} />
    <FolderMutation action="reserve" csrf={csrf} busy={busy} setBusy={setBusy} setError={setError} folderProof={folderProof}
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
