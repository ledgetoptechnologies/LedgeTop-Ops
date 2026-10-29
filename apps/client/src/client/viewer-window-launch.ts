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

/**
 * What a client reads when a 3D model can't open: a fixed sentence chosen by what went wrong, never the
 * server's own wording. The underlying error stays on the rejected promise for diagnostics.
 */
export function viewerLaunchFailureMessage(caught: unknown): string {
  const failure = (caught ?? {}) as { status?: number; responseInvalid?: boolean; sharingUnchecked?: boolean };
  const status = typeof failure.status === "number" ? failure.status : 0;
  if (failure.sharingUnchecked) return "This 3D model can't be opened from here yet. Open it from your portal home.";
  if (status === 401) return "Your sign-in has ended. Sign in again, then open the model.";
  if (status === 403 || status === 404 || status === 410) return "This 3D model is no longer shared with you.";
  if (status === 409 && failure.responseInvalid) return "The 3D Viewer couldn't confirm this model. Try again.";
  if (status === 409) return "Sharing for this model changed. Refresh the page, then try again.";
  if (status === 429 || status >= 500 || status === 0) return "The 3D Viewer is busy or can't be reached right now. Try again in a minute.";
  return "The 3D Viewer couldn't be opened. Try again.";
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
