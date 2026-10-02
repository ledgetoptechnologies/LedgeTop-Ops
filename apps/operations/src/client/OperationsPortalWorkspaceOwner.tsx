import { useEffect, useState, type FormEvent } from "react";
import { operationsWorkspaceCsrf, recoverOperationsWorkspacePublication, reserveAndPublishOperationsWorkspace }
  from "./operations-portal-workspace-owner-api";

type RootKind = "organization" | "standalone_client";
const integer = (value: string) => Number.parseInt(value, 10);
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
