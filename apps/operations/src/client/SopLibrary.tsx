import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import { renderSopMarkdown, type SopTocItem } from "../sop-markdown";
import { api, ApiError } from "./api";
import { readSopMarkdownFile } from "./sop-markdown-import";

const SopMarkdownEditor = lazy(() => import("./SopMarkdownEditor").then(module => ({
  default: module.SopMarkdownEditor,
})));

type SopStatus = "draft" | "published" | "archived";

interface SopAuthor {
  id?: string;
  displayName?: string;
  email?: string;
}

interface SopRevision {
  id: string;
  revisionNumber: number;
  title?: string;
  purpose?: string;
  markdownBody?: string;
  sanitizedHtml?: string;
  html?: string;
  toc?: SopTocItem[];
  author?: SopAuthor | string;
  createdAt: string;
  publishedAt?: string | null;
}

interface SopDocument {
  id: string;
  title: string;
  slug: string;
  purpose: string;
  status: SopStatus;
  version: number;
  createdAt?: string;
  updatedAt: string;
  publishedAt?: string | null;
  author?: SopAuthor | string;
  draftRevisionNumber?: number | null;
  publishedRevisionNumber?: number | null;
  draftRevision?: SopRevision | null;
  publishedRevision?: SopRevision | null;
  revision?: SopRevision;
  revisions?: SopRevision[];
}

interface SopListResponse {
  sops: SopDocument[];
}

interface SopDetailResponse {
  sop: SopDocument;
  revisions?: SopRevision[];
}

interface SopUser {
  isAdministrator: boolean;
  permissions: readonly string[];
}

interface EditorValue {
  title: string;
  slug: string;
  purpose: string;
  markdownBody: string;
}

const EMPTY_EDITOR: EditorValue = {
  title: "",
  slug: "",
  purpose: "",
  markdownBody: "",
};

const STARTER_TEMPLATES: Array<{ id: string; label: string; value: EditorValue }> = [
  {
    id: "general-flight",
    label: "General flight",
    value: {
      title: "General Flight Operations",
      slug: "general-flight-operations",
      purpose: "Standard preparation, execution, and closeout steps for routine flight operations.",
      markdownBody: `# General Flight Operations

## Before departure

- [ ] Confirm assignment, site contact, and current job brief.
- [ ] Review airspace, weather, aircraft status, and required authorizations.
- [ ] Verify batteries, controller, media, and safety equipment.

## On site

1. Complete the site assessment and identify hazards.
2. Establish the launch area and maintain required separation.
3. Brief the crew and confirm the mission plan before takeoff.

## Closeout

- Confirm files are complete before leaving the site.
- Record exceptions, incidents, or follow-up needs in the job brief workflow.
`,
    },
  },
  {
    id: "mapping",
    label: "Mapping mission",
    value: {
      title: "Mapping Mission",
      slug: "mapping-mission",
      purpose: "Repeatable field guidance for collecting mapping imagery against an approved job brief.",
      markdownBody: `# Mapping Mission

## Mission inputs

| Input | Confirm |
| --- | --- |
| Boundary and exclusions | Matches the linked job files |
| Altitude and overlap | Matches the scoped instructions |
| Coordinate reference | Recorded for processing |

## Capture

- Fly the approved grid and monitor coverage throughout the mission.
- Re-fly gaps while conditions and authorization permit.
- Capture any required ground control or checkpoints exactly as briefed.

> The linked job brief controls mission-specific altitude, overlap, and deliverables.
`,
    },
  },
  {
    id: "imagery",
    label: "Imagery capture",
    value: {
      title: "Operational Imagery Capture",
      slug: "operational-imagery-capture",
      purpose: "Consistent capture and quality-review steps for still and motion imagery.",
      markdownBody: `# Operational Imagery Capture

## Shot plan

- Confirm subjects, orientations, exclusions, and delivery format.
- Capture establishing, context, and detail views where requested.
- Avoid collecting unrelated private activity or property.

## Quality review

- Check focus, exposure, motion, horizon, and complete subject coverage.
- Preserve original media and do not rename or remove files in the field.
- Document any missed view or environmental limitation before closeout.
`,
    },
  },
];

