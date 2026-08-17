import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PropsWithChildren, type ReactNode } from "react";
import { BRAND } from "@ltds/shared";
import type { ViewerSessionGrant } from "@ltds/shared";
import { CLOUDFLARE_ACCESS_LOGOUT_PATH } from "./access";
export { CLOUDFLARE_ACCESS_LOGOUT_PATH } from "./access";

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

export function AccountMenu({
  displayName,
  avatar,
  details,
  accountHref,
  onAccount,
  className = "",
}: {
  displayName: string;
  avatar: string;
  details?: ReactNode;
  accountHref?: string;
  onAccount?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const menuId = `account-menu-${useId().replace(/:/g, "")}`;
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
  }, []);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: MouseEvent | FocusEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(true); }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [close, open]);
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])];
    if (!items.length) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
      event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[index]?.focus();
  };
  return <div ref={root} className={`account-menu ${className}`.trim()}>
    <button ref={trigger} type="button" className="account-menu-trigger" aria-label={`Account menu for ${displayName}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)}>
      <span className="account-menu-avatar" aria-hidden="true">{avatar}</span>
      <span className="account-menu-copy"><strong>{displayName}</strong>{details}</span>
    </button>
    {open && <div id={menuId} className="account-menu-popover" role="menu" aria-label="Account" onKeyDown={move}>
      {accountHref && <a role="menuitem" href={accountHref} onClick={(event) => {
        if (onAccount) { event.preventDefault(); onAccount(); }
        setOpen(false);
      }}>Account</a>}
      <a role="menuitem" href={CLOUDFLARE_ACCESS_LOGOUT_PATH}>Logout</a>
    </div>}
  </div>;
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
