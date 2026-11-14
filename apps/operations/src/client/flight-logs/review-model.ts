// Pure logic for the administrator review of uploaded flight logs, kept apart from React so it can be tested:
// what the banner may truthfully say, how list pages merge, which answers belong to the current request, and the
// stable per-action names used for Idempotency-Keys.
import { ApiError } from "../api";

export interface ReviewStatus {
  decoder: string;
  raw: { retained: number; waiting: number; waitingReason: string | null; decoding: number; decoded: number; failed: number; failedByCode: Record<string, number>; lastUploadAt: string | null };
  review: { unassigned: number; conflict: number; linked: number; assigned: number };
  flights: { total: number; withoutOriginal: number };
}
export interface ReviewItem {
  rawSha256: string; fileName: string | null; uploadedAt: string; parseStatus: string; errorCode: string | null; attempts: number;
  uploader: { pilotId: string; pilotName: string | null; deviceName: string | null; deviceModel: string | null };
  summary: { displayName: string | null; startedAt: string | null; durationSeconds: number | null; distanceM: number | null; photoCount: number | null } | null;
  conflict: { flightId: string; pilotId: string | null; pilotName: string | null } | null;
}

export const WAITING_REASON: Record<string, string> = {
  waiting_for_key: "waiting for the DJI key to be entered on the Logs host",
  parser_unavailable: "waiting for the log reader to be installed",
  scratch_not_ram: "waiting: the Logs host’s working space isn’t set up yet",
  stopped: "waiting: decoding is stopped",
  crashed: "waiting: decoding stopped after a problem and needs attention",
  queued: "queued for decoding",
};
export const FAILED_REASON: Record<string, string> = {
  raw_missing: "original file missing", corrupt_log: "unreadable log", unsupported_version: "log version not supported",
  attempts_exhausted: "gave up after repeated errors", keychain_unavailable: "DJI couldn’t unlock it", log_too_large: "too large",
};

/** Only "not allowed" hides the panel; anything else is shown as unavailable with a retry. */
export function reviewErrorState(error: unknown): "forbidden" | "unavailable" {
  return error instanceof ApiError && error.status === 403 ? "forbidden" : "unavailable";
}

/**
 * What the banner may say. A log whose original is missing (raw_missing) is counted as received, never as "stored";
 * the counts come from the Logs ledger and say nothing more than that about the files themselves.
 */
export function bannerSummary(status: ReviewStatus) {
  const missing = status.raw.failedByCode.raw_missing ?? 0;
  const unreadable = Object.entries(status.raw.failedByCode).filter(([code]) => code !== "raw_missing")
    .map(([code, count]) => ({ code, count, label: FAILED_REASON[code] ?? "couldn’t be read" }));
  return {
    received: status.raw.retained,
    stored: Math.max(0, status.raw.retained - missing),
    missingOriginals: missing,
    waiting: status.raw.waiting,
    waitingText: status.raw.waiting > 0 ? WAITING_REASON[status.raw.waitingReason ?? ""] ?? "waiting" : "",
    decoding: status.raw.decoding,
    unreadable,
    unreadableTotal: unreadable.reduce((n, u) => n + u.count, 0),
    toAssign: status.review.unassigned,
    toCheck: status.review.conflict,
    flightsWithoutOriginal: status.flights.withoutOriginal,
    lastUploadAt: status.raw.lastUploadAt,
  };
}

/** What one failed item may say about its original. */
export function failedItemText(item: Pick<ReviewItem, "errorCode">): string {
  if (item.errorCode === "raw_missing") return "Original file missing on the Logs host";
  return `${FAILED_REASON[item.errorCode ?? ""] ?? "Couldn’t be read"} · the original is kept`;
}

/** A page replaces the list, or (Show more) is appended without duplicates. */
export function mergeQueue(existing: ReviewItem[], incoming: ReviewItem[], append: boolean): ReviewItem[] {
  if (!append) return incoming;
  const seen = new Set(existing.map(item => item.rawSha256));
  return [...existing, ...incoming.filter(item => !seen.has(item.rawSha256))];
}

/** Only the latest request may apply its answer (a slow answer for an older tab is dropped). */
export function createGenerations() {
  let latest = 0;
  return { next: () => ++latest, isCurrent: (generation: number) => generation === latest };
}

/** Stable action names: retrying the same decision reuses its key; a different decision gets a new one. */
export const reviewAction = {
  assign: (rawSha256: string, pilotId: string) => `review-assign:${rawSha256}:${pilotId}`,
  keep: (rawSha256: string) => `review-keep:${rawSha256}`,
  move: (rawSha256: string, pilotId: string) => `review-move:${rawSha256}:${pilotId}`,
  reassign: (flightId: string, pilotId: string) => `flight-reassign:${flightId}:${pilotId}`,
};
