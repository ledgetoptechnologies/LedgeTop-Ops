import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Card, EmptyState } from "@ltds/ui";
import { api, ApiError } from "./api";
import type { BusinessProjectDetail } from "./BusinessProjectWorkspace";
import "./RecurringProjectCopyForward.css";

const contactRoles = [["project_contact", "Project contacts"], ["site_contact", "Site contacts"]] as const;
const memorySections = [
  ["plan", "Plan"], ["actualOutcome", "Actual outcome"], ["deviationsAndReasons", "Deviations and reasons"],
  ["observations", "Observations"], ["problems", "Problems"], ["successes", "Successes"],
  ["recommendations", "Recommendations"], ["nextTimeRequests", "Next-time requests"],
] as const;
type ContactRole = typeof contactRoles[number][0];
type MemorySection = typeof memorySections[number][0];
type ConflictPolicy = "keep_destination" | "replace_source";
interface Candidate { id: string; name: string; status: string | null; row_key: string }
interface CandidatePage { available: boolean; reason: string | null; nextCursor: string | null; hasMore: boolean; returned: number; limit: number }
interface CandidateResult { items: Candidate[]; page: CandidatePage; canonicalRoot: BusinessProjectDetail["canonicalRoot"]; contextVersion: string }
interface CopyState { canonicalRoot: BusinessProjectDetail["canonicalRoot"]; contextVersion: string;
  project: { id: string; sourceId: string; status: string | null; revision: string };
  contacts: { version: number }; memory: { version: number } }
interface CopyPreview {
  fingerprint: string;
  source: { projectId: string; projectRevision: string; contactsVersion: number; memoryVersion: number };
  destination: { projectId: string; projectRevision: string; contactsVersion: number; memoryVersion: number };
  selection: { contactRoles: ContactRole[]; memorySections: MemorySection[]; conflictPolicy: ConflictPolicy };
  changes: { contactsChanged: boolean; memoryChanged: boolean; copiedContacts: number; copiedMemorySections: MemorySection[];
    contactConflicts: number; memoryConflicts: MemorySection[] };
}
interface CopyCommit extends CopyPreview { replayed: boolean; destination: CopyPreview["destination"] & { contactsVersionAfter: number; memoryVersionAfter: number } }
interface Attempt { fingerprint: string; key: string }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const rootKey = (root: BusinessProjectDetail["canonicalRoot"]) => JSON.stringify([root.sourceId, root.rootNamespace, root.kind, root.publicId]);
const invalidatesWorkspace = (error: unknown): error is ApiError => error instanceof ApiError && [401, 403, 404, 409].includes(error.status);
const isRecoverableVersionConflict = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 409
  && error.payload.code === "recurring_project_copy_version_changed";
const safeInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
function validCandidateResult(value: unknown, root: BusinessProjectDetail["canonicalRoot"], contextVersion: string,
  previousCursor?: string): value is CandidateResult {
  if (!record(value) || !record(value.page) || !record(value.canonicalRoot) || !Array.isArray(value.items)) return false;
  const result = value as unknown as CandidateResult, page = result.page;
  return rootKey(result.canonicalRoot) === rootKey(root) && result.contextVersion === contextVersion
    && result.items.every(item => record(item) && typeof item.id === "string" && typeof item.name === "string"
      && (item.status === null || typeof item.status === "string") && typeof item.row_key === "string")
    && typeof page.available === "boolean" && (page.reason === null || typeof page.reason === "string")
    && (page.nextCursor === null || typeof page.nextCursor === "string") && typeof page.hasMore === "boolean"
    && safeInteger(page.returned) && page.returned === result.items.length && safeInteger(page.limit) && page.limit > 0 && page.limit <= 25
    && (!page.hasMore || (page.available && Boolean(page.nextCursor) && page.nextCursor !== previousCursor))
    && (page.available || (!page.hasMore && page.nextCursor === null && page.returned === 0));
}
function validCopyState(value: unknown, root: BusinessProjectDetail["canonicalRoot"], projectId: string,
  contextVersion: string): value is CopyState {
  if (!record(value) || !record(value.canonicalRoot) || !record(value.project) || !record(value.contacts) || !record(value.memory)) return false;
  const result = value as unknown as CopyState;
  return rootKey(result.canonicalRoot) === rootKey(root) && result.contextVersion === contextVersion
    && result.project.id === projectId && result.project.sourceId === root.sourceId && typeof result.project.revision === "string"
    && result.project.revision.length > 0 && (result.project.status === null || typeof result.project.status === "string")
    && safeInteger(result.contacts.version) && safeInteger(result.memory.version);
}
const validRoles = (value: unknown): value is ContactRole[] => Array.isArray(value)
  && value.every(item => contactRoles.some(([role]) => role === item)) && new Set(value).size === value.length;