function formatDate(value?: string | null): string {
  if (!value) return "Not published";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function authorName(value?: SopAuthor | string): string {
  if (!value) return "LTDS Operations";
  if (typeof value === "string") return value;
  return value.displayName || value.email || "LTDS Operations";
}

function tone(status: SopStatus): "neutral" | "success" | "warning" {
  return status === "published" ? "success" : status === "draft" ? "warning" : "neutral";
}

function responseSop(value: SopDetailResponse | SopDocument): SopDocument {
  const sop = "sop" in value ? value.sop : value;
  const current = sop.draftRevision || sop.publishedRevision || sop.revision;
  return {
    ...sop,
    title: sop.title || current?.title || "Untitled SOP",
    purpose: sop.purpose || current?.purpose || "Internal Operations procedure.",
  };
}

function responseRevisions(value: SopDetailResponse | SopDocument): SopRevision[] {
  if ("sop" in value) return value.revisions || value.sop.revisions || [];
  return value.revisions || [];
}

function publishedRevision(sop: SopDocument): SopRevision | null {
  return sop.revision || sop.publishedRevision || null;
}

function revisionHtml(revision: SopRevision): string {
  return revision.sanitizedHtml || revision.html || "";
}

function versionHeaders(version: number): HeadersInit {
  return { "If-Match": `"sop-${version}"` };
}

function pathSlug(): string | null {
  const parts = location.pathname.split("/").filter(Boolean);
  return parts[0] === "sops" && parts.length === 2 ? decodeURIComponent(parts[1]!) : null;
}

export function SopLibrary({ user }: { user: SopUser }) {
  const canManage = user.isAdministrator && user.permissions.includes("sops.manage");
  const [workspace, setWorkspace] = useState<"library" | "admin">("library");
  const [slug, setSlug] = useState(pathSlug);

  useEffect(() => {
    const sync = () => {
      setSlug(pathSlug());
      setWorkspace("library");
    };
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);

  const showLibrary = () => {
    if (location.pathname !== "/sops") history.pushState(null, "", "/sops");
    setSlug(null);
    setWorkspace("library");
    window.scrollTo(0, 0);
  };

  return (
    <section className="sop-page">
      {canManage && !slug && (
        <nav className="sop-workspace-tabs" role="tablist" aria-label="SOP library views">
          <button
            role="tab"
            aria-selected={workspace === "library"}
            className={workspace === "library" ? "active" : ""}
            onClick={showLibrary}
          >
            Published library
          </button>
          <button
            role="tab"
            aria-selected={workspace === "admin"}
            className={workspace === "admin" ? "active" : ""}
            onClick={() => setWorkspace("admin")}
          >
            Admin workspace
          </button>
        </nav>
      )}
      {workspace === "admin" && canManage && !slug ? (
        <SopAdminWorkspace />
      ) : (
        <PublishedSopLibrary
          slug={slug}
          open={(nextSlug) => {
            history.pushState(null, "", `/sops/${encodeURIComponent(nextSlug)}`);
            setSlug(nextSlug);
            window.scrollTo(0, 0);
          }}
          back={showLibrary}
        />
      )}
    </section>
  );
}

function PublishedSopLibrary({
  slug,
  open,
  back,
}: {
  slug: string | null;
  open(slug: string): void;
  back(): void;
}) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<SopDocument[] | null>(null);
  const [detail, setDetail] = useState<SopDocument | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (slug) {
      setDetail(null);
      setError("");
      api<SopDetailResponse | SopDocument>(`/api/sops/${encodeURIComponent(slug)}`)
        .then((value) => setDetail(responseSop(value)))
        .catch((caught) => setError((caught as Error).message));
      return;
    }
    let current = true;
    setError("");
    api<SopListResponse>(`/api/sops${search ? `?search=${encodeURIComponent(search)}` : ""}`)
      .then((value) => {
        if (current) setItems(value.sops);
      })
      .catch((caught) => {
        if (current) setError((caught as Error).message);
      });
    return () => {
      current = false;
    };
  }, [slug, search]);

  if (slug) {
    if (!detail && !error) return <Loading />;
    if (!detail)
      return (
        <>
          <button className="button-ghost sop-back" onClick={back}>← SOP library</button>
          <div className="notice error">{error}</div>
        </>
      );
    const revision = publishedRevision(detail);
    if (!revision)
      return (
        <>
          <button className="button-ghost sop-back" onClick={back}>← SOP library</button>
          <EmptyState title="SOP unavailable" detail="No published revision is available." />
        </>
      );
    return <SopReader sop={detail} revision={revision} back={back} />;
  }

  return (
    <>
      <div className="section-actions sop-library-actions">
        <label className="visually-hidden" htmlFor="sop-library-search">Search SOPs</label>
        <input
          id="sop-library-search"
          className="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search published SOPs"
        />
      </div>
      {error && <div className="notice error">{error}</div>}
      {!items && !error ? (
        <Loading />
      ) : items?.length ? (
        <div className="sop-library-grid">
          {items.map((sop) => (
            <Card key={sop.id} className="sop-library-card">
              <div className="record-badges">
                <StatusPill tone="success">Published</StatusPill>
                <span className="managed-badge">
                  Revision {sop.publishedRevisionNumber || sop.publishedRevision?.revisionNumber || sop.revision?.revisionNumber || "—"}
                </span>
              </div>
              <h2>{sop.title}</h2>
              <p>{sop.purpose}</p>
              <small>Published {formatDate(sop.publishedAt || sop.publishedRevision?.publishedAt || sop.revision?.publishedAt)}</small>
              <button className="button-orange" onClick={() => open(sop.slug)}>Read SOP</button>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            title={search ? "No matching SOPs" : "No published SOPs"}
            detail={search ? "Try a different title or purpose." : "Published Operations procedures will appear here."}
          />
        </Card>
      )}
    </>
  );
}

function SopReader({
  sop,
  revision,
  back,
}: {
  sop: SopDocument;
  revision: SopRevision;
  back(): void;
}) {
  const toc = revision.toc || [];
  return (
    <article className="sop-reader">
      <div className="sop-reader-actions sop-no-print">
        <button className="button-ghost sop-back" onClick={back}>← SOP library</button>
        <button className="button-ghost" onClick={() => window.print()}>Print</button>
      </div>
      <header className="sop-document-heading">
        <span className="eyebrow">Published internal SOP</span>
        <h1>{sop.title}</h1>
        <p>{sop.purpose}</p>
        <div className="sop-attribution">
          <StatusPill tone="success">Revision {revision.revisionNumber}</StatusPill>
          <span>Published {formatDate(revision.publishedAt || sop.publishedAt)}</span>
          <span>By {authorName(revision.author || sop.author)}</span>
        </div>
      </header>
      <div className="sop-reader-layout">
        {toc.length > 0 && (
          <nav className="sop-toc" aria-label="Table of contents">
            <strong>On this page</strong>
            <ol>
              {toc.map((item) => (
                <li key={item.id} style={{ paddingLeft: `${Math.max(0, item.level - 1) * 0.7}rem` }}>
                  <a href={`#${item.id}`}>{item.text}</a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <Card className="sop-document-card">
          {revisionHtml(revision) ? (
            <div className="sop-markdown" dangerouslySetInnerHTML={{ __html: revisionHtml(revision) }} />
          ) : (
            <EmptyState title="Rendered SOP unavailable" detail="Refresh the page or contact Operations." />
          )}
        </Card>
      </div>
    </article>
  );
}

function SopAdminWorkspace() {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<SopDocument[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const value = await api<SopListResponse>(
        `/api/admin/sops${search ? `?search=${encodeURIComponent(search)}` : ""}`,
      );
      setItems(value.sops);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  if (selectedId || creating)
    return (
      <SopAdminEditor
        sopId={selectedId}
        close={async () => {
          setSelectedId(null);
          setCreating(false);
          await load();
        }}
      />
    );

  return (
    <>
      <div className="section-actions sop-library-actions">
        <label className="visually-hidden" htmlFor="sop-admin-search">Search SOP administration</label>
        <input
          id="sop-admin-search"
          className="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search titles, slugs, or purposes"
        />
        <button className="button-orange" onClick={() => setCreating(true)}>Create SOP</button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {!items && !error ? (
        <Loading />
      ) : items?.length ? (
        <Card className="table-card sop-admin-table">
          <table>
            <thead>
              <tr>
                <th>SOP</th>
                <th>Status</th>
                <th>Revision</th>
                <th>Published</th>
                <th><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((sop) => (
                <tr key={sop.id}>
                  <td>
                    <strong>{sop.title}</strong>
                    <small>/{sop.slug} · {sop.purpose}</small>
                  </td>
                  <td><StatusPill tone={tone(sop.status)}>{sop.status}</StatusPill></td>
                  <td>
                    <span>Draft {sop.draftRevisionNumber || sop.draftRevision?.revisionNumber || "—"}</span>
                    <small>Published {sop.publishedRevisionNumber || sop.publishedRevision?.revisionNumber || "—"}</small>
                  </td>
                  <td>{formatDate(sop.publishedAt)}</td>
                  <td>
                    <button className="button-ghost button-small" onClick={() => setSelectedId(sop.id)}>
                      Edit and inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <Card>
          <EmptyState title="No SOPs found" detail="Create a procedure or change the search terms." />
        </Card>
      )}
    </>
  );
}

function SopAdminEditor({ sopId, close }: { sopId: string | null; close(): void }) {
  const importInput = useRef<HTMLInputElement>(null);
  const [sop, setSop] = useState<SopDocument | null>(null);
  const [revisions, setRevisions] = useState<SopRevision[]>([]);
  const [value, setValue] = useState<EditorValue>(EMPTY_EDITOR);
  const [templateId, setTemplateId] = useState(STARTER_TEMPLATES[0]!.id);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const preview = useMemo(() => renderSopMarkdown(value.markdownBody), [value.markdownBody]);

  const adopt = useCallback((response: SopDetailResponse | SopDocument) => {
    const next = responseSop(response);
    const draft = next.draftRevision || next.publishedRevision || next.revision;
    setSop(next);
    setRevisions(responseRevisions(response));
    setValue({
      title: next.title,
      slug: next.slug,
      purpose: next.purpose,
      markdownBody: draft?.markdownBody || "",
    });
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    const activeId = sopId || sop?.id;
    if (!activeId) return;
    setError("");
    try {
      adopt(await api<SopDetailResponse | SopDocument>(`/api/admin/sops/${encodeURIComponent(activeId)}`));
      setNotice("");
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [sopId, sop?.id, adopt]);

  useEffect(() => {
    if (sopId) void load();
  }, [sopId]);

  const setField = <K extends keyof EditorValue>(field: K, next: EditorValue[K]) => {
    setValue((current) => ({ ...current, [field]: next }));
    setDirty(true);
  };

  const mutationError = (caught: unknown) => {
    if (
      caught instanceof ApiError &&
      caught.status === 409 &&
      Object.hasOwn(caught.payload, "currentVersion")
    ) {
      const current = Number(caught.payload.currentVersion);
      setNotice(
        `Another administrator saved ${Number.isFinite(current) ? `version ${current}` : "a newer version"}. Refresh to review it; your changes were not applied.`,
      );
    } else setError((caught as Error).message);
  };

  const runVersioned = async (
    path: string,
    body: Record<string, unknown>,
    success: string,
  ) => {
    if (!sop) return;
    setBusy(true);
    setError("");
    try {
      const response = await api<SopDetailResponse | SopDocument>(path, {
        method: "POST",
        headers: versionHeaders(sop.version),
        body: JSON.stringify({ expectedVersion: sop.version, ...body }),
      });
      adopt(response);
      setNotice(success);
    } catch (caught) {
      mutationError(caught);
    } finally {
      setBusy(false);
    }
  };

  const invalid =
    !value.title.trim() ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug) ||
    !value.purpose.trim() ||
    !value.markdownBody.trim();
  if (sopId && !sop && !error) return <Loading />;

  return (
    <div className="sop-admin-editor">
      <div className="sop-editor-toolbar sop-no-print">
        <button
          className="button-ghost"
          onClick={() => {
            if (dirty && !window.confirm("Discard the unsaved SOP draft?")) return;
            close();
          }}
        >
          ← Admin library
        </button>
        {sop && (
          <button className="button-ghost" disabled={busy} onClick={() => void load()}>
            Refresh latest
          </button>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      <div className="sop-editor-meta">
        <div>
          <span className="eyebrow">{sop ? "SOP administration" : "New internal SOP"}</span>
          <h2>{sop?.title || "Create an SOP"}</h2>
        </div>
        {sop && (
          <div className="record-badges">
            <StatusPill tone={tone(sop.status)}>{sop.status}</StatusPill>
            <span className="managed-badge">Record version {sop.version}</span>
          </div>
        )}
      </div>
      <Card className="sop-template-card sop-no-print" title="Safe starter template">
        <div className="sop-template-controls">
          <label>
            Template
            <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              {STARTER_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>{template.label}</option>
              ))}
            </select>
          </label>
          <button
            className="button-ghost"
            disabled={busy}
            onClick={() => {
              if (dirty && !window.confirm("Replace the current draft with this starter template?")) return;
              const template = STARTER_TEMPLATES.find((candidate) => candidate.id === templateId)!;
              setValue({ ...template.value, slug: sop?.slug || template.value.slug });
              setDirty(true);
            }}
          >
            Apply template
          </button>
        </div>
      </Card>
      <div className="sop-editor-grid">
        <Card title="Markdown editor" className="sop-editor-fields">
          <div className="form-grid">
            <label>
              Title
              <input value={value.title} maxLength={160} onChange={(event) => setField("title", event.target.value)} />
            </label>
            <label>
              Stable slug
              <input
                value={value.slug}
                maxLength={80}
                disabled={Boolean(sop)}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder="flight-safety-review"
                onChange={(event) => setField("slug", event.target.value.toLowerCase())}
              />
            </label>
            <label className="full">
              Short purpose
              <textarea value={value.purpose} maxLength={500} rows={3} onChange={(event) => setField("purpose", event.target.value)} />
            </label>
            <div className="full sop-markdown-field">
              <strong>Markdown body</strong>
              <span className="sop-editor-hint">Use the toolbar for rich-text editing or switch to Source for canonical Markdown.</span>
              <Suspense fallback={<Loading />}>
                <SopMarkdownEditor
                  value={value.markdownBody}
                  disabled={busy}
                  onChange={(markdown) => setField("markdownBody", markdown)}
                  onError={setError}
                />
              </Suspense>
            </div>
            <div className="full sop-markdown-import">
              <input
                ref={importInput}
                className="visually-hidden"
                type="file"
                accept=".md,.markdown,text/markdown,text/plain"
                aria-label="Import Markdown file"
                onChange={async (event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  if (dirty && !window.confirm("Replace the current unsaved Markdown with this file?")) return;
                  setError("");
                  try {
                    const markdown = await readSopMarkdownFile(file);
                    setField("markdownBody", markdown);
                    setNotice(`Imported ${file.name}. Review the sanitized preview before saving.`);
                  } catch (caught) {
                    setError((caught as Error).message);
                  }
                }}
              />
              <button
                type="button"
                className="button-ghost"
                disabled={busy}
                onClick={() => importInput.current?.click()}
              >
                Import .md file
              </button>
              <small>Valid UTF-8 Markdown only, up to 100 KB. Import replaces this unsaved editor value; it never saves or publishes automatically.</small>
            </div>
          </div>
        </Card>
        <Card title="Sanitized live preview" className="sop-live-preview">
          <p className="muted sop-preview-note">
            This preview uses the compatible SOP sanitizer. The server sanitizes again before stored content is served.
          </p>
          <div className="sop-markdown" dangerouslySetInnerHTML={{ __html: preview.html }} />
        </Card>
      </div>
      <Card className="sop-editor-actions sop-no-print" title="Lifecycle actions">
        <div className="actions">
          <button
            className="button-orange"
            disabled={busy || invalid || (Boolean(sop) && !dirty)}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                if (!sop) {
                  const response = await api<SopDetailResponse | SopDocument>("/api/admin/sops", {
                    method: "POST",
                    body: JSON.stringify(value),
                  });
                  adopt(response);
                  setNotice("Draft created. Review the sanitized preview before publishing.");
                } else {
                  const response = await api<SopDetailResponse | SopDocument>(
                    `/api/admin/sops/${encodeURIComponent(sop.id)}/draft`,
                    {
                      method: "PUT",
                      headers: versionHeaders(sop.version),
                      body: JSON.stringify({
                        expectedVersion: sop.version,
                        title: value.title,
                        purpose: value.purpose,
                        markdownBody: value.markdownBody,
                      }),
                    },
                  );
                  adopt(response);
                  setNotice("Draft saved as a new immutable revision.");
                }
              } catch (caught) {
                mutationError(caught);
              } finally {
                setBusy(false);
              }
            }}
          >
            {sop ? "Save new draft revision" : "Create draft"}
          </button>
          {sop && (
            <>
              <button
                className="button-orange"
                disabled={busy || dirty || !sop.draftRevision}
                onClick={() => {
                  if (window.confirm("Publish this exact draft revision to staff and pilots?"))
                    void runVersioned(`/api/admin/sops/${encodeURIComponent(sop.id)}/publish`, {}, "Draft published deliberately.");
                }}
              >
                Publish draft
              </button>
              <button
                className="button-danger"
                disabled={busy || dirty || sop.status === "archived"}
                onClick={() => {
                  if (window.confirm("Archive this SOP? It will disappear from the published library, while historical job links remain intact."))
                    void runVersioned(`/api/admin/sops/${encodeURIComponent(sop.id)}/archive`, {}, "SOP archived. Existing job snapshots remain available to authorized assignments.");
                }}
              >
                {sop.status === "published" ? "Unpublish and archive" : "Archive"}
              </button>
            </>
          )}
        </div>
        {sop && dirty && <small>Save or refresh the draft before publishing or archiving.</small>}
      </Card>
      {sop && (
        <Card title="Immutable revision history" className="sop-history-card">
          {revisions.length ? (
            <ol className="sop-revision-history">
              {revisions.map((revision) => (
                <li key={revision.id}>
                  <div>
                    <strong>Revision {revision.revisionNumber}</strong>
                    <span>{formatDate(revision.createdAt)} · {authorName(revision.author)}</span>
                    {revision.publishedAt && <small>Published {formatDate(revision.publishedAt)}</small>}
                  </div>
                  <button
                    className="button-ghost button-small sop-no-print"
                    disabled={busy || dirty || revision.id === sop.draftRevision?.id}
                    onClick={() => {
                      if (window.confirm(`Restore revision ${revision.revisionNumber} as a new draft? The old revision will remain unchanged.`))
                        void runVersioned(
                          `/api/admin/sops/${encodeURIComponent(sop.id)}/restore`,
                          { revisionId: revision.id },
                          `Revision ${revision.revisionNumber} restored as a new draft.`,
                        );
                    }}
                  >
                    Restore as new draft
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No revision history" detail="Saved revisions will appear here." />
          )}
        </Card>
      )}
    </div>
  );
}
