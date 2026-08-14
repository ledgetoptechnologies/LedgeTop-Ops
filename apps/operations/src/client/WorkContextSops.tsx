import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";

export interface WorkContextSopLink {
  sopId: string;
  revisionId: string;
  revisionNumber: number;
  slug: string;
  title: string;
  purpose: string;
  publishedAt: string;
  linkedAt: string;
  archived: boolean;
  href: string;
}

interface PublishedSopSummary {
  id: string;
  slug: string;
  title: string;
  purpose: string;
  publishedRevisionId: string;
  publishedRevisionNumber: number;
}

interface WorkContextSopState {
  version: number;
  sops: WorkContextSopLink[];
  canEdit: boolean;
}

export function WorkContextSops({
  kind,
  contextId,
  initialLinks,
  initialVersion,
  canManage,
}: {
  kind: "project" | "task";
  contextId: string;
  initialLinks?: WorkContextSopLink[];
  initialVersion?: number;
  canManage?: boolean;
}) {
  const [links, setLinks] = useState(initialLinks || []);
  const [version, setVersion] = useState(initialVersion || 0);
  const [editable, setEditable] = useState(Boolean(canManage));
  const [available, setAvailable] = useState<PublishedSopSummary[]>([]);
  const [selection, setSelection] = useState<string[]>(
    (initialLinks || []).map(link => link.revisionId),
  );
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setLinks(initialLinks || []);
    setVersion(initialVersion || 0);
    setSelection((initialLinks || []).map(link => link.revisionId));
    setEditable(Boolean(canManage));
    setLoaded(false);
    setError("");
    setNotice("");
  }, [kind, contextId, initialLinks, initialVersion, canManage]);

  const choices = useMemo(() => {
    const values = new Map<string, {
      revisionId: string;
      title: string;
      purpose: string;
      revisionNumber: number;
      archived: boolean;
    }>();
    for (const item of available) values.set(item.publishedRevisionId, {
      revisionId: item.publishedRevisionId,
      title: item.title,
      purpose: item.purpose,
      revisionNumber: item.publishedRevisionNumber,
      archived: false,
    });
    for (const item of links) if (!values.has(item.revisionId)) values.set(item.revisionId, {
      revisionId: item.revisionId,
      title: item.title,
      purpose: item.purpose,
      revisionNumber: item.revisionNumber,
      archived: item.archived,
    });
    return [...values.values()].sort((left, right) => left.title.localeCompare(right.title));
  }, [available, links]);

  const loadEditor = async () => {
    if (loaded || busy || !canManage) return;
    setBusy(true);
    setError("");
    try {
      const [library, current] = await Promise.all([
        api<{ sops: PublishedSopSummary[] }>("/api/sops"),
        api<WorkContextSopState>(
          `/api/work-contexts/${kind}/${encodeURIComponent(contextId)}/sops`,
        ),
      ]);
      setAvailable(library.sops);
      setLinks(current.sops);
      setSelection(current.sops.map(link => link.revisionId));
      setVersion(current.version);
      setEditable(current.canEdit);
      setLoaded(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="work-context-sops" aria-label={`${kind === "project" ? "Project" : "Task"} quick SOPs`}>
      <div className="work-context-sop-heading">
        <strong>Quick SOPs</strong>
        {!!links.length && <span className="managed-badge">{links.length}</span>}
      </div>
      {links.length ? (
        <nav className="work-context-sop-chips" aria-label="Pinned SOP revisions">
          {links.map(link => (
            <a key={link.revisionId} href={link.href}>
              <span>{link.title}</span>
              <small>Revision {link.revisionNumber}{link.archived ? " · archived" : ""}</small>
            </a>
          ))}
        </nav>
      ) : (
        <small>No SOP revisions are pinned directly to this {kind}.</small>
      )}
      {canManage && (
        <details
          className="work-context-sop-manager"
          onToggle={event => {
            if (event.currentTarget.open) void loadEditor();
          }}
        >
          <summary>Manage quick SOPs</summary>
          <p>These links apply only to this {kind}; they do not inherit to related work.</p>
          {busy && <small role="status">Loading published SOPs…</small>}
          {error && <div className="notice error" role="alert">{error}</div>}
          {loaded && editable && (
            <>
              <fieldset disabled={busy}>
                <legend>Pin exact published revisions</legend>
                {choices.length ? choices.map(choice => (
                  <label key={choice.revisionId}>
                    <input
                      type="checkbox"
                      checked={selection.includes(choice.revisionId)}
                      onChange={event => setSelection(current => event.target.checked
                        ? [...current, choice.revisionId]
                        : current.filter(id => id !== choice.revisionId))}
                    />
                    <span>
                      <strong>{choice.title}</strong>
                      <small>Revision {choice.revisionNumber}{choice.archived ? " · archived; retained until removed" : ""} · {choice.purpose}</small>
                    </span>
                  </label>
                )) : <small>No published SOPs are available.</small>}
              </fieldset>
              <button
                type="button"
                className="button-orange button-small"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  setNotice("");
                  try {
                    const current = await api<WorkContextSopState>(
                      `/api/work-contexts/${kind}/${encodeURIComponent(contextId)}/sops`,
                      {
                        method: "PUT",
                        body: JSON.stringify({ expectedVersion: version, revisionIds: selection }),
                      },
                    );
                    setLinks(current.sops);
                    setSelection(current.sops.map(link => link.revisionId));
                    setVersion(current.version);
                    setEditable(current.canEdit);
                    setNotice("Quick SOP links saved.");
                  } catch (caught) {
                    if (caught instanceof ApiError && caught.status === 409)
                      setError("These links changed. Close and reopen this editor, then try again.");
                    else setError((caught as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Saving…" : "Save SOP links"}
              </button>
            </>
          )}
          {loaded && !editable && <small>You no longer have permission to change these links.</small>}
          {notice && <div className="notice" role="status">{notice}</div>}
        </details>
      )}
    </section>
  );
}
