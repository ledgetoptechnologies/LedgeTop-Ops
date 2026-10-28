import { openViewerWindow, type ViewerWindowStatus } from "@ltds/ui";
import type { ViewerShellSessionGrant } from "@ltds/shared";

export type ModelViewerSession = ViewerShellSessionGrant;

/**
 * Keep one idempotency key across ambiguous failures and bind every successful
 * response to the first authorized model identity. A definitive HTTP rejection
 * can be retried with a fresh key; malformed/ambiguous responses cannot.
 */
export function createViewerSessionIssuer<T extends ModelViewerSession>(
  issue: (idempotencyKey: string) => Promise<T>,
  expectedModelId?: string,
): () => Promise<T> {
  let modelId = expectedModelId || null;
  let pendingKey: string | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    if (inflight) return inflight;
    const key = pendingKey ?? crypto.randomUUID();
    pendingKey = key;
    const request = issue(key).then(session => {
      if (!session || typeof session.modelId !== "string" || !session.modelId ||
        (modelId !== null && session.modelId !== modelId)) {
        const error = new Error("Viewer session did not match the requested model") as Error & { status: number; responseInvalid: boolean };
        error.status = 409;
        error.responseInvalid = true;
        throw error;
      }
      modelId ??= session.modelId;
      pendingKey = null;
      return session;
    }).catch(caught => {
      const failure = caught as { status?: number; responseInvalid?: boolean };
      if ((failure.status ?? 0) >= 400 && (failure.status ?? 0) < 500 && failure.responseInvalid !== true)
        pendingKey = null;
      throw caught;
    }).finally(() => {
      if (inflight === request) inflight = null;
    });
    inflight = request;
    return request;
  };
}

export function openClientViewerWindow<T extends ModelViewerSession>({
  title,
  issueSession,
  expectedModelId,
  onStatus,
  onClosed,
}: {
  title: string;
  issueSession: (idempotencyKey: string) => Promise<T>;
  expectedModelId?: string;
  onStatus?: (status: ViewerWindowStatus, message: string) => void;
  onClosed?: () => void;
}) {
  const issue = createViewerSessionIssuer(issueSession, expectedModelId);
  return openClientViewerWindowWithIssuer({ title, issueSession: issue, onStatus, onClosed });
}

/** Launch with an issuer retained by a React route so a user retry reuses ambiguous keys. */
export function openClientViewerWindowWithIssuer<T extends ModelViewerSession>({
  title,
  issueSession,
  onStatus,
  onClosed,
}: {
  title: string;
  issueSession: () => Promise<T>;
  onStatus?: (status: ViewerWindowStatus, message: string) => void;
  onClosed?: () => void;
}) {
  return openViewerWindow({ modelId: session => session.modelId, title, issueSession, onStatus, onClosed });
}
