export interface BulkFailure { code: string; message: string; }

const BULK_FAILURES: Record<string, BulkFailure> = {
  "share-revoked": { code: "share-revoked", message: "This delivery is no longer available." },
  "empty-selection": { code: "empty-selection", message: "No downloadable files were found." },
  "file-limit": { code: "file-limit", message: "This delivery contains more than 2,000 files. Choose a smaller selection." },
  "byte-limit": { code: "byte-limit", message: "This download is larger than 20 GB. Choose a smaller selection." },
  "source-changed": { code: "source-changed", message: "One or more files changed while the archive was being built. Please create a new download." },
  "archive-too-large": { code: "archive-too-large", message: "This selection is too large to prepare as one download." },
  "workflow-create-failed": { code: "workflow-create-failed", message: "The download could not be queued. Please try again." },
  "workflow-failed": { code: "workflow-failed", message: "The download could not be prepared. Please try again." },
};

export function friendlyBulkFailure(code: string | null | undefined): BulkFailure {
  return (code && BULK_FAILURES[code]) || BULK_FAILURES["workflow-failed"]!;
}

export function classifyWorkflowFailure(rawError: string): BulkFailure {
  if (["share-revoked", "empty-selection", "file-limit", "byte-limit"].includes(rawError)) return friendlyBulkFailure(rawError);
  if (rawError === "multipart-part-limit") return friendlyBulkFailure("archive-too-large");
  if (
    rawError === "source-changed-or-disappeared"
    || rawError === "source-short-read"
    || rawError === "ZIP source changed or disappeared"
    || rawError === "ZIP source returned a short range"
    || rawError.includes("Conditional ETag")
  ) return friendlyBulkFailure("source-changed");
  return friendlyBulkFailure("workflow-failed");
}
