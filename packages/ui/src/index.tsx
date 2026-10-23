import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PropsWithChildren, type ReactNode } from "react";
import type { ViewerSessionGrant, ViewerShellSessionGrant } from "@ltds/shared";
import { CLOUDFLARE_ACCESS_LOGOUT_PATH } from "./access";
export { CLOUDFLARE_ACCESS_LOGOUT_PATH } from "./access";
export { AppDialogHost, requestChoice, requestText, type ChoiceRequest, type TextRequest } from "./app-dialogs";

/** Generic Ledge Top mark, identical on every domain and product. */
const LT_MARK_BOX = "238.5 226 776 776", LT_MARK_WHITE = "#f5f3ef", LT_MARK_ORANGE = "#ee5007";
const LT_MARK_FRAME = "M273.5 655V370.5a99 99 0 0 1 99-99H605M979.5 583v274.5a99 99 0 0 1-99 99H650M605 956.5H372.5a99 99 0 0 1-99-99V703";
const LT_MARK_ACCENT = "M650 271.5h230.5a99 99 0 0 1 99 99V538";
const LT_MARK_LETTERS = "M365 370l93 92v244h135l66 94H418l-53-54zM503 453h349l54 88H780v332l-96-100V541H563z";

/** Approved LT monogram (segmented frame, orange upper-right corner) as standalone SVG markup; transparent for dark surfaces. */
export const LT_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LT_MARK_BOX}"><g fill="none" stroke-width="56"><path stroke="${LT_MARK_WHITE}" d="${LT_MARK_FRAME}"/><path stroke="${LT_MARK_ORANGE}" d="${LT_MARK_ACCENT}"/></g><path fill="${LT_MARK_WHITE}" d="${LT_MARK_LETTERS}"/></svg>`;

export function LtMark({ className = "" }: { className?: string }) {
  return <svg className={`ltds-mark ${className}`.trim()} viewBox={LT_MARK_BOX} aria-hidden="true" focusable="false">
    <g fill="none" strokeWidth="56"><path stroke={LT_MARK_WHITE} d={LT_MARK_FRAME} /><path stroke={LT_MARK_ORANGE} d={LT_MARK_ACCENT} /></g>
    <path fill={LT_MARK_WHITE} d={LT_MARK_LETTERS} />
  </svg>;
}

