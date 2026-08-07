import { useCallback, useEffect, useState } from "react";
import type { NavigationDestination } from "@ltds/shared";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import { NavigationActions } from "./NavigationActions";

interface ScopeItem {
  id: string;
  category: string;
  title: string;
  instructions: string;
  sortOrder: number;
  presetRef: string | null;
}

interface Attachment {
  id: string;
  versionAdded: number;
  sourceKind: "staff_upload" | "project_file";
  displayName: string;
  contentType: string;
  size: number;
  createdBy: { id: string; displayName: string };
  createdAt: string;
  contentUrl: string;
}

interface LinkedSop {
  sopId: string;
  revisionId: string;
  revisionNumber: number;
  slug: string;
  title: string;
  purpose: string;
  html: string;
  toc: Array<{ id: string; level: number; text: string }>;
  author: { id: string; displayName: string };
  publishedAt: string;
  linkedAt: string;
}

interface PublishedSopSummary {
  id: string;
  title: string;
  purpose: string;
  publishedRevisionId: string;
  publishedRevisionNumber: number;
}

interface JobBriefResponse {
  operation: {
    id: string;
    title: string;
    status: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    location: string | null;
    navigation: NavigationDestination | null;
  };
  brief: {
    version: number;
    items: ScopeItem[];
    attachments: Attachment[];
    sops?: LinkedSop[];
    createdAt: string;
    updatedAt: string;
    updatedBy: { id: string; displayName: string };
  } | null;
  history: Array<{
    version: number;
    changeKind: "scope_saved" | "attachment_added";
    author: { id: string; displayName: string };
    createdAt: string;
  }>;
  canEdit: boolean;
}

function date(value: string | null | undefined) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024, index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

function editableItems(value: JobBriefResponse): ScopeItem[] {
  return value.brief?.items.map(item => ({ ...item })) || [];
}