const validSections = (value: unknown): value is MemorySection[] => Array.isArray(value)
  && value.every(item => memorySections.some(([section]) => section === item)) && new Set(value).size === value.length;
function validProjectVersion(value: unknown): value is CopyPreview["source"] {
  return record(value) && typeof value.projectId === "string" && typeof value.projectRevision === "string"
    && safeInteger(value.contactsVersion) && safeInteger(value.memoryVersion);
}
function validPreview(value: unknown, sourceId: string, destinationId: string, policy: ConflictPolicy): value is CopyPreview {
  if (!record(value) || typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.fingerprint)
    || !validProjectVersion(value.source) || !validProjectVersion(value.destination) || !record(value.selection) || !record(value.changes)) return false;
  const result = value as unknown as CopyPreview;
  return result.source.projectId === sourceId && result.destination.projectId === destinationId
    && validRoles(result.selection.contactRoles) && validSections(result.selection.memorySections) && result.selection.conflictPolicy === policy
    && typeof result.changes.contactsChanged === "boolean" && typeof result.changes.memoryChanged === "boolean"
    && safeInteger(result.changes.copiedContacts) && validSections(result.changes.copiedMemorySections)
    && safeInteger(result.changes.contactConflicts) && validSections(result.changes.memoryConflicts);
}
function validCommit(value: unknown, preview: CopyPreview): value is CopyCommit {
  if (!validPreview(value, preview.source.projectId, preview.destination.projectId, preview.selection.conflictPolicy)) return false;
  const result = value as CopyCommit, { contactsVersionAfter: _contactsAfter, memoryVersionAfter: _memoryAfter, ...destination } = result.destination;
  return result.fingerprint === preview.fingerprint && typeof result.replayed === "boolean"
    && safeInteger(result.destination.contactsVersionAfter) && safeInteger(result.destination.memoryVersionAfter)
    && JSON.stringify(result.source) === JSON.stringify(preview.source) && JSON.stringify(destination) === JSON.stringify(preview.destination)
    && JSON.stringify(result.selection) === JSON.stringify(preview.selection) && JSON.stringify(result.changes) === JSON.stringify(preview.changes);
}
const operationKey = (attempt: MutableRefObject<Attempt | null>, payload: unknown) => {
  const fingerprint = JSON.stringify(payload);
  if (attempt.current?.fingerprint === fingerprint) return attempt.current.key;
  const key = crypto.randomUUID(); attempt.current = { fingerprint, key }; return key;
};

