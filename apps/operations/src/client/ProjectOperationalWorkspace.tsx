import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import type { BusinessProjectDetail } from "./BusinessProjectWorkspace";
import { RecurringProjectCopyForward } from "./RecurringProjectCopyForward";
import "./ProjectOperationalWorkspace.css";

const memorySections = [
  ["plan", "Plan", "What was planned for this project."],
  ["actualOutcome", "Actual outcome", "What was actually delivered or completed."],
  ["deviationsAndReasons", "Deviations and reasons", "What changed from the plan and why."],
  ["observations", "Observations", "Useful facts noticed during the work."],
  ["problems", "Problems", "Issues encountered during the project."],
  ["successes", "Successes", "What worked especially well."],
  ["recommendations", "Recommendations", "Recommended follow-up or future approach."],
  ["nextTimeRequests", "Next-time requests", "Client or team requests to remember next time."],
] as const;
type MemoryKey = typeof memorySections[number][0];
type Memory = Record<MemoryKey, string>;
type ContactRole = "project_contact" | "site_contact";
type ContactMethod = "email" | "phone" | "text" | null;
interface ContactOption { public_id: string; display_name: string; email: string | null; phone: string | null; record_type: "business_contact" }
interface ContactAssignment {
  id: string; role: ContactRole; preferredContactMethod: ContactMethod; instructions: string; sortOrder: number;
  availability: "available" | "unavailable";
  contact: { id: string; displayName: string; email: string | null; phone: string | null } | null;
}
interface MemoryAttachment {
  id: string; name: string; contentType: string; size: number; sourceKind: "staff_upload";
  versionAdded: number; createdAt: string; downloadPath: string;
}
interface OperationalWorkspace {
  canonicalRoot: BusinessProjectDetail["canonicalRoot"];
  contextVersion: string;
  project: { id: string; sourceId: string; status: string | null; revision: string };
  contacts: { version: number; assignments: ContactAssignment[]; revisions: Array<{ version: number; createdAt: string }> };
  memory: { version: number; snapshot: Memory; attachments: MemoryAttachment[]; revisions: Array<{ version: number; changeKind: "saved" | "post_completion_amendment"; amendmentReason: string | null; createdAt: string }> };
  capabilities: { canManageContacts: boolean; canManageMemory: boolean };
  contactOptions: ContactOption[];
  contactPage: { available: boolean; reason: "permission_required" | "workspace_unavailable" | "not_applicable" | null; nextCursor: string | null; hasMore: boolean; returned: number; limit: number };
}
interface ContactDraft { assignmentId: string | null; contactId: string; role: ContactRole; preferredContactMethod: ContactMethod; instructions: string; unavailable: boolean }
interface Attempt { fingerprint: string; key: string }
type RecoveryAction = "reset" | "transfer";
interface RecoveryPreview { fingerprint: string; action: RecoveryAction; sourceId: string;
  project: { id: string; revision: string }; currentRoot: { kind: "organization" | "client"; id: string };
  changes: { contactsCleared: number; memoryTransferred: boolean; memoryReset: boolean; attachmentsExcluded: number } }
interface RecoveryResult extends RecoveryPreview { replayed: boolean; recoverySequence: number;
  contactsVersionAfter: number; memoryVersionAfter: number }
interface MutationResult { sourceId: string; projectId: string; version: number; replayed: boolean }
interface AttachmentMutationResult extends MutationResult { attachment: MemoryAttachment }
interface MemoryRevisionResult {
  canonicalRoot: BusinessProjectDetail["canonicalRoot"]; contextVersion: string;
  project: { id: string; sourceId: string; revision: string };
  revision: { version: number; changeKind: "saved" | "post_completion_amendment";
    amendmentReason: string | null; createdAt: string; snapshot: Memory };
}

const rootKey = (root: BusinessProjectDetail["canonicalRoot"]) => JSON.stringify([root.sourceId, root.rootNamespace, root.kind, root.publicId]);
const terminal = (status: string | null) => status === "completed" || status === "cancelled";
const invalidatesProtectedWorkspace = (error: unknown): error is ApiError => error instanceof ApiError && [401, 403, 404, 409].includes(error.status);
const assignedContactOptions = (workspace: OperationalWorkspace): ContactOption[] => {
  const merged = new Map(workspace.contactOptions.map(option => [option.public_id, option]));
  for (const assignment of workspace.contacts.assignments) {
    if (assignment.availability !== "available" || !assignment.contact || merged.has(assignment.contact.id)) continue;
    // Available assignments were joined by the server against an active contact
    // under this exact canonical root. Preserve that selected option even when it
    // sorts beyond the bounded first picker page.
    merged.set(assignment.contact.id, { public_id: assignment.contact.id, display_name: assignment.contact.displayName,
      email: assignment.contact.email, phone: assignment.contact.phone, record_type: "business_contact" });
  }
  return [...merged.values()];
};
const validMutation = (value: unknown, sourceId: string, projectId: string, expectedVersion: number): value is MutationResult => record(value)
  && value.sourceId === sourceId && value.projectId === projectId && value.version === expectedVersion + 1 && typeof value.replayed === "boolean";
const supportedAttachmentContentTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "application/pdf"]);
const attachmentAccept = [...supportedAttachmentContentTypes].join(",");
const safeAttachmentDownloadPath = (value: string) => {
  if (!value.startsWith("/api/") || value.startsWith("//") || /[\\\0-\x1f\x7f]/.test(value)) return false;
  try {
    const parsed = new URL(value, "https://operations.invalid");
    return parsed.origin === "https://operations.invalid" && parsed.pathname === value && !parsed.search && !parsed.hash;
  } catch { return false; }
};
const validAttachment = (value: unknown): value is MemoryAttachment => record(value)
  && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && value.name.length > 0
  && typeof value.contentType === "string" && supportedAttachmentContentTypes.has(value.contentType)
  && Number.isSafeInteger(value.size) && Number(value.size) >= 0
  && value.sourceKind === "staff_upload"
  && Number.isSafeInteger(value.versionAdded) && Number(value.versionAdded) > 0
  && typeof value.createdAt === "string" && typeof value.downloadPath === "string" && safeAttachmentDownloadPath(value.downloadPath);