export function Brand({ product, name = "Ledge Top" }: { product: string; name?: string }) {
  return <div className="ltds-brand"><LtMark /><span>{name}<small>{product}</small></span></div>;
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

type SkeletonVariant = "text" | "card" | "stats" | "table" | "list" | "form";

/**
 * Shape-matched placeholder while content loads. Announced once to assistive
 * technology through the visually hidden label; the shimmer bars are hidden.
 */
export function Skeleton({ variant = "text", lines = 3, rows = 4, columns = 4, label = "Loading…", className = "" }: {
  variant?: SkeletonVariant; lines?: number; rows?: number; columns?: number; label?: string; className?: string;
}) {
  const bar = (key: number | string, width?: string) => <span key={key} className="ltds-skeleton-bar" style={width ? { width } : undefined} />;
  const widths = ["92%", "76%", "84%", "62%", "70%", "88%"];
  const body = (() => {
    switch (variant) {
      case "card": return <div className="ltds-skeleton-card">{bar("t", "38%")}{Array.from({ length: lines }, (_, i) => bar(i, widths[i % widths.length]))}</div>;
      case "stats": return <div className="ltds-skeleton-stats">{Array.from({ length: columns }, (_, i) =>
        <div key={i} className="ltds-skeleton-stat">{bar("v", "42%")}{bar("l", "68%")}</div>)}</div>;
      case "table": return <div className="ltds-skeleton-table" style={{ ["--skeleton-columns" as string]: String(columns) }}>
        {Array.from({ length: columns }, (_, i) => <span key={`h${i}`} className="ltds-skeleton-bar ltds-skeleton-head" />)}
        {Array.from({ length: rows * columns }, (_, i) => bar(i, widths[i % widths.length]))}</div>;
      case "list": return <div className="ltds-skeleton-list">{Array.from({ length: rows }, (_, i) =>
        <div key={i} className="ltds-skeleton-row"><span className="ltds-skeleton-avatar" /><div>{bar("a", widths[i % widths.length])}{bar("b", "46%")}</div></div>)}</div>;
      case "form": return <div className="ltds-skeleton-form">{Array.from({ length: rows }, (_, i) =>
        <div key={i}>{bar("l", "34%")}<span className="ltds-skeleton-field" /></div>)}</div>;
      default: return <div className="ltds-skeleton-text">{Array.from({ length: lines }, (_, i) => bar(i, widths[i % widths.length]))}</div>;
    }
  })();
  return <div className={`ltds-skeleton ${className}`.trim()} role="status" aria-live="polite" aria-busy="true">
    <span className="visually-hidden">{label}</span><div aria-hidden="true">{body}</div>
  </div>;
}

/**
 * In-app modal dialog on the native <dialog> element: the browser traps focus,
 * Escape closes it, and focus returns to the opener. Children stay mounted while
 * closed, so form state and in-flight retry state survive close and reopen.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "md", dismissible = true }: PropsWithChildren<{
  open: boolean; onClose: () => void; title: string; description?: ReactNode; footer?: ReactNode;
  size?: "sm" | "md" | "lg"; dismissible?: boolean;
}>) {
  const ref = useRef<HTMLDialogElement>(null), opener = useRef<HTMLElement | null>(null);
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      dialog.close();
      opener.current?.focus();
    }
  }, [open]);
  // Unmounting while open (e.g. a dismissed AppDialogHost request) still returns
  // focus to the opener, like a normal close.
  useEffect(() => {
    // Refs are detached before unmount cleanup runs, so keep the element here.
    const dialog = ref.current;
    return () => {
      const target = opener.current;
      if (dialog?.open) { dialog.close(); if (target?.isConnected) target.focus(); }
    };
  }, []);
  return <dialog ref={ref} className={`ltds-dialog ltds-dialog-${size}`} aria-labelledby={titleId}
    aria-describedby={description ? descriptionId : undefined}
    onCancel={event => { event.preventDefault(); if (dismissible) onClose(); }}
    onMouseDown={event => { if (dismissible && event.target === event.currentTarget) onClose(); }}>
    <div className="ltds-dialog-panel">
      <header className="ltds-dialog-header">
        <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
        <button type="button" className="ltds-dialog-close" aria-label="Close" disabled={!dismissible} onClick={onClose}>×</button>
      </header>
      <div className="ltds-dialog-body">{children}</div>
      {footer && <footer className="ltds-dialog-footer">{footer}</footer>}
    </div>
  </dialog>;
}

export function AccountMenu({
  displayName,
  avatar,
  details,
  accountHref,
  onAccount,
  sessionStatus,
  className = "",
}: {
  displayName: string;
  avatar: string;
  details?: ReactNode;
  accountHref?: string;
  onAccount?: () => void;
  sessionStatus?: ReactNode;
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
      {sessionStatus && <div role="none">{sessionStatus}</div>}
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

export type ViewerWindowStatus = "opening" | "ready" | "renewing" | "retrying" | "at-risk" | "closed";

export type ViewerWindowHandle<T extends ViewerSessionGrant = ViewerSessionGrant> = {
  initialSession: T;
  openedIn: "new-tab" | "same-tab";
  close: () => void;
  isClosed: () => boolean;
};

export function isSafeViewerSessionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

export type ViewerShellOpenResult = "new-tab" | "same-tab";

/** Opens an authenticated same-origin Viewer in the current application tab. */
export function openViewerShell(path: string): ViewerShellOpenResult {
  const destination = new URL(path, window.location.origin);
  if (destination.origin !== window.location.origin)
    throw new Error("Viewer shell must use the current application origin");
  window.location.assign(destination.href);
  return "same-tab";
}

/**
 * Same-origin owner for a renewable Viewer iframe. A failed issuance keeps its
 * idempotency key so an ambiguous response can be retried without minting a
 * second grant. A new key is allocated only after a successful issuance.
 */
export function RenewableViewerShell<T extends ViewerShellSessionGrant>({
  routeKey,
  modelId,
  title,
  issueSession,
  onExit,
}: {
  routeKey: string;
  modelId: string;
  title: string;
  issueSession: (idempotencyKey: string) => Promise<T>;
  onExit?: () => void;
}) {
  return <RenewableViewerShellRoute
    key={routeKey}
    modelId={modelId}
    title={title}
    issueSession={issueSession}
    onExit={onExit}
  />;
}

export function validateViewerSessionModel<T extends ViewerSessionGrant>(session: T, modelId: string): T & ViewerShellSessionGrant {
  if (!("modelId" in session) || typeof session.modelId !== "string" || session.modelId !== modelId)
    throw new Error("Viewer session does not match the requested model");
  return session as T & ViewerShellSessionGrant;
}

function RenewableViewerShellRoute<T extends ViewerShellSessionGrant>({
  modelId,
  title,
  issueSession,
  onExit,
}: {
  modelId: string;
  title: string;
  issueSession: (idempotencyKey: string) => Promise<T>;
  onExit?: () => void;
}) {
  const [session, setSession] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const issuanceKey = useRef<string | null>(null);
  const issuance = useRef<Promise<T> | null>(null);
  const issueSessionRef = useRef(issueSession);
  const mounted = useRef(true);
  issueSessionRef.current = issueSession;

  const issue = useCallback((): Promise<T> => {
    if (issuance.current) return issuance.current;
    const key = issuanceKey.current ?? crypto.randomUUID();
    issuanceKey.current = key;
    const request = issueSessionRef.current(key).then(next => {
      validateViewerSessionModel(next, modelId);
      issuanceKey.current = null;
      return next;
    }).finally(() => {
      if (issuance.current === request) issuance.current = null;
    });
    issuance.current = request;
    return request;
  }, [modelId]);

  const start = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await issue();
      if (mounted.current) setSession(next);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "3D Viewer authorization is temporarily unavailable");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [issue]);

  useEffect(() => {
    mounted.current = true;
    void start();
    return () => { mounted.current = false; };
  }, [start]);

  if (loading && !session)
    return <section className="viewer-shell-page" aria-label="3D Viewer"><Loading /></section>;
  if (!session)
    return <section className="viewer-shell-page" aria-label="3D Viewer"><Card title="Secure 3D Viewer"><p className="viewer-session-error" role="alert">{error}</p><div className="actions"><button type="button" className="button-orange" onClick={() => void start()}>Retry secure session</button>{onExit && <button type="button" className="button-ghost" onClick={onExit}>Back</button>}</div></Card></section>;
  return <section className="viewer-shell-page" aria-label="3D Viewer"><ViewerEmbed modelId={modelId} title={title} session={session} renew={issue} onClose={onExit} /></section>;
}