export function RecurringProjectCopyForward({ root, projectId, projectStatus, contextVersion, contextSignal,
  capabilities, onInvalidated, onApplied }: {
  root: BusinessProjectDetail["canonicalRoot"]; projectId: string; projectStatus: string | null; contextVersion: string;
  contextSignal: AbortSignal; capabilities: { canManageContacts: boolean; canManageMemory: boolean };
  onInvalidated: (message: string, status?: number) => void; onApplied: () => void;
}) {
  const kind = root.kind === "organization" ? "organizations" : "standalone";
  const rootBase = `/api/client-hub/sources/${encodeURIComponent(root.sourceId)}/business/${kind}/${encodeURIComponent(root.publicId)}`;
  const destinationBase = `${rootBase}/business-projects/${encodeURIComponent(projectId)}`;
  const eligible = ["not_started", "active", "overdue"].includes(projectStatus || "");
  const [projects, setProjects] = useState<Candidate[]>([]), [page, setPage] = useState<CandidatePage | null>(null);
  const [sourceId, setSourceId] = useState(""), [selectedRoles, setSelectedRoles] = useState<ContactRole[]>([]);
  const [selectedSections, setSelectedSections] = useState<MemorySection[]>([]), [policy, setPolicy] = useState<ConflictPolicy>("keep_destination");
  const [preview, setPreview] = useState<CopyPreview | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"projects" | "preview" | "commit" | null>(null);
  const [error, setError] = useState(""), [status, setStatus] = useState("");
  const [projectsFailed, setProjectsFailed] = useState(false);
  const active = useRef(true), pending = useRef<AbortController | null>(null), sequence = useRef(0), commitAttempt = useRef<Attempt | null>(null);

  const clearPreview = () => { setPreview(null); setConfirmed(false); setError(""); setStatus(""); commitAttempt.current = null; };
  const loadProjects = async (more = false) => {
    if (!eligible || contextSignal.aborted || busy || (more && (!page?.hasMore || !page.nextCursor))) return;
    const previousCursor = more ? page!.nextCursor! : undefined, controller = new AbortController(), request = ++sequence.current;
    pending.current?.abort(); pending.current = controller; setBusy("projects"); setError(""); setProjectsFailed(false);
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort, { once: true });
    try {
      const query = new URLSearchParams({ filter: "all", limit: "25", expectedContextVersion: contextVersion });
      if (previousCursor) query.set("cursor", previousCursor);
      const result = await api<unknown>(`${rootBase}/collections/businessProjects?${query}`, { signal: controller.signal });
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      if (!validCandidateResult(result, root, contextVersion, previousCursor)) throw new ApiError("Previous projects could not be loaded safely. Refresh this workspace.", 409, {});
      if (!result.page.available) throw new ApiError("Project-view access is required to copy from a previous project.", 403, {});
      setProjects(current => {
        const values = new Map((more ? current : []).map(item => [item.id, item]));
        for (const item of result.items) if (item.id !== projectId) values.set(item.id, item);
        return [...values.values()];
      });
      setPage(result.page);
    } catch (caught) {
      if (controller.signal.aborted || request !== sequence.current) return;
      const message = caught instanceof Error ? caught.message : "Previous projects could not be loaded.";
      if (invalidatesWorkspace(caught)) onInvalidated(message, caught.status); else { setError(message); setProjectsFailed(true); }
    } finally {
      contextSignal.removeEventListener("abort", abort);
      if (active.current && request === sequence.current) setBusy(null);
    }
  };
  useEffect(() => {
    active.current = true;
    if (eligible) void loadProjects();
    const abort = () => { sequence.current += 1; pending.current?.abort(); };
    contextSignal.addEventListener("abort", abort);
    return () => { active.current = false; abort(); contextSignal.removeEventListener("abort", abort); };
  }, [rootBase, projectId, contextVersion, eligible]);

  const toggleRole = (role: ContactRole) => { clearPreview(); setSelectedRoles(current => current.includes(role) ? current.filter(item => item !== role) : [...current, role]); };
  const toggleSection = (section: MemorySection) => { clearPreview(); setSelectedSections(current => current.includes(section) ? current.filter(item => item !== section) : [...current, section]); };
  const readState = async (id: string, signal: AbortSignal) => {
    const query = new URLSearchParams({ expectedContextVersion: contextVersion });
    const result = await api<unknown>(`${rootBase}/business-projects/${encodeURIComponent(id)}/operational-workspace?${query}`, { signal });
    if (!validCopyState(result, root, id, contextVersion)) throw new ApiError("Project copy state could not be verified. Refresh this workspace.", 409, {});
    return result;
  };
  const previewCopy = async () => {
    if (busy || contextSignal.aborted) return;
    if (!sourceId) { setError("Choose a previous project first."); return; }
    if (!selectedRoles.length && !selectedSections.length) { setError("Select at least one contact role or project-memory section."); return; }
    // A refreshed preview requires fresh review, even if the request fails.
    setPreview(null); setConfirmed(false);
    const controller = new AbortController(), request = ++sequence.current;
    pending.current?.abort(); pending.current = controller; setBusy("preview"); setError(""); setStatus("Preparing a live copy preview…");
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort, { once: true });
    try {
      const [source, destination] = await Promise.all([readState(sourceId, controller.signal), readState(projectId, controller.signal)]);
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      const payload = { expectedContextVersion: contextVersion, sourceProjectId: sourceId, destinationProjectId: projectId,
        selectedContactRoles: selectedRoles, selectedMemorySections: selectedSections, conflictPolicy: policy,
        expected: { sourceProjectRevision: source.project.revision, destinationProjectRevision: destination.project.revision,
          sourceContactsVersion: source.contacts.version, destinationContactsVersion: destination.contacts.version,
          sourceMemoryVersion: source.memory.version, destinationMemoryVersion: destination.memory.version } };
      const result = await api<unknown>(`${destinationBase}/recurring-copy/preview`, { method: "POST", body: JSON.stringify(payload), signal: controller.signal });
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      if (!validPreview(result, sourceId, projectId, policy)
        || result.source.projectRevision !== source.project.revision || result.source.contactsVersion !== source.contacts.version
        || result.source.memoryVersion !== source.memory.version || result.destination.projectRevision !== destination.project.revision
        || result.destination.contactsVersion !== destination.contacts.version || result.destination.memoryVersion !== destination.memory.version
        || JSON.stringify(result.selection.contactRoles) !== JSON.stringify([...selectedRoles].sort())
        || JSON.stringify(result.selection.memorySections) !== JSON.stringify([...selectedSections].sort()))
        throw new Error("The copy preview response could not be verified. Nothing was changed.");
      setPreview(result); setConfirmed(false); setStatus("Preview ready. Review the summary before applying it."); commitAttempt.current = null;
    } catch (caught) {
      if (controller.signal.aborted || request !== sequence.current) return;
      const message = caught instanceof Error ? caught.message : "The copy preview could not be prepared.";
      if (isRecoverableVersionConflict(caught)) {
        setPreview(null); setConfirmed(false); commitAttempt.current = null;
        setError(message); setStatus("The selected source and sections are still available. Preview the copy again.");
      } else if (invalidatesWorkspace(caught)) onInvalidated(message, caught.status); else { setError(message); setStatus(""); }
    } finally {
      contextSignal.removeEventListener("abort", abort);
      if (active.current && request === sequence.current) setBusy(null);
    }
  };
  const commitCopy = async () => {
    if (!preview || !confirmed || busy || contextSignal.aborted) return;
    const payload = { expectedContextVersion: contextVersion, sourceProjectId: preview.source.projectId,
      destinationProjectId: preview.destination.projectId, selectedContactRoles: preview.selection.contactRoles,
      selectedMemorySections: preview.selection.memorySections, conflictPolicy: preview.selection.conflictPolicy,
      expected: { sourceProjectRevision: preview.source.projectRevision, destinationProjectRevision: preview.destination.projectRevision,
        sourceContactsVersion: preview.source.contactsVersion, destinationContactsVersion: preview.destination.contactsVersion,
        sourceMemoryVersion: preview.source.memoryVersion, destinationMemoryVersion: preview.destination.memoryVersion },
      previewFingerprint: preview.fingerprint };
    const idempotencyKey = operationKey(commitAttempt, payload), controller = new AbortController(), request = ++sequence.current;
    pending.current?.abort(); pending.current = controller; setBusy("commit"); setError(""); setStatus("Applying the reviewed copy…");
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort, { once: true });
    try {
      const result = await api<unknown>(`${destinationBase}/recurring-copy/commit`, { method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey }), signal: controller.signal });
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      if (!validCommit(result, preview)) throw new Error("The copy response could not be verified. Refresh before attempting another copy.");
      commitAttempt.current = null; setPreview(null); setConfirmed(false); setStatus(result.replayed
        ? "The previously completed copy was confirmed. Operational details are refreshing."
        : "Selected operational details copied. Operational details are refreshing.");
      onApplied();
    } catch (caught) {
      if (controller.signal.aborted || request !== sequence.current) return;
      const message = caught instanceof Error ? caught.message : "The reviewed copy could not be applied.";
      if (isRecoverableVersionConflict(caught)) {
        setPreview(null); setConfirmed(false); commitAttempt.current = null;
        setError(message); setStatus("The selected source and sections are still available. Preview the copy again.");
      } else if (invalidatesWorkspace(caught)) onInvalidated(message, caught.status); else { setError(message); setStatus(""); }
    } finally {
      contextSignal.removeEventListener("abort", abort);
      if (active.current && request === sequence.current) setBusy(null);
    }
  };

  if (!eligible) return <Card title="Copy from a previous project"><EmptyState title="Copy-forward unavailable"
    detail="This project is not open. Copy-forward is available only while the destination is not started, active, or overdue." /></Card>;
  if (!busy && page && !page.hasMore && !projects.length) return <Card title="Copy from a previous project"><EmptyState title="No previous project to copy"
    detail="This is the first available project for this client. Copy-forward will appear after another project exists." /></Card>;
  return <Card title="Copy from a previous project"><section className="recurring-project-copy" aria-label="Copy from a previous project" aria-busy={Boolean(busy)}>
    <p>Reuse selected operational contacts and project memory from another project for this exact client. This does not create a project or copy portal access, files, billing, invitations, or notifications.</p>
    <label>Previous project<select value={sourceId} onChange={event => { clearPreview(); setSourceId(event.target.value); }} disabled={Boolean(busy)}>
      <option value="">Choose a previous project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.status?.replaceAll("_", " ") || "status not recorded"}</option>)}</select></label>
    {busy === "projects" && !projects.length && <p role="status">Loading previous projects…</p>}
    {projectsFailed && <button type="button" className="button-ghost" disabled={Boolean(busy)} onClick={() => void loadProjects(Boolean(page?.hasMore))}>Retry loading previous projects</button>}
    {page?.hasMore && <button type="button" className="button-ghost" disabled={Boolean(busy)} onClick={() => void loadProjects(true)}>{busy === "projects" ? "Loading projects…" : "Load more previous projects"}</button>}
    <div className="recurring-project-copy-options">
      <fieldset><legend>Operational contacts</legend>{contactRoles.map(([role, label]) => <label key={role}><input type="checkbox" checked={selectedRoles.includes(role)}
        disabled={!capabilities.canManageContacts || Boolean(busy)} onChange={() => toggleRole(role)} />{label}</label>)}
        {!capabilities.canManageContacts && <small>Contact-management permission is required.</small>}</fieldset>
      <fieldset><legend>Project-memory sections</legend>{memorySections.map(([section, label]) => <label key={section}><input type="checkbox" checked={selectedSections.includes(section)}
        disabled={!capabilities.canManageMemory || Boolean(busy)} onChange={() => toggleSection(section)} />{label}</label>)}
        {!capabilities.canManageMemory && <small>Project-memory permission is required.</small>}</fieldset>
    </div>
    <fieldset className="recurring-project-conflicts"><legend>If selected source and destination values differ</legend>
      <label><input type="radio" name={`copy-policy-${projectId}`} checked={policy === "keep_destination"} disabled={Boolean(busy)}
        onChange={() => { clearPreview(); setPolicy("keep_destination"); }} />Keep the destination value (recommended)</label>
      <label><input type="radio" name={`copy-policy-${projectId}`} checked={policy === "replace_source"} disabled={Boolean(busy)}
        onChange={() => { clearPreview(); setPolicy("replace_source"); }} />Replace conflicts with non-empty source values</label>
    </fieldset>
    <button type="button" className="button-orange" disabled={Boolean(busy)} onClick={() => void previewCopy()}>{busy === "preview" ? "Preparing preview…" : "Preview copy"}</button>
    {preview && <section className="recurring-project-preview" aria-label="Copy preview"><h3>Copy preview</h3><ul>
      <li>{preview.changes.copiedContacts} contact assignment{preview.changes.copiedContacts === 1 ? "" : "s"} will be added or updated.</li>
      <li>{preview.changes.copiedMemorySections.length} project-memory section{preview.changes.copiedMemorySections.length === 1 ? "" : "s"} will be copied.</li>
      <li>{preview.changes.contactConflicts} contact conflict{preview.changes.contactConflicts === 1 ? "" : "s"} and {preview.changes.memoryConflicts.length} memory conflict{preview.changes.memoryConflicts.length === 1 ? "" : "s"} were found.</li>
    </ul>{!preview.changes.contactsChanged && !preview.changes.memoryChanged && <p>No destination values would change.</p>}
      <p>Conflict policy: <strong>{preview.selection.conflictPolicy === "keep_destination" ? "Keep destination values" : "Use non-empty source values"}</strong>.</p>
      <label className="recurring-project-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I reviewed this preview and want to apply it to the open project.</label>
      <button type="button" className="button-orange" disabled={!confirmed || Boolean(busy)} onClick={() => void commitCopy()}>{busy === "commit" ? "Applying copy…" : "Apply copy to this project"}</button>
    </section>}
    {error && <p role="alert" className="project-operational-error">{error}</p>}<p role="status">{status}</p>
  </section></Card>;
}
