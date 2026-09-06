/** Public feedback contracts. Storage keys and authorization proofs never belong here. */
export type ClientFeedbackStatus = "new" | "in_progress" | "done";

export type ClientFeedbackTargetInput =
  | { kind: "project"; projectId: string }
  | { kind: "folder"; projectId: string | null; folderId: string }
  | { kind: "file"; projectId: string | null; fileId: string };

export interface ClientFeedbackTarget {
  kind: ClientFeedbackTargetInput["kind"];
  projectId: string | null;
  label: string;
  projectName: string | null;
  available: boolean;
  /** Server-built, same-origin portal path, requiring fresh authorization. */
  actionPath: string | null;
}

export interface ClientFeedbackItem {
  id: string;
  status: ClientFeedbackStatus;
  revision: number;
  message: string;
  completionNote: string | null;
  target: ClientFeedbackTarget;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ClientFeedbackPage {
  items: ClientFeedbackItem[];
  nextCursor: string | null;
}

export interface StaffClientFeedbackItem extends ClientFeedbackItem {
  accountName: string;
  canStart: boolean;
  canComplete: boolean;
}

export interface ClientFeedbackEvent {
  revision: number;
  actor: "client" | "staff";
  status: ClientFeedbackStatus;
  note: string | null;
  createdAt: string;
}

export interface ClientFeedbackDetail {
  feedback: ClientFeedbackItem;
  events: ClientFeedbackEvent[];
}

/** Read-only project history. Messages, notes, actors, target snapshots and
 * authorization proofs are intentionally not part of this DTO. */
export interface ProjectFeedbackHistoryEvent {
  revision: number;
  action: "submitted" | "started" | "completed";
  occurredAt: string;
}

export interface ProjectFeedbackHistoryItem {
  feedbackId: string;
  createdAt: string;
  status: ClientFeedbackStatus;
  events: ProjectFeedbackHistoryEvent[];
  detailPath: string;
}

export interface ProjectFeedbackHistoryPage {
  canonicalRoot: { sourceId: string; rootNamespace: string; kind: string; publicId: string };
  projectId: string;
  contextVersion: string;
  refreshedAt: string;
  asOf: string;
  coverage: "feedback_only";
  items: ProjectFeedbackHistoryItem[];
  page: {
    available: boolean;
    reason: "unsupported_source" | null;
    nextCursor: string | null;
    hasMore: boolean;
    returned: number;
    limit: number;
  };
}

/** Read-only feedback history for one exact Client Hub root. Message bodies,
 * completion notes, actors, storage keys and authorization proofs are omitted. */
export interface ClientFeedbackHistoryItem extends ProjectFeedbackHistoryItem {
  target: {
    kind: ClientFeedbackTargetInput["kind"];
    label: string;
    projectName: string | null;
  };
}

export interface ClientFeedbackHistoryPage {
  canonicalRoot: { sourceId: string; rootNamespace: string; kind: string; publicId: string };
  contextVersion: string;
  refreshedAt: string;
  asOf: string;
  coverage: "feedback_only";
  items: ClientFeedbackHistoryItem[];
  page: ProjectFeedbackHistoryPage["page"];
}

/** Redacted lifecycle history belonging to the exact signed-in portal actor.
 * Feedback bodies and staff notes remain available only from the separately
 * authorized detail route. */
export interface PortalFeedbackHistoryPage {
  scope: {
    sourceId: string;
    workspaceId: string | null;
    rootType: string;
    rootPublicId: string;
  };
  asOf: string;
  items: ClientFeedbackHistoryItem[];
  nextCursor: string | null;
}

export interface PortalNotificationHistoryItem {
  id: string;
  kind: "request" | "feedback";
  title: string;
  body: string;
  actionPath: string | null;
  readAt: string | null;
  createdAt: string;
  mutationPath: string;
}

export interface PortalNotificationHistoryPage {
  scope: { sourceId: string; workspaceId: string | null; rootType: string; rootPublicId: string };
  asOf: string;
  coverage: { requests: "included"; feedback: "included"; delivery: "omitted_no_explicit_grant_authority" };
  items: PortalNotificationHistoryItem[];
  nextCursor: string | null;
}

export const CLIENT_FEEDBACK_MESSAGE_LIMIT = 5000;
export const CLIENT_FEEDBACK_NOTE_LIMIT = 2000;

/** Acknowledging feedback may go directly to Done; reopening is not implicit. */
export function canTransitionClientFeedback(from: ClientFeedbackStatus, to: ClientFeedbackStatus): boolean {
  return (from === "new" && (to === "in_progress" || to === "done")) ||
    (from === "in_progress" && to === "done");
}