/**
 * Opens the full Viewer as a separate, script-owned tab and keeps only a
 * narrow postMessage renewal channel to it. The opener relationship is
 * intentional: removing it with `noopener` would also remove silent renewal.
 * Both applications validate the exact peer Window, exact Viewer origin,
 * protocol version, and model id before accepting a message. If a browser
 * blocks the synchronous tab, the same one-time grant opens in the current
 * tab so the model remains usable.
 */
export function openViewerWindow<T extends ViewerSessionGrant>({
  modelId,
  title,
  issueSession,
  onStatus,
  onClosed,
}: {
  modelId: string;
  title: string;
  issueSession: () => Promise<T>;
  onStatus?: (status: ViewerWindowStatus, message: string) => void;
  onClosed?: () => void;
}): Promise<ViewerWindowHandle<T>> {
  // This must happen before the first await so normal popup policies recognize
  // the launch as part of the user's click. The blank document runs no code.
  const viewerWindow = window.open("about:blank", "_blank");
  if (viewerWindow) {
    try {
      viewerWindow.document.title = `Opening ${title}`;
      viewerWindow.document.body.textContent = "Opening secure 3D Viewer…";
    } catch { /* The blank placeholder is best effort only. */ }
  }
  onStatus?.("opening", "Opening secure 3D Viewer…");

  return (async () => {
    let initialSession: T;
    try {
      initialSession = await issueSession();
    } catch (error) {
      viewerWindow?.close();
      throw error;
    }
    const initialUrl = new URL(initialSession.embedUrl);
    if (!isSafeViewerSessionUrl(initialUrl.href)) {
      viewerWindow?.close();
      throw new Error("Viewer returned an unsafe session URL");
    }

    if (!viewerWindow) {
      onStatus?.("opening", "The new tab was blocked; opening the Viewer in this tab instead.");
      window.location.assign(initialUrl.href);
      return { initialSession, openedIn: "same-tab", close: () => undefined, isClosed: () => false };
    }

    const viewerOrigin = initialUrl.origin;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let acknowledgementTimer: ReturnType<typeof setTimeout> | null = null;
    let closedTimer: ReturnType<typeof setInterval> | null = null;
    let renewing: Promise<void> | null = null;
    let retryAttempt = 0;
    let currentExpiry = "";
    let cleaned = false;

    const cleanup = (notify = false) => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener("message", receive);
      if (retryTimer) clearTimeout(retryTimer);
      if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
      if (closedTimer) clearInterval(closedTimer);
      if (notify) {
        onStatus?.("closed", "Viewer tab closed.");
        onClosed?.();
      }
    };

    const requestRenewal = (expiresAt: string): Promise<void> => {
      const remaining = Date.parse(expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 2_000 || viewerWindow.closed) {
        onStatus?.("at-risk", "This Viewer session could not be renewed. Reopen the model to reconnect.");
        return Promise.resolve();
      }
      if (renewing || acknowledgementTimer) return renewing || Promise.resolve();
      const run = async () => {
        onStatus?.("renewing", "Renewing secure Viewer session…");
        try {
          const next = await issueSession();
          if (new URL(next.embedUrl).origin !== viewerOrigin) throw new Error("Viewer origin changed");
          viewerWindow.postMessage({ version: 1, type: "ltds-viewer:renew-session", grant: next.grant }, viewerOrigin);
          acknowledgementTimer = setTimeout(() => {
            acknowledgementTimer = null;
            void requestRenewal(currentExpiry);
          }, 8_000);
          retryAttempt = 0;
        } catch {
          const retryWindow = Date.parse(expiresAt) - Date.now();
          if (!Number.isFinite(retryWindow) || retryWindow <= 2_000) {
            onStatus?.("at-risk", "This Viewer session could not be renewed. Reopen the model to reconnect.");
            return;
          }
          const delay = Math.min(15_000, 1_000 * 2 ** Math.min(retryAttempt++, 4), Math.max(500, retryWindow - 1_000));
          onStatus?.("retrying", "Viewer renewal is retrying…");
          retryTimer = setTimeout(() => void requestRenewal(expiresAt), delay);
        } finally {
          renewing = null;
        }
      };
      renewing = run();
      return renewing;
    };

    const receive = (event: MessageEvent<ViewerMessage>) => {
      if (event.source !== viewerWindow || event.origin !== viewerOrigin || event.data?.version !== 1 ||
        !event.data || event.data.modelId !== modelId) return;
      if (event.data.type === "ltds-viewer:ready" && event.data.expiresAt) {
        currentExpiry = event.data.expiresAt;
        onStatus?.("ready", "Viewer opened in a new tab.");
      } else if (event.data.type === "ltds-viewer:session-expiring" && event.data.expiresAt) {
        currentExpiry = event.data.expiresAt;
        void requestRenewal(event.data.expiresAt);
      } else if (event.data.type === "ltds-viewer:session-renewed" && event.data.expiresAt) {
        if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
        acknowledgementTimer = null;
        currentExpiry = event.data.expiresAt;
        retryAttempt = 0;
        onStatus?.("ready", "Viewer session renewed.");
      } else if (event.data.type === "ltds-viewer:session-renewal-failed") {
        if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
        acknowledgementTimer = null;
        void requestRenewal(currentExpiry);
      }
    };

    window.addEventListener("message", receive);
    closedTimer = setInterval(() => {
      if (viewerWindow.closed) cleanup(true);
    }, 1_000);
    viewerWindow.location.replace(initialUrl.href);

    return {
      initialSession,
      openedIn: "new-tab",
      close: () => { cleanup(); viewerWindow.close(); },
      isClosed: () => viewerWindow.closed,
    };
  })();
}

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
