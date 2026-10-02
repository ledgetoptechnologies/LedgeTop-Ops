// Retained operation IDs may be replayed only while the visible selection still
// describes the same request. Switching projects must never replay hidden work.
export function assertSameFolderRetry(pending: Record<string, unknown> | null,
  folder: Record<string, unknown>, publicationRevision: number, reason: string): void {
  if (!pending) return;
  const stored = pending.folder, publication = pending.publication;
  if (!stored || typeof stored !== "object" || !publication || typeof publication !== "object") {
    throw new Error("Retained request is invalid. Use publication recovery.");
  }
  const prior = stored as Record<string, unknown>, pub = publication as Record<string, unknown>;
  const keys = Object.keys(folder).filter(key => key !== "operationId");
  if (keys.some(key => prior[key] !== folder[key])
    || Object.keys(prior).some(key => key !== "operationId" && !keys.includes(key))
    || pub.expectedRevision !== publicationRevision || pub.reason !== reason) {
    throw new Error("The selection changed since the retained request. Restore the original selection or recover its publication before starting another request.");
  }
}

export function assertSameWorkspaceRetry(pending: Record<string, unknown> | null,
  workspace: Record<string, unknown>): void {
  if (!pending) return;
  const stored = pending.workspace;
  if (!stored || typeof stored !== "object") throw new Error("Retained request is invalid. Use publication recovery.");
  const prior = stored as Record<string, unknown>;
  const keys = Object.keys(workspace).filter(key => key !== "operationId");
  if (keys.some(key => prior[key] !== workspace[key])
    || Object.keys(prior).some(key => key !== "operationId" && !keys.includes(key))) {
    throw new Error("The workspace selection changed since the retained request. Restore the original selection or recover its publication before starting another request.");
  }
}
