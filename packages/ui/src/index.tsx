import { useCallback, useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from "react";
import { BRAND } from "@ltds/shared";
import type { ViewerSessionGrant } from "@ltds/shared";

export function Brand({ product }: { product: string }) {
  return <div className="ltds-brand"><img src={BRAND.logoUrl} alt="" /><span>{BRAND.name}<small>{product}</small></span></div>;
}

export function Card({ title, action, children, className = "" }: PropsWithChildren<{ title?: string; action?: ReactNode; className?: string }>) {
  return <section className={`ltds-card ${className}`}>{(title || action) && <header><h2>{title}</h2>{action}</header>}{children}</section>;
}

export function StatusPill({ tone = "neutral", children }: PropsWithChildren<{ tone?: "neutral" | "success" | "warning" | "danger" }>) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><strong>{title}</strong><p>{detail}</p></div>;
}

export function Loading() {
  return <div className="loading-state skeleton-loading" role="status" aria-label="Loading"><span /><span /><span /><span /></div>;
}

type ViewerMessage = {
  version?: number;
  type: string;
  modelId?: string;
  expiresAt?: string;
  error?: string;
};

/**
 * Keeps the Viewer iframe mounted while renewing its authorization in place.
 * Camera/layer/loader state therefore survives renewal. The parent accepts
 * messages only from this exact iframe and the exact configured Viewer origin.
 */
export function ViewerEmbed({
  modelId,
  title,
  session,
  renew,
  onClose,
}: {
  modelId: string;
  title: string;
  session: ViewerSessionGrant;
  renew: () => Promise<ViewerSessionGrant>;
  onClose?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const renewing = useRef<Promise<void> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0);
  const currentExpiry = useRef("");
  const acknowledgementTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "renewing" | "at-risk">("loading");
  const [message, setMessage] = useState("");
  const viewerOrigin = new URL(session.embedUrl).origin;

  const requestRenewal = useCallback((expiresAt: string) => {
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 2_000) {
      setState("at-risk");
      setMessage("This viewer session could not be renewed. Close and reopen the model to try again.");
      return Promise.resolve();
    }
    if (renewing.current) return renewing.current;
    if (acknowledgementTimer.current) return Promise.resolve();
    const run = async () => {
      setState("renewing");
      setMessage("Renewing secure viewer session…");
      try {
        const next = await renew();
        if (new URL(next.embedUrl).origin !== viewerOrigin) throw new Error("Viewer origin changed");
        frame.current?.contentWindow?.postMessage(
          { version: 1, type: "ltds-viewer:renew-session", grant: next.grant },
          viewerOrigin,
        );
        if (acknowledgementTimer.current) clearTimeout(acknowledgementTimer.current);
        acknowledgementTimer.current = setTimeout(() => {
          acknowledgementTimer.current = null;
          void requestRenewal(currentExpiry.current);
        }, 8_000);
        retryAttempt.current = 0;
      } catch {
        const retryWindow = Date.parse(expiresAt) - Date.now();
        if (!Number.isFinite(retryWindow) || retryWindow <= 2_000) {
          setState("at-risk");
          setMessage("This viewer session could not be renewed. Close and reopen the model to try again.");
          return;
        }
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(retryAttempt.current++, 4), Math.max(500, retryWindow - 1_000));
        setMessage("Viewer renewal is retrying…");
        retryTimer.current = setTimeout(() => requestRenewal(expiresAt), delay);
      } finally {
        renewing.current = null;
      }
    };
    renewing.current = run();
    return renewing.current;
  }, [renew, viewerOrigin]);

  useEffect(() => {
    const receive = (event: MessageEvent<ViewerMessage>) => {
      if (event.origin !== viewerOrigin || event.source !== frame.current?.contentWindow || event.data?.version !== 1 ||
        !event.data || event.data.modelId !== modelId) return;
      if (event.data.type === "ltds-viewer:ready" && event.data.expiresAt) {
        currentExpiry.current = event.data.expiresAt;
        setState("ready");
        setMessage("");
      } else if (event.data.type === "ltds-viewer:session-expiring" && event.data.expiresAt) {
        currentExpiry.current = event.data.expiresAt;
        void requestRenewal(event.data.expiresAt);
      } else if (event.data.type === "ltds-viewer:session-renewed") {
        if (!event.data.expiresAt) return;
        if (acknowledgementTimer.current) clearTimeout(acknowledgementTimer.current);
        acknowledgementTimer.current = null;
        currentExpiry.current = event.data.expiresAt;
        retryAttempt.current = 0;
        setState("ready");
        setMessage("");
      } else if (event.data.type === "ltds-viewer:session-renewal-failed") {
        if (acknowledgementTimer.current) clearTimeout(acknowledgementTimer.current);
        acknowledgementTimer.current = null;
        void requestRenewal(currentExpiry.current);
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (acknowledgementTimer.current) clearTimeout(acknowledgementTimer.current);
    };
  }, [modelId, requestRenewal, viewerOrigin]);

  return <section className="ltds-viewer-embed" aria-label={`3D model: ${title}`}>
    <header>
      <div><strong>{title}</strong><small>Secure 3D Viewer</small></div>
      <div>{message && <span role="status" className={state === "at-risk" ? "viewer-session-error" : "viewer-session-status"}>{message}</span>}{onClose && <button type="button" className="button-ghost button-small" onClick={onClose}>Close viewer</button>}</div>
    </header>
    <div className="ltds-viewer-stage" aria-busy={state === "loading"}>
      {state === "loading" && <span className="ltds-viewer-loading" role="status">Opening 3D model…</span>}
      <iframe
        ref={frame}
        src={session.embedUrl}
        title={`3D model: ${title}`}
        allow="fullscreen"
        allowFullScreen
        sandbox="allow-scripts allow-same-origin allow-downloads allow-pointer-lock"
        referrerPolicy="no-referrer"
      />
    </div>
  </section>;
}