export function JobBriefPanel({
  operationId,
  canReferenceProjectFiles,
  onDirtyChange,
  close,
}: {
  operationId: string;
  canReferenceProjectFiles: boolean;
  onDirtyChange?(dirty: boolean): void;
  close(): void;
}) {
  const [data, setData] = useState<JobBriefResponse | null>(null);
  const [items, setItems] = useState<ScopeItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [projectKey, setProjectKey] = useState("");
  const [publishedSops, setPublishedSops] = useState<PublishedSopSummary[]>([]);
  const [sopSelection, setSopSelection] = useState<string[]>([]);
  const [sopDirty, setSopDirty] = useState(false);

  const load = useCallback(async (replaceDraft = false) => {
    try {
      const value = await api<JobBriefResponse>(
        `/api/operations/${encodeURIComponent(operationId)}/job-brief`,
      );
      setData(previous => {
        if (dirty && !replaceDraft && previous?.brief?.version !== value.brief?.version) {
          setNotice("A newer brief is available. Refresh before saving your draft.");
          // Keep the draft's original expectedVersion so Save must conflict;
          // never advance it behind a dirty editor.
          return previous;
        }
        return value;
      });
      if (!dirty || replaceDraft) {
        setItems(editableItems(value));
        setSopSelection(value.brief?.sops?.map(sop => sop.revisionId) || []);
        setDirty(false);
        setSopDirty(false);
        if (replaceDraft) setNotice("");
      }
      setError("");
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [operationId, dirty, sopDirty]);

  useEffect(() => {
    if (!data?.canEdit) return;
    void api<{ sops: PublishedSopSummary[] }>("/api/sops")
      .then(value => setPublishedSops(value.sops))
      .catch(caught => setError((caught as Error).message));
  }, [data?.canEdit]);

  useEffect(() => {
    onDirtyChange?.(dirty || sopDirty);
  }, [dirty, sopDirty, onDirtyChange]);

  useEffect(() => {
    void load();
  }, [operationId]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refresh, 8_000);
    addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const accept = (value: JobBriefResponse, message: string) => {
    setData(value);
    setItems(editableItems(value));
    setSopSelection(value.brief?.sops?.map(sop => sop.revisionId) || []);
    setDirty(false);
    setSopDirty(false);
    setError("");
    setNotice(message);
  };
  const mutationError = (caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 409) {
      const current = Number(caught.payload.currentVersion);
      setNotice(
        `Another staff member saved version ${Number.isFinite(current) ? current : "a newer version"}. Refresh to review it; your changes were not applied.`,
      );
    } else setError((caught as Error).message);
  };
  const version = data?.brief?.version || 0;

  if (!data && !error) return <Loading />;
  if (!data)
    return (
      <Card title="Operational job brief">
        <div className="notice error">{error}</div>
        <button className="button-ghost button-small" onClick={close}>Close</button>
      </Card>
    );

  return (
    <Card
      className="job-brief-panel"
      title={`Job brief · ${data.operation.title}`}
      action={
        <div className="job-brief-header-actions">
          <button
            className="button-ghost button-small"
            disabled={busy}
            onClick={() => void load(true)}
          >
            Refresh
          </button>
          <button className="button-ghost button-small" onClick={close}>Close</button>
        </div>
      }
    >
      <div className="record-badges">
        <StatusPill>{data.operation.status.replaceAll("_", " ")}</StatusPill>
        <span className="managed-badge">LTDS brief v{version}</span>
      </div>
      <p className="muted">
        Schedule and assignment remain managed in Project Alpha. This versioned brief is the LTDS execution source of truth.
      </p>
      <NavigationActions destination={data.operation.navigation} />
      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="job-brief-section" aria-labelledby="job-brief-scope-heading">
        <div className="job-brief-section-heading">
          <div>
            <h3 id="job-brief-scope-heading">Scope and instructions</h3>
            {data.brief && (
              <small>
                Updated {date(data.brief.updatedAt)} by {data.brief.updatedBy.displayName}
              </small>
            )}
          </div>
          {data.canEdit && (
            <button
              className="button-ghost button-small"
              disabled={busy}
              onClick={() => {
                setItems(current => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    category: "",
                    title: "",
                    instructions: "",
                    sortOrder: current.length,
                    presetRef: null,
                  },
                ]);
                setDirty(true);
              }}
            >
              Add scope item
            </button>
          )}
        </div>
        {data.canEdit ? (
          <div className="job-brief-items">
            {items.map((item, index) => (
              <fieldset className="job-brief-item-editor" key={item.id} disabled={busy}>
                <legend>Scope item {index + 1}</legend>
                <label>
                  Category
                  <input
                    value={item.category}
                    placeholder="Mapping mission"
                    maxLength={100}
                    onChange={event => {
                      setItems(current => current.map(candidate => candidate.id === item.id ? { ...candidate, category: event.target.value } : candidate));
                      setDirty(true);
                    }}
                  />
                </label>
                <label>
                  Title
                  <input
                    value={item.title}
                    placeholder="Orthomosaic capture"
                    maxLength={160}
                    onChange={event => {
                      setItems(current => current.map(candidate => candidate.id === item.id ? { ...candidate, title: event.target.value } : candidate));
                      setDirty(true);
                    }}
                  />
                </label>
                <label>
                  Operational instructions
                  <textarea
                    value={item.instructions}
                    placeholder="Altitude, front/side overlap, deliverables, and special notes"
                    maxLength={12_000}
                    rows={5}
                    onChange={event => {
                      setItems(current => current.map(candidate => candidate.id === item.id ? { ...candidate, instructions: event.target.value } : candidate));
                      setDirty(true);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="button-danger button-small"
                  onClick={() => {
                    setItems(current => current.filter(candidate => candidate.id !== item.id));
                    setDirty(true);
                  }}
                >
                  Remove
                </button>
              </fieldset>
            ))}
            {!items.length && (
              <EmptyState
                title="No scope items"
                detail="Add the first operational instruction item for the assigned pilot."
              />
            )}
            <button
              className="button-orange"
              disabled={busy || !dirty || items.some(item => !item.category.trim() || !item.title.trim() || !item.instructions.trim())}
              onClick={async () => {
                setBusy(true);
                try {
                  const value = await api<JobBriefResponse>(
                    `/api/operations/${encodeURIComponent(operationId)}/job-brief`,
                    {
                      method: "PUT",
                      body: JSON.stringify({
                        expectedVersion: version,
                        items: items.map(({ id, category, title, instructions, presetRef }) => ({ id, category, title, instructions, presetRef })),
                      }),
                    },
                  );
                  accept(value, `Saved version ${value.brief?.version}. Assigned pilots will see it on refresh.`);
                } catch (caught) {
                  mutationError(caught);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save brief
            </button>
          </div>
        ) : data.brief?.items.length ? (
          <div className="job-brief-items">
            {data.brief.items.map(item => (
              <article className="job-brief-scope-item" key={item.id}>
                <small>{item.category}</small>
                <h3>{item.title}</h3>
                <p>{item.instructions}</p>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Brief not published yet"
            detail="Operations has not added scope instructions for this job."
          />
        )}
      </section>

      <section className="job-brief-section" aria-labelledby="job-brief-sops-heading">
        <div className="job-brief-section-heading">
          <div>
            <h3 id="job-brief-sops-heading">Linked standard operating procedures</h3>
            <small>Each link is pinned to the exact published revision shown here.</small>
          </div>
        </div>
        {data.brief?.sops?.length ? (
          <div className="job-brief-sops">
            {data.brief.sops.map(sop => (
              <details key={sop.revisionId} className="job-brief-sop">
                <summary>
                  <span><strong>{sop.title}</strong><small>Revision {sop.revisionNumber} · published {date(sop.publishedAt)}</small></span>
                  <span>{sop.purpose}</span>
                </summary>
                <article className="sop-content" dangerouslySetInnerHTML={{ __html: sop.html }} />
              </details>
            ))}
          </div>
        ) : (
          <p className="muted">No SOP revisions are linked to this job.</p>
        )}
        {data.canEdit && (
          <div className="job-brief-sop-selector">
            <fieldset disabled={busy || dirty}>
              <legend>Published SOP revisions available to this job</legend>
              {publishedSops.length ? publishedSops.map(sop => (
                <label key={sop.publishedRevisionId}>
                  <input
                    type="checkbox"
                    checked={sopSelection.includes(sop.publishedRevisionId)}
                    onChange={event => {
                      setSopSelection(current => event.target.checked
                        ? [...current, sop.publishedRevisionId]
                        : current.filter(id => id !== sop.publishedRevisionId));
                      setSopDirty(true);
                    }}
                  />
                  <span><strong>{sop.title}</strong><small>Revision {sop.publishedRevisionNumber} · {sop.purpose}</small></span>
                </label>
              )) : <small>No published SOPs are available.</small>}
            </fieldset>
            <button
              className="button-orange button-small"
              disabled={busy || dirty || !sopDirty}
              onClick={async () => {
                setBusy(true);
                try {
                  const value = await api<JobBriefResponse>(
                    `/api/operations/${encodeURIComponent(operationId)}/job-brief/sops`,
                    { method: "PUT", body: JSON.stringify({ expectedVersion: version, revisionIds: sopSelection }) },
                  );
                  accept(value, `Saved linked SOPs in job brief version ${value.brief?.version}.`);
                } catch (caught) {
                  mutationError(caught);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save SOP links
            </button>
            {dirty && <small>Save or refresh the scope draft before changing SOP links.</small>}
          </div>
        )}
      </section>

      <section className="job-brief-section" aria-labelledby="job-brief-files-heading">
        <div className="job-brief-section-heading">
          <h3 id="job-brief-files-heading">References and flight-planning files</h3>
        </div>
        {data.brief?.attachments.length ? (
          <div className="job-brief-attachments">
            {data.brief.attachments.map(attachment => {
              const kml = /\.(kml|kmz)$/i.test(attachment.displayName) || attachment.contentType.includes("google-earth");
              return (
                <article key={attachment.id}>
                  <div>
                    <strong>{attachment.displayName}</strong>
                    <small>
                      {attachment.sourceKind === "staff_upload" ? "Staff attachment" : "Authorized client project file"} · {bytes(attachment.size)} · added in v{attachment.versionAdded}
                    </small>
                  </div>
                  <a className="button-ghost button-small" href={attachment.contentUrl}>
                    {kml ? "Download KML for flight planning" : "Download"}
                  </a>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="muted">No reference files are attached.</p>
        )}
        {data.canEdit && (
          <div className="job-brief-attachment-tools">
            <label>
              Upload a private reference
              <input type="file" onChange={event => setFile(event.target.files?.[0] || null)} />
            </label>
            <button
              className="button-orange button-small"
              disabled={!file || busy || dirty}
              onClick={async () => {
                if (!file) return;
                setBusy(true);
                try {
                  const value = await api<JobBriefResponse>(
                    `/api/operations/${encodeURIComponent(operationId)}/job-brief/attachments/upload`,
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": file.type || "application/octet-stream",
                        "X-Expected-Version": String(version),
                        "X-File-Name": file.name,
                      },
                      body: file,
                    },
                  );
                  setFile(null);
                  accept(value, `Attached ${file.name} in version ${value.brief?.version}.`);
                } catch (caught) {
                  mutationError(caught);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Attach file
            </button>
            {canReferenceProjectFiles && (
              <>
                <label>
                  Authorized client project file path
                  <input
                    value={projectKey}
                    onChange={event => setProjectKey(event.target.value)}
                    placeholder="Jobs/Clients/client/project/flight-plan.kml"
                  />
                </label>
                <button
                  className="button-ghost button-small"
                  disabled={!projectKey.trim() || busy || dirty}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const value = await api<JobBriefResponse>(
                        `/api/operations/${encodeURIComponent(operationId)}/job-brief/attachments/reference`,
                        {
                          method: "POST",
                          body: JSON.stringify({ expectedVersion: version, objectKey: projectKey }),
                        },
                      );
                      setProjectKey("");
                      accept(value, `Attached the authorized project file in version ${value.brief?.version}.`);
                    } catch (caught) {
                      mutationError(caught);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Attach project file
                </button>
              </>
            )}
            {dirty && <small>Save or refresh the scope draft before attaching files.</small>}
          </div>
        )}
      </section>

      <section className="job-brief-section" aria-labelledby="job-brief-history-heading">
        <h3 id="job-brief-history-heading">Version history</h3>
        {data.history.length ? (
          <ol className="job-brief-history">
            {data.history.map(entry => (
              <li key={entry.version}>
                <strong>Version {entry.version}</strong>
                <span>{entry.changeKind === "scope_saved" ? "Scope saved" : "Attachment added"}</span>
                <small>{entry.author.displayName} · {date(entry.createdAt)}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No versions have been published.</p>
        )}
      </section>
    </Card>
  );
}
