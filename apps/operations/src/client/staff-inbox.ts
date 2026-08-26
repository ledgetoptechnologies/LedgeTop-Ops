import { z } from "zod";

export type InboxSource = "requests" | "feedback" | "deliveries" | "connections";
export interface InboxAccess { permissions: readonly string[]; isAdministrator: boolean; feedbackEnabled: boolean }
export interface InboxItem { id: string; title: string; detail: string; status: string; date: string | null; href: string; action: string }
export interface InboxPage { items: InboxItem[]; nextCursor: string | null }

export function inboxSources(access: InboxAccess): InboxSource[] {
  const sources: InboxSource[] = [];
  if (access.permissions.includes("operations.manage")) sources.push("requests");
  if (access.feedbackEnabled) sources.push("feedback");
  if (access.permissions.includes("delivery.share.audit")) sources.push("deliveries");
  if (access.isAdministrator && access.permissions.includes("integrations.manage") && access.permissions.includes("administration.view")) sources.push("connections");
  return sources;
}

export const inboxLabels: Record<InboxSource, { title: string; description: string }> = {
  requests: { title: "Client requests", description: "Oldest first: submitted, under review, or waiting for Project Alpha linkage." },
  feedback: { title: "Client feedback", description: "Oldest first: new and in-progress project, folder, and file feedback." },
  deliveries: { title: "Pending delivery notices", description: "Newest batches first. Client-folder change notices only; review the countdown and available actions before sending or cancelling." },
  connections: { title: "Connection failures", description: "Reported synchronization failures for active Project Alpha connections. Other integrations are not included here." },
};

export function inboxEndpoint(source: InboxSource, q: string, cursor: string | null): string {
  if (source === "connections") return "/api/admin/integrations/project-alpha/connectors";
  const params = new URLSearchParams();
  if (source === "feedback") params.set("status", "open");
  if (source === "deliveries") params.set("view", "pending");
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  const path = source === "requests" ? "/api/operations/inbox/requests" : source === "feedback" ? "/api/operations/feedback" : "/api/notifications/deliveries";
  return `${path}${params.size ? `?${params}` : ""}`;
}

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const text = z.string().max(10000);
const date = z.string().max(64).refine(value => /^\d{4}-\d{2}-\d{2}[T ]/.test(value) && Number.isFinite(Date.parse(inboxDate(value))), "Invalid date");
const nextCursor = z.string().min(1).max(4096).nullable();
const requestPage = z.object({ items: z.array(z.object({ id, title: text, accountName: text, projectName: text.nullable(),
  status: z.enum(["submitted", "under_review", "accepted_pending_pa_linkage"]), createdAt: date })).max(25), nextCursor });
const feedbackPage = z.object({ items: z.array(z.object({ id, accountName: text, message: text,
  status: z.enum(["new", "in_progress"]), createdAt: date, target: z.object({ label: text, projectName: text.nullable() }) })).max(25), nextCursor });
const deliveryPage = z.object({ items: z.array(z.object({ id, accountName: text, folderLabel: text,
  status: z.enum(["pending", "processing"]), createdAt: date, addedCount: z.number().int().nonnegative(), removedCount: z.number().int().nonnegative() })).max(25), nextCursor,
  coverage: z.literal("legacy_folder_changes") });
const connectionPage = z.object({ connectors: z.array(z.object({ sourceId: text, displayName: text,
  state: z.enum(["pending", "active", "suspended", "retired"]) })).max(32), legacyPrimary: z.boolean(),
  health: z.array(z.object({ sourceId: text, status: z.enum(["healthy", "error", "unknown", "disabled", "stale"]), lastAttemptAt: date.nullable() })).max(33) });

export function inboxDate(value: string): string {
  const iso = value.replace(" ", "T");
  return /(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : `${iso}Z`;
}
export function parseInboxPage(source: InboxSource, value: unknown, q: string): InboxPage {
  if (source === "requests") {
    const page = requestPage.parse(value);
    return { nextCursor: page.nextCursor, items: page.items.map(row => ({ id: row.id, title: row.title,
      detail: [row.accountName, row.projectName].filter(Boolean).join(" · "), date: row.createdAt,
      status: row.status === "submitted" ? "Submitted" : row.status === "under_review" ? "Under review" : "Awaiting Alpha linkage",
      href: `/clients/requests/${encodeURIComponent(row.id)}`, action: "Review request" })) };
  }
  if (source === "feedback") {
    const page = feedbackPage.parse(value);
    return { nextCursor: page.nextCursor, items: page.items.map(row => ({ id: row.id, title: row.target.label,
      detail: `${[row.accountName, row.target.projectName].filter(Boolean).join(" · ")} — ${row.message.slice(0, 240)}${row.message.length > 240 ? "…" : ""}`,
      date: row.createdAt, status: row.status === "new" ? "New" : "In progress",
      href: `/operations/feedback/${encodeURIComponent(row.id)}?status=all`, action: "Review feedback" })) };
  }
  if (source === "deliveries") {
    const page = deliveryPage.parse(value);
    return { nextCursor: page.nextCursor, items: page.items.map(row => ({ id: row.id, title: row.folderLabel,
      detail: `${row.accountName} · ${row.addedCount.toLocaleString("en-US")} added · ${row.removedCount.toLocaleString("en-US")} removed`,
      date: row.createdAt, status: row.status === "pending" ? "Pending" : "Processing",
      href: `/operations/notifications?${new URLSearchParams({ batchId: row.id })}`, action: "Review notice" })) };
  }
  const page = connectionPage.parse(value), names = new Map(page.connectors.filter(row => row.state === "active").map(row => [row.sourceId, row.displayName]));
  if (page.legacyPrimary) names.set("project-alpha:primary", "Project Alpha · Primary");
  const needle = q.normalize("NFC").toLocaleLowerCase("en-US");
  return { nextCursor: null, items: page.health.filter(row => row.status === "error" && names.has(row.sourceId))
    .filter(row => !needle || `${names.get(row.sourceId)}\n${row.sourceId}`.normalize("NFC").toLocaleLowerCase("en-US").includes(needle))
    .map(row => ({ id: row.sourceId, title: names.get(row.sourceId)!, detail: "The last synchronization failed. Open connection administration to review its status.",
      date: row.lastAttemptAt, status: "Sync failed", href: "/administration#project-alpha-connections", action: "Review connection" })) };
}
