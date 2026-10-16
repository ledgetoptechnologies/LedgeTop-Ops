import { lazy, useEffect, useState } from "react";
import { loadOperationsHome, type PortalOperationsHomeResponse } from "./portal-api";
import { PortalBoundary } from "./PortalShell";

type BootstrapState =
  | { kind: "loading" }
  | { kind: "legacy" }
  | { kind: "operations"; response: PortalOperationsHomeResponse }
  | { kind: "blocked"; status?: number };

const LegacyClientPortalApp = lazy(async () => {
  const module = await import("./ClientPortalApp");
  return { default: module.ClientPortalApp };
});

export function isUnifiedPortalRoot(pathname: string): boolean {
  return pathname === "/portal" || pathname === "/portal/";
}

export function operationsBootstrapOutcome(error: unknown): "legacy" | "blocked" {
  if (typeof error !== "object" || error === null) return "blocked";
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "status");
    return descriptor && "value" in descriptor && descriptor.value === 404 ? "legacy" : "blocked";
  } catch {
    return "blocked";
  }
}

function blockedCopy(status?: number): { heading: string; detail: string } {
  if (status === 401) return { heading: "Sign in required", detail: "Your session has ended. Sign in with the email address registered with Ledge Top to continue." };
  if (status === 403) return { heading: "Service access not set up yet", detail: "You're signed in, but this account doesn't have Ledge Top service access yet. Contact your Ledge Top representative." };
  return { heading: "Client portal unavailable", detail: "Your client portal could not be verified right now. Please try again in a minute." };
}

export function PortalBootstrapApp() {
  const [state, setState] = useState<BootstrapState>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void loadOperationsHome(undefined, controller.signal).then(
      response => {
        if (!controller.signal.aborted) setState({ kind: "operations", response });
      },
      error => {
        if (controller.signal.aborted) return;
        if (operationsBootstrapOutcome(error) === "legacy") setState({ kind: "legacy" });
        else {
          let status: number | undefined;
          try {
            const descriptor = typeof error === "object" && error !== null ? Object.getOwnPropertyDescriptor(error, "status") : undefined;
            if (descriptor && "value" in descriptor && typeof descriptor.value === "number") status = descriptor.value;
          } catch { /* A hostile error object is an unavailable response. */ }
          setState({ kind: "blocked", status });
        }
      },
    );
    return () => controller.abort();
  }, []);

  if (state.kind === "legacy") return <LegacyClientPortalApp initialPage="dashboard" />;
  if (state.kind === "operations") return <LegacyClientPortalApp initialPage="dashboard" operationsHomeResponse={state.response} />;
  if (state.kind === "loading") return <main className="portal-loading-shell" aria-busy="true" aria-label="Loading Ledge Top client portal" />;
  const copy = blockedCopy(state.status);
  return <PortalBoundary><section className="portal-card portal-gate-card" role="alert"><h1>{copy.heading}</h1><p>{copy.detail}</p>
  </section></PortalBoundary>;
}