const browserAttachment = (value: MemoryAttachment): MemoryAttachment => ({ id: value.id, name: value.name, contentType: value.contentType,
  size: value.size, sourceKind: value.sourceKind, versionAdded: value.versionAdded, createdAt: value.createdAt, downloadPath: value.downloadPath });
const validAttachmentMutation = (value: unknown, sourceId: string, projectId: string, expectedVersion: number): value is AttachmentMutationResult => {
  if (!validMutation(value, sourceId, projectId, expectedVersion) || !record(value)) return false;
  const attachment = (value as MutationResult & Record<string, unknown>).attachment;
  return validAttachment(attachment) && attachment.versionAdded === value.version;
};
const displayDate = (value: string) => {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";
};
const attachmentSize = (value: number) => {
  if (value < 1024) return `${value.toLocaleString()} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024, unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) { amount /= 1024; unit = units[index]; }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
};
const roleLabel = (role: ContactRole) => role === "project_contact" ? "Project contact" : "Site contact";
const emptyMemory = (): Memory => Object.fromEntries(memorySections.map(([key]) => [key, ""])) as Memory;
const idempotency = (attempt: MutableRefObject<Attempt | null>, payload: unknown) => {
  const fingerprint = JSON.stringify(payload);
  if (attempt.current?.fingerprint === fingerprint) return attempt.current.key;
  const key = crypto.randomUUID(); attempt.current = { fingerprint, key }; return key;
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validRecoveryPreview = (value: unknown, action: RecoveryAction, root: BusinessProjectDetail["canonicalRoot"], projectId: string): value is RecoveryPreview => record(value)
  && typeof value.fingerprint === "string" && /^[0-9a-f]{64}$/.test(value.fingerprint) && value.action === action
  && value.sourceId === root.sourceId && record(value.project) && value.project.id === projectId && typeof value.project.revision === "string"
  && record(value.currentRoot) && value.currentRoot.kind === (root.kind === "organization" ? "organization" : "client")
  && value.currentRoot.id === root.publicId
  && record(value.changes) && Number.isSafeInteger(value.changes.contactsCleared) && Number(value.changes.contactsCleared) >= 0
  && Number.isSafeInteger(value.changes.attachmentsExcluded) && Number(value.changes.attachmentsExcluded) >= 0
  && typeof value.changes.memoryTransferred === "boolean" && typeof value.changes.memoryReset === "boolean";
const validRecoveryResult = (value: unknown, action: RecoveryAction, root: BusinessProjectDetail["canonicalRoot"], projectId: string): value is RecoveryResult =>
  validRecoveryPreview(value, action, root, projectId) && record(value) && typeof value.replayed === "boolean"
  && Number.isSafeInteger(value.recoverySequence) && Number(value.recoverySequence) > 0
  && Number.isSafeInteger(value.contactsVersionAfter) && Number(value.contactsVersionAfter) >= 0
  && Number.isSafeInteger(value.memoryVersionAfter) && Number(value.memoryVersionAfter) >= 0;
function validWorkspace(value: unknown, root: BusinessProjectDetail["canonicalRoot"], projectId: string, contextVersion: string,
  previousCursor?: string): value is OperationalWorkspace {
  if (!record(value) || !record(value.canonicalRoot) || !record(value.project) || !record(value.contacts)
    || !record(value.memory) || !record(value.capabilities) || !record(value.contactPage)) return false;
  const candidate = value as unknown as OperationalWorkspace;
  const validAssignment = (item: ContactAssignment) => record(item) && typeof item.id === "string"
    && ["project_contact", "site_contact"].includes(item.role) && [null, "email", "phone", "text"].includes(item.preferredContactMethod)
    && typeof item.instructions === "string" && Number.isSafeInteger(item.sortOrder)
    && ["available", "unavailable"].includes(item.availability)
    && (item.contact === null || (record(item.contact) && typeof item.contact.id === "string" && typeof item.contact.displayName === "string"
      && (item.contact.email === null || typeof item.contact.email === "string") && (item.contact.phone === null || typeof item.contact.phone === "string")));
  const validRevision = (item: { version: number; createdAt: string }) => record(item) && Number.isSafeInteger(item.version)
    && item.version > 0 && typeof item.createdAt === "string";
  const validMemoryRevision = (item: OperationalWorkspace["memory"]["revisions"][number]) => validRevision(item)
    && ["saved", "post_completion_amendment"].includes(item.changeKind)
    && (item.amendmentReason === null || typeof item.amendmentReason === "string");
  return rootKey(candidate.canonicalRoot) === rootKey(root) && candidate.project.id === projectId
    && candidate.project.sourceId === root.sourceId && candidate.contextVersion === contextVersion
    && (candidate.project.status === null || typeof candidate.project.status === "string") && typeof candidate.project.revision === "string" && candidate.project.revision.length > 0
    && Number.isSafeInteger(candidate.contacts.version) && Array.isArray(candidate.contacts.assignments) && candidate.contacts.assignments.every(validAssignment)
    && Array.isArray(candidate.contacts.revisions) && candidate.contacts.revisions.every(validRevision)
    && Number.isSafeInteger(candidate.memory.version)
    && record(candidate.memory.snapshot) && memorySections.every(([key]) => typeof candidate.memory.snapshot[key] === "string")
    && Array.isArray(candidate.memory.attachments) && candidate.memory.attachments.every(validAttachment)
    && candidate.memory.attachments.every(item => item.versionAdded <= candidate.memory.version)
    && Array.isArray(candidate.memory.revisions) && candidate.memory.revisions.every(validMemoryRevision)
    && typeof candidate.capabilities.canManageContacts === "boolean" && typeof candidate.capabilities.canManageMemory === "boolean"
    && Array.isArray(candidate.contactOptions)
    && typeof candidate.contactPage.available === "boolean" && typeof candidate.contactPage.hasMore === "boolean"
    && [null, "permission_required", "workspace_unavailable", "not_applicable"].includes(candidate.contactPage.reason)
    && (candidate.contactPage.nextCursor === null || typeof candidate.contactPage.nextCursor === "string")
    && Number.isSafeInteger(candidate.contactPage.limit) && candidate.contactPage.limit > 0 && candidate.contactPage.limit <= 25
    && Number.isSafeInteger(candidate.contactPage.returned) && candidate.contactPage.returned >= 0
    && candidate.contactPage.returned <= candidate.contactPage.limit && candidate.contactPage.returned === candidate.contactOptions.length
    && (!candidate.contactPage.hasMore || (candidate.contactPage.available && Boolean(candidate.contactPage.nextCursor)
      && candidate.contactPage.nextCursor !== previousCursor))
    && (candidate.contactPage.available ? candidate.contactPage.reason === null
      : (candidate.contactPage.reason !== null && !candidate.contactPage.hasMore && candidate.contactPage.nextCursor === null && candidate.contactPage.returned === 0))
    && candidate.contactOptions.every(option => option.record_type === "business_contact" && typeof option.public_id === "string"
      && typeof option.display_name === "string" && (option.email === null || typeof option.email === "string")
      && (option.phone === null || typeof option.phone === "string"));
}
function validMemoryRevision(value: unknown, root: BusinessProjectDetail["canonicalRoot"], projectId: string,
  contextVersion: string, expectedVersion: number): value is MemoryRevisionResult {
  if (!record(value) || !record(value.canonicalRoot) || !record(value.project) || !record(value.revision)) return false;
  const candidate = value as unknown as MemoryRevisionResult;
  return rootKey(candidate.canonicalRoot) === rootKey(root) && candidate.contextVersion === contextVersion
    && candidate.project.id === projectId && candidate.project.sourceId === root.sourceId
    && typeof candidate.project.revision === "string" && candidate.project.revision.length > 0
    && candidate.revision.version === expectedVersion && ["saved", "post_completion_amendment"].includes(candidate.revision.changeKind)
    && (candidate.revision.amendmentReason === null || typeof candidate.revision.amendmentReason === "string")
    && typeof candidate.revision.createdAt === "string" && record(candidate.revision.snapshot)
    && memorySections.every(([key]) => typeof candidate.revision.snapshot[key] === "string"
      && candidate.revision.snapshot[key].length <= 12_000);
}

export function ProjectOperationalWorkspace({ root, projectId, contextVersion, contextSignal, onInvalidated }: {
  root: BusinessProjectDetail["canonicalRoot"]; projectId: string; contextVersion: string;
  contextSignal: AbortSignal; onInvalidated: (message: string, status?: number) => void;
}) {
  const kind = root.kind === "organization" ? "organizations" : "standalone";
  const base = `/api/client-hub/sources/${encodeURIComponent(root.sourceId)}/business/${kind}/${encodeURIComponent(root.publicId)}/business-projects/${encodeURIComponent(projectId)}`;
  const [state, setState] = useState<{ data: OperationalWorkspace | null; busy: boolean; error: string }>({ data: null, busy: true, error: "" });
  const [recoveryRequired, setRecoveryRequired] = useState(false), [canRecover, setCanRecover] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<RecoveryAction>("reset");
  const [recoveryReason, setRecoveryReason] = useState(""), [recoveryConfirmation, setRecoveryConfirmation] = useState("");
  const [recoveryPreview, setRecoveryPreview] = useState<RecoveryPreview | null>(null), [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState(""), recoveryAttempt = useRef<Attempt | null>(null);
  const [revision, setRevision] = useState(0), [contactsEditing, setContactsEditing] = useState(false), [memoryEditing, setMemoryEditing] = useState(false);
  const [contactsDraft, setContactsDraft] = useState<ContactDraft[]>([]), [memoryDraft, setMemoryDraft] = useState<Memory>(emptyMemory);
  const [amendmentReason, setAmendmentReason] = useState(""), [contactsError, setContactsError] = useState(""), [memoryError, setMemoryError] = useState("");
  const [contactsStatus, setContactsStatus] = useState(""), [memoryStatus, setMemoryStatus] = useState(""), [saving, setSaving] = useState<"contacts" | "memory" | null>(null);
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null), [attachmentReason, setAttachmentReason] = useState("");
  const [attachmentError, setAttachmentError] = useState(""), [attachmentStatus, setAttachmentStatus] = useState(""), [attachmentBusy, setAttachmentBusy] = useState(false);
  const [options, setOptions] = useState<ContactOption[]>([]), [optionsPage, setOptionsPage] = useState<OperationalWorkspace["contactPage"] | null>(null), [optionsBusy, setOptionsBusy] = useState(false);
  const pending = useRef<AbortController | null>(null), sequence = useRef(0), active = useRef(true);
  const contactsAttempt = useRef<Attempt | null>(null), memoryAttempt = useRef<Attempt | null>(null);
  const attachmentAttempt = useRef<Attempt | null>(null), attachmentInput = useRef<HTMLInputElement | null>(null), attachmentPending = useRef<AbortController | null>(null);
  const preserveMemoryDraft = useRef(false);
  const [memoryRevisionDetails, setMemoryRevisionDetails] = useState<Record<number, MemoryRevisionResult | undefined>>({});
  const [memoryRevisionBusy, setMemoryRevisionBusy] = useState<Record<number, boolean>>({});
  const [memoryRevisionErrors, setMemoryRevisionErrors] = useState<Record<number, string>>({});
  const memoryRevisionPending = useRef(new Map<number, AbortController>());

  useEffect(() => {
    active.current = true;
    for (const revisionController of memoryRevisionPending.current.values()) revisionController.abort();
    memoryRevisionPending.current.clear();
    setMemoryRevisionDetails({}); setMemoryRevisionBusy({}); setMemoryRevisionErrors({});
    const controller = new AbortController(), request = ++sequence.current;
    pending.current?.abort(); pending.current = controller;
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort);
    setState(previous => ({ data: previous.data, busy: true, error: "" }));
    const query = new URLSearchParams({ expectedContextVersion: contextVersion });
    void api<OperationalWorkspace>(`${base}/operational-workspace?${query}`, { signal: controller.signal }).then(result => {
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      if (!validWorkspace(result, root, projectId, contextVersion)) throw new ApiError("Project ownership or operational context changed. Refresh the project workspace.", 409, {});
      const safeResult = { ...result, memory: { ...result.memory, attachments: result.memory.attachments.map(browserAttachment) } };
      setRecoveryRequired(false); setCanRecover(false); setRecoveryPreview(null); setRecoveryError(""); recoveryAttempt.current = null;
      setState({ data: safeResult, busy: false, error: "" }); setOptions(assignedContactOptions(safeResult)); setOptionsPage(safeResult.contactPage);
      setContactsDraft(result.contacts.assignments.map(item => ({ assignmentId: item.id, contactId: item.contact?.id ?? "", role: item.role,
        preferredContactMethod: item.preferredContactMethod, instructions: item.instructions, unavailable: item.availability !== "available" })));
      if (!preserveMemoryDraft.current) { setMemoryDraft({ ...result.memory.snapshot }); setAmendmentReason(""); }
      preserveMemoryDraft.current = false;
    }).catch(error => {
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      const message = error instanceof Error ? error.message : "Operational project details could not be loaded.";
      if (error instanceof ApiError && error.status === 409 && error.payload.code === "project_operational_recovery_required") {
        setRecoveryRequired(true); setCanRecover(error.payload.canRecover === true); setState({ data: null, busy: false, error: "" });
      } else if (invalidatesProtectedWorkspace(error)) onInvalidated(message, error.status);
      else setState(previous => ({ data: previous.data, busy: false, error: message }));
    });
    return () => { active.current = false; controller.abort(); attachmentPending.current?.abort();
      for (const revisionController of memoryRevisionPending.current.values()) revisionController.abort();
      memoryRevisionPending.current.clear(); contextSignal.removeEventListener("abort", abort); };
  }, [base, contextVersion, revision]);

  const loadMemoryRevision = async (version: number) => {
    if (contextSignal.aborted || memoryRevisionBusy[version] || memoryRevisionDetails[version]) return;
    const controller = new AbortController(); memoryRevisionPending.current.get(version)?.abort();
    memoryRevisionPending.current.set(version, controller);
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort, { once: true });
    setMemoryRevisionBusy(current => ({ ...current, [version]: true }));
    setMemoryRevisionErrors(current => ({ ...current, [version]: "" }));
    try {
      const query = new URLSearchParams({ expectedContextVersion: contextVersion });
      const result = await api<unknown>(`${base}/operational-memory/revisions/${version}?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!validMemoryRevision(result, root, projectId, contextVersion, version)) {
        throw new ApiError("Project ownership or operational context changed. Refresh the project workspace.", 409, {});
      }
      setMemoryRevisionDetails(current => ({ ...current, [version]: result }));
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "This project-memory revision could not be loaded.";
      if (invalidatesProtectedWorkspace(error)) onInvalidated(message, error.status);
      else setMemoryRevisionErrors(current => ({ ...current, [version]: message }));
    } finally {
      contextSignal.removeEventListener("abort", abort);
      if (memoryRevisionPending.current.get(version) === controller) memoryRevisionPending.current.delete(version);
      if (!controller.signal.aborted) setMemoryRevisionBusy(current => ({ ...current, [version]: false }));
    }
  };

  const loadMoreContacts = async () => {
    if (optionsBusy || !optionsPage?.hasMore || !optionsPage.nextCursor || contextSignal.aborted) return;
    const controller = new AbortController(), request = ++sequence.current;
    pending.current?.abort(); pending.current = controller; setOptionsBusy(true); setContactsError("");
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort, { once: true });
    try {
      const query = new URLSearchParams({ expectedContextVersion: contextVersion, contactCursor: optionsPage.nextCursor });
      const result = await api<OperationalWorkspace>(`${base}/operational-workspace?${query}`, { signal: controller.signal });
      if (!active.current || controller.signal.aborted || request !== sequence.current) return;
      if (!validWorkspace(result, root, projectId, contextVersion, optionsPage.nextCursor)) throw new ApiError("Project ownership or operational context changed. Refresh the project workspace.", 409, {});
      setOptions(current => {
        const merged = new Map(current.map(option => [option.public_id, option]));
        for (const option of assignedContactOptions(result)) merged.set(option.public_id, option);
        return [...merged.values()];
      });
      setOptionsPage(result.contactPage);
    } catch (error) {
      if (controller.signal.aborted || request !== sequence.current) return;
      const message = error instanceof Error ? error.message : "More contacts could not be loaded.";
      if (invalidatesProtectedWorkspace(error)) onInvalidated(message, error.status); else setContactsError(message);
    } finally {
      contextSignal.removeEventListener("abort", abort);
      if (active.current && request === sequence.current) setOptionsBusy(false);
    }
  };

  const beginContacts = () => {
    const data = state.data; if (!data) return;
    setContactsDraft(data.contacts.assignments.map(item => ({ assignmentId: item.id, contactId: item.contact?.id ?? "", role: item.role,
      preferredContactMethod: item.preferredContactMethod, instructions: item.instructions, unavailable: item.availability !== "available" })));
    setContactsError(""); setContactsStatus(""); contactsAttempt.current = null; setContactsEditing(true);
  };
  const cancelContacts = () => { setContactsEditing(false); setContactsError(""); setContactsStatus("Changes cancelled."); contactsAttempt.current = null; };
  const beginMemory = () => { if (!state.data) return; setMemoryDraft({ ...state.data.memory.snapshot }); setAmendmentReason(""); setMemoryError(""); setMemoryStatus(""); memoryAttempt.current = null; setMemoryEditing(true); };
  const cancelMemory = () => { setMemoryEditing(false); setMemoryError(""); setMemoryStatus("Changes cancelled."); memoryAttempt.current = null; };

  const saveContacts = async () => {
    const data = state.data; if (!data || saving || contextSignal.aborted) return;
    if (contactsDraft.some(item => item.unavailable || !item.contactId)) { setContactsError("Remove unavailable assignments and choose a contact for every row before saving."); return; }
    if (contactsDraft.some(item => !options.some(option => option.public_id === item.contactId))) { setContactsError("Every assignment must use an active contact from this client."); return; }
    const pairs = contactsDraft.map(item => `${item.contactId}\u0000${item.role}`);
    if (new Set(pairs).size !== pairs.length) { setContactsError("The same contact cannot have the same role twice."); return; }
    const payload = { expectedContextVersion: contextVersion, expectedVersion: data.contacts.version,
      assignments: contactsDraft.map(item => ({ contactId: item.contactId, role: item.role,
        preferredContactMethod: item.preferredContactMethod, instructions: item.instructions })) };
    const key = idempotency(contactsAttempt, payload); setSaving("contacts"); setContactsError(""); setContactsStatus("Saving operational contacts…");
    try {
      const result = await api<unknown>(`${base}/operational-contacts`, { method: "POST", body: JSON.stringify({ ...payload, idempotencyKey: key }) });
      if (!validMutation(result, root.sourceId, projectId, data.contacts.version)) throw new Error("The operational-contact save response could not be verified. Your edits are still available.");
      contactsAttempt.current = null; setContactsEditing(false); setContactsStatus("Operational contacts saved."); setRevision(value => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Operational contacts could not be saved.";
      if (invalidatesProtectedWorkspace(error)) onInvalidated(message, error.status); else { setContactsError(message); setContactsStatus(""); }
    } finally { if (active.current) setSaving(null); }
  };
  const saveMemory = async () => {
    const data = state.data; if (!data || saving || attachmentBusy || contextSignal.aborted) return;
    const needsReason = terminal(data.project.status);
    if (needsReason && !amendmentReason.trim()) { setMemoryError("Explain why this completed or cancelled project record is being amended."); return; }
    const payload = { expectedContextVersion: contextVersion, expectedVersion: data.memory.version, memory: memoryDraft,
      amendmentReason: needsReason ? amendmentReason.trim() : null };
    const key = idempotency(memoryAttempt, payload); setSaving("memory"); setMemoryError(""); setMemoryStatus("Saving project memory…");
    try {
      const result = await api<unknown>(`${base}/operational-memory`, { method: "POST", body: JSON.stringify({ ...payload, idempotencyKey: key }) });
      if (!validMutation(result, root.sourceId, projectId, data.memory.version)) throw new Error("The project-memory save response could not be verified. Your edits are still available.");
      memoryAttempt.current = null; setMemoryEditing(false); setMemoryStatus(needsReason ? "Project-memory amendment saved." : "Project memory saved."); setRevision(value => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Project memory could not be saved.";
      if (invalidatesProtectedWorkspace(error)) onInvalidated(message, error.status); else { setMemoryError(message); setMemoryStatus(""); }
    } finally { if (active.current) setSaving(null); }
  };
  const selectAttachment = (file: File | null) => {
    setAttachmentFile(file); setAttachmentError(""); setAttachmentStatus(""); attachmentAttempt.current = null;
  };
  const uploadAttachment = async () => {
    const data = state.data, file = attachmentFile;
    if (!data || !file || attachmentBusy || saving || contextSignal.aborted || !data.capabilities.canManageMemory) return;
    if (!file.size) { setAttachmentError("Choose a non-empty image or PDF attachment."); return; }
    if (!supportedAttachmentContentTypes.has(file.type)) {
      setAttachmentError("Choose a JPEG, PNG, WebP, GIF, TIFF, or PDF attachment."); return;
    }
    const reason = terminal(data.project.status) ? attachmentReason.trim() : "";
    if (terminal(data.project.status) && !reason) {
      setAttachmentError("Explain why an attachment is being added to this completed or cancelled project."); return;
    }
    const expectedVersion = data.memory.version;
    const key = idempotency(attachmentAttempt, { contextVersion, expectedVersion, name: file.name, type: file.type, size: file.size,
      lastModified: file.lastModified, amendmentReason: reason || null });
    const controller = new AbortController(); attachmentPending.current?.abort(); attachmentPending.current = controller;
    const abort = () => controller.abort(); contextSignal.addEventListener("abort", abort, { once: true });
    setAttachmentBusy(true); setAttachmentError(""); setAttachmentStatus(`Uploading ${file.name}…`);
    try {
      const headers: Record<string, string> = {
        "Content-Type": file.type,
        "X-Expected-Context-Version": contextVersion,
        "X-Expected-Version": String(expectedVersion),
        "X-Idempotency-Key": key,
        "X-File-Name": encodeURIComponent(file.name),
      };
      if (reason) headers["X-Amendment-Reason"] = reason;
      const result = await api<unknown>(`${base}/operational-memory/attachments/upload`, {
        method: "POST", headers, body: file, signal: controller.signal,
      });
      if (!validAttachmentMutation(result, root.sourceId, projectId, expectedVersion))
        throw new Error("The attachment response could not be verified. The selected file is still available to retry.");
      if (!active.current || controller.signal.aborted) return;
      const attachment = browserAttachment(result.attachment);
      setState(current => current.data && current.data.memory.version === expectedVersion ? { ...current, data: { ...current.data,
        memory: { ...current.data.memory, version: result.version, attachments: [attachment,
          ...current.data.memory.attachments.filter(item => item.id !== result.attachment.id)] } } } : current);
      setAttachmentFile(null); setAttachmentReason(""); attachmentAttempt.current = null;
      if (attachmentInput.current) attachmentInput.current.value = "";
      setAttachmentStatus(result.replayed ? `${file.name} was already attached. Project memory is refreshing.`
        : `${file.name} attached. Project memory is refreshing.`);
      preserveMemoryDraft.current = true; setRevision(value => value + 1);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "The attachment could not be uploaded.";
      if (invalidatesProtectedWorkspace(error)) onInvalidated(message, error.status);
      else { setAttachmentError(message); setAttachmentStatus(""); }
    } finally {
      contextSignal.removeEventListener("abort", abort);
      if (attachmentPending.current === controller) attachmentPending.current = null;
      if (active.current) setAttachmentBusy(false);
    }
  };

  const data = state.data;
  const expectedRecoveryConfirmation = recoveryAction === "reset" ? "RESET PROJECT MEMORY" : "TRANSFER PROJECT MEMORY";
  const prepareRecovery = async () => {
    const reason = recoveryReason.trim();
    if (reason.length < 3) { setRecoveryError("Enter a reason of at least 3 characters for the audit receipt."); return; }
    setRecoveryBusy(true); setRecoveryError(""); setRecoveryPreview(null); recoveryAttempt.current = null;
    try {
      const result = await api<unknown>(`${base}/operational-recovery/preview`, { method: "POST",
        body: JSON.stringify({ expectedContextVersion: contextVersion, action: recoveryAction, reason }) });
      if (!validRecoveryPreview(result, recoveryAction, root, projectId)) throw new Error("The recovery preview could not be verified.");
      setRecoveryPreview(result); setRecoveryConfirmation("");
    } catch (error) { setRecoveryError(error instanceof Error ? error.message : "Recovery could not be previewed."); }
    finally { setRecoveryBusy(false); }
  };
  const commitRecovery = async () => {
    if (!recoveryPreview || recoveryConfirmation !== expectedRecoveryConfirmation) {
      setRecoveryError(`Type ${expectedRecoveryConfirmation} exactly to continue.`); return;
    }
    const payload = { expectedContextVersion: contextVersion, action: recoveryAction, reason: recoveryReason.trim(),
      previewFingerprint: recoveryPreview.fingerprint, confirmation: recoveryConfirmation };
    const key = idempotency(recoveryAttempt, payload); setRecoveryBusy(true); setRecoveryError("");
    try {
      const result = await api<unknown>(`${base}/operational-recovery/commit`, { method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey: key }) });
      if (!validRecoveryResult(result, recoveryAction, root, projectId) || result.fingerprint !== recoveryPreview.fingerprint)
        throw new Error("The recovery result could not be verified. Retry with the same confirmation.");
      recoveryAttempt.current = null; setRecoveryRequired(false); setRecoveryPreview(null); setRevision(value => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Recovery could not be completed.";
      if (error instanceof ApiError && error.status === 409) { setRecoveryPreview(null); recoveryAttempt.current = null; }
      setRecoveryError(message);
    } finally { setRecoveryBusy(false); }
  };
  if (!data && state.busy) return <Card title="Operational project details"><p role="status">Loading operational contacts and project memory…</p></Card>;
  if (!data && recoveryRequired && !canRecover) return <section className="project-operational-workspace" aria-label="Operational project details"><Card title="Operational details awaiting review"><div className="project-operational-recovery">
    <p role="alert">This project moved to a different client. Stored operational details remain protected.</p>
    <p>Contact an Operations administrator to review the reassignment. No contacts, memory, or historical attachments are visible until recovery is completed.</p>
  </div></Card></section>;
  if (!data && recoveryRequired) return <section className="project-operational-workspace" aria-label="Operational project details"><Card title="Recover reassigned project details"><div className="project-operational-recovery">
    <p role="alert">This project moved to a different client. An administrator must deliberately reset or transfer its operational memory.</p>
    <p>Both choices clear old project/site contacts. Historical attachments stay preserved under the previous owner and are not copied. This action never changes access, billing, notifications, identities, grants, or Project Alpha data.</p>
    <fieldset disabled={recoveryBusy}><legend>Recovery action</legend>
      <label><input type="radio" name="project-recovery-action" checked={recoveryAction === "reset"} onChange={() => { setRecoveryAction("reset"); setRecoveryPreview(null); recoveryAttempt.current = null; }} /> Reset memory for the new client</label>
      <label><input type="radio" name="project-recovery-action" checked={recoveryAction === "transfer"} onChange={() => { setRecoveryAction("transfer"); setRecoveryPreview(null); recoveryAttempt.current = null; }} /> Transfer structured memory only</label>
    </fieldset>
    <label>Required audit reason<textarea value={recoveryReason} minLength={3} maxLength={1000} rows={3} disabled={recoveryBusy}
      onChange={event => { setRecoveryReason(event.target.value); setRecoveryPreview(null); recoveryAttempt.current = null; }} /></label>
    {!recoveryPreview ? <button type="button" className="button-orange" disabled={recoveryBusy} onClick={() => void prepareRecovery()}>{recoveryBusy ? "Preparing preview…" : "Preview recovery"}</button> : <div className="project-operational-recovery-preview">
      <h3>Review before applying</h3><ul><li>{recoveryPreview.changes.contactsCleared} operational contact assignment(s) will be cleared.</li>
        <li>{recoveryAction === "reset" ? "Structured memory will restart empty; prior snapshots stay hidden from this owner." : "Structured memory and its history will transfer to this owner."}</li>
        <li>{recoveryPreview.changes.attachmentsExcluded} historical attachment(s) remain preserved and excluded.</li></ul>
      <label>Type <strong>{expectedRecoveryConfirmation}</strong> to confirm<input value={recoveryConfirmation} autoComplete="off" disabled={recoveryBusy}
        onChange={event => setRecoveryConfirmation(event.target.value)} /></label>
      <div className="project-operational-actions"><button type="button" className="button-orange" disabled={recoveryBusy || recoveryConfirmation !== expectedRecoveryConfirmation}
        onClick={() => void commitRecovery()}>{recoveryBusy ? "Applying recovery…" : "Apply recovery"}</button>
        <button type="button" className="button-ghost" disabled={recoveryBusy} onClick={() => { setRecoveryPreview(null); recoveryAttempt.current = null; }}>Change recovery</button></div>
    </div>}
    {recoveryError && <p role="alert" className="project-operational-error">{recoveryError}</p>}
  </div></Card></section>;
  if (!data) return <Card title="Operational project details"><div role="alert"><EmptyState title="Operational details unavailable" detail={state.error || "Operational details could not be loaded."} /></div>
    <button type="button" className="button-ghost" onClick={() => setRevision(value => value + 1)}>Retry operational details</button></Card>;
  return <section className="project-operational-workspace" aria-label="Operational project details" aria-busy={state.busy || Boolean(saving)}>
    {state.error && <div className="project-operational-banner" role="alert">{state.error}<button type="button" className="button-ghost" onClick={() => setRevision(value => value + 1)}>Retry refresh</button></div>}
    <Card title="Operational contacts">
      <p>These project and site roles are operational notes only. They do not grant portal access, delivery access, billing authority, or notifications.</p>
      {!contactsEditing ? <>
        {data.contacts.assignments.length ? <div className="project-operational-contact-list">{data.contacts.assignments.map(item => <article key={item.id}>
          <div><strong>{item.contact?.displayName || "Unavailable synchronized contact"}</strong><small>{roleLabel(item.role)}</small>
            {item.contact && <small>{[item.contact.email, item.contact.phone].filter(Boolean).join(" · ") || "No contact details provided"}</small>}
            {item.preferredContactMethod && <small>Preferred: {item.preferredContactMethod}</small>}
            {item.instructions && <p>{item.instructions}</p>}</div>
          <StatusPill tone={item.availability === "available" ? "neutral" : "warning"}>{item.availability}</StatusPill>
        </article>)}</div> : <EmptyState title="No operational contacts" detail="Add explicit project or site contacts when they are needed." />}
        {data.capabilities.canManageContacts && <button type="button" className="button-orange" onClick={beginContacts}>Edit operational contacts</button>}
      </> : <form onSubmit={event => { event.preventDefault(); void saveContacts(); }}>
        {!optionsPage?.available && <p className="project-operational-banner" role="status">The synchronized contact directory is currently unavailable. Existing exact-root assignments remain visible, but new contacts cannot be selected.</p>}
        <div className="project-operational-contact-editor">{contactsDraft.map((item, index) => <fieldset key={item.assignmentId || `new-${index}`}>
          <legend>Contact assignment {index + 1}</legend>
          {item.unavailable ? <p role="alert">This synchronized contact is no longer available. Remove this assignment before saving.</p> : <label>Contact<select aria-label={`Contact for assignment ${index + 1}`} value={item.contactId}
            onChange={event => setContactsDraft(current => current.map((entry, position) => position === index ? { ...entry, contactId: event.target.value } : entry))}>
            <option value="">Choose an active contact</option>{options.map(option => <option key={option.public_id} value={option.public_id}>{option.display_name}</option>)}</select></label>}
          <label>Role<select aria-label={`Role for assignment ${index + 1}`} value={item.role}
            onChange={event => setContactsDraft(current => current.map((entry, position) => position === index ? { ...entry, role: event.target.value as ContactRole } : entry))}>
            <option value="project_contact">Project contact</option><option value="site_contact">Site contact</option></select></label>
          <label>Preferred contact method<select aria-label={`Preferred contact method for assignment ${index + 1}`} value={item.preferredContactMethod || ""}
            onChange={event => setContactsDraft(current => current.map((entry, position) => position === index ? { ...entry, preferredContactMethod: (event.target.value || null) as ContactMethod } : entry))}>
            <option value="">Not specified</option><option value="email">Email</option><option value="phone">Phone</option><option value="text">Text</option></select></label>
          <label>Instructions<textarea aria-label={`Instructions for assignment ${index + 1}`} maxLength={4000} rows={3} value={item.instructions}
            onChange={event => setContactsDraft(current => current.map((entry, position) => position === index ? { ...entry, instructions: event.target.value } : entry))} /></label>
          <button type="button" className="button-ghost" onClick={() => setContactsDraft(current => current.filter((_entry, position) => position !== index))}>Remove assignment {index + 1}</button>
        </fieldset>)}</div>
        <div className="project-operational-actions"><button type="button" className="button-ghost" disabled={!optionsPage?.available} onClick={() => setContactsDraft(current => [...current,
          { assignmentId: null, contactId: "", role: "project_contact", preferredContactMethod: null, instructions: "", unavailable: false }])}>Add contact assignment</button>
          {optionsPage?.hasMore && <button type="button" className="button-ghost" aria-disabled={optionsBusy} onClick={() => void loadMoreContacts()}>{optionsBusy ? "Loading contacts…" : "Load more available contacts"}</button>}
          <button type="submit" className="button-orange" disabled={saving === "contacts"}>{saving === "contacts" ? "Saving contacts…" : "Save contacts"}</button>
          <button type="button" className="button-ghost" disabled={saving === "contacts"} onClick={cancelContacts}>Cancel contact changes</button></div>
      </form>}
      {contactsError && <p role="alert" className="project-operational-error">{contactsError}</p>}<p role="status">{contactsStatus}</p>
      {data.contacts.revisions.length > 0 && <details><summary>Contact change history</summary><ol className="project-operational-revisions">
        {data.contacts.revisions.map(item => <li key={item.version}>Version {item.version} · {displayDate(item.createdAt)}</li>)}</ol></details>}
    </Card>
    <Card title="Project memory">
      <p>Structured operational memory stays in Operations. It is not a client message, access rule, billing instruction, or Project Alpha record.</p>
      {!memoryEditing ? <>
        <div className="project-memory-read">{memorySections.map(([key, label]) => <section key={key}><h3>{label}</h3><p>{data.memory.snapshot[key] || "Not recorded"}</p></section>)}</div>
        {data.capabilities.canManageMemory && <button type="button" className="button-orange" onClick={beginMemory}>Edit project memory</button>}
      </> : <form onSubmit={event => { event.preventDefault(); void saveMemory(); }}>
        <div className="project-memory-editor">{memorySections.map(([key, label, hint]) => <label key={key}>{label}<small>{hint}</small><textarea
          aria-label={label} maxLength={12000} rows={5} value={memoryDraft[key]} onChange={event => setMemoryDraft(current => ({ ...current, [key]: event.target.value }))} /></label>)}</div>
        {terminal(data.project.status) && <label className="project-memory-amendment">Amendment reason<small>This project is {data.project.status}. Explain the audited post-completion change.</small>
          <textarea aria-label="Amendment reason" aria-required="true" maxLength={1000} rows={3} value={amendmentReason} onChange={event => setAmendmentReason(event.target.value)} /></label>}
        <div className="project-operational-actions"><button type="submit" className="button-orange" disabled={saving === "memory" || attachmentBusy}>{saving === "memory" ? "Saving memory…" : "Save project memory"}</button>
          <button type="button" className="button-ghost" disabled={saving === "memory"} onClick={cancelMemory}>Cancel memory changes</button></div>
      </form>}
      <section className="project-memory-attachments" aria-labelledby="project-memory-attachments-heading" aria-busy={attachmentBusy}>
        <div className="project-memory-attachments-heading"><div><h3 id="project-memory-attachments-heading">Attachments</h3>
          <p>Private project-memory images and PDFs. These files do not grant client or portal access.</p></div></div>
        {data.memory.attachments.length ? <div className="project-memory-attachment-list">{data.memory.attachments.map(item => <article key={item.id}>
          <div><strong>{item.name}</strong><small>{item.contentType} · {attachmentSize(item.size)} · added {displayDate(item.createdAt)} · memory v{item.versionAdded}</small></div>
          <a className="button button-ghost button-small" href={item.downloadPath}>Download</a>
        </article>)}</div> : <p className="muted">No project-memory attachments.</p>}
        {data.capabilities.canManageMemory && <div className="project-memory-attachment-upload">
          <label>Choose an image or PDF<input ref={attachmentInput} type="file" accept={attachmentAccept}
            disabled={attachmentBusy || Boolean(saving)} onChange={event => selectAttachment(event.target.files?.[0] || null)} /></label>
          {attachmentFile && <p className="project-memory-selected-file"><strong>Selected:</strong> {attachmentFile.name} · {attachmentSize(attachmentFile.size)}</p>}
          {terminal(data.project.status) && <label className="project-memory-amendment">Attachment amendment reason<small>This project is {data.project.status}. Explain why this audited attachment is being added.</small>
            <textarea aria-label="Attachment amendment reason" aria-required="true" maxLength={1000} rows={3} value={attachmentReason}
              disabled={attachmentBusy} onChange={event => { setAttachmentReason(event.target.value); setAttachmentError(""); }} /></label>}
          <div className="project-operational-actions"><button type="button" className="button-orange" disabled={!attachmentFile || attachmentBusy || Boolean(saving)} onClick={() => void uploadAttachment()}>
            {attachmentBusy ? "Uploading attachment…" : attachmentError && attachmentFile ? "Retry attachment upload" : "Upload attachment"}</button></div>
        </div>}
        {attachmentError && <p role="alert" className="project-operational-error">{attachmentError}</p>}<p role="status">{attachmentStatus}</p>
      </section>
      {memoryError && <p role="alert" className="project-operational-error">{memoryError}</p>}<p role="status">{memoryStatus}</p>
      {data.memory.revisions.length > 0 && <details><summary>Project-memory history</summary><ol className="project-operational-revisions">{data.memory.revisions.map(item => <li key={item.version}>
        <details className="project-memory-revision" onToggle={event => {
          if (event.currentTarget.open) void loadMemoryRevision(item.version);
        }}><summary><span>Version {item.version} · {item.changeKind === "post_completion_amendment" ? "Post-completion amendment" : "Saved"} · {displayDate(item.createdAt)}
          {item.amendmentReason && <span> — {item.amendmentReason}</span>}</span></summary>
          {memoryRevisionBusy[item.version] && <p role="status">Loading version {item.version}…</p>}
          {memoryRevisionErrors[item.version] && <div className="project-operational-banner" role="alert"><span>{memoryRevisionErrors[item.version]}</span>
            <button type="button" className="button-ghost" onClick={() => void loadMemoryRevision(item.version)}>Retry version {item.version}</button></div>}
          {memoryRevisionDetails[item.version] && <div className="project-memory-read project-memory-revision-snapshot" role="region" aria-label={`Project memory version ${item.version}`}>
            {memorySections.map(([key, label]) => <section key={key}><h3>{label}</h3><p>{memoryRevisionDetails[item.version]?.revision.snapshot[key] || "Not recorded"}</p></section>)}
          </div>}
        </details></li>)}</ol></details>}
    </Card>
    <RecurringProjectCopyForward root={root} projectId={projectId} projectStatus={data.project.status} contextVersion={contextVersion}
      contextSignal={contextSignal} capabilities={data.capabilities} onInvalidated={onInvalidated} onApplied={() => setRevision(value => value + 1)} />
  </section>;
}
