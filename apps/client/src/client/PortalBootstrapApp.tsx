import { lazy, useEffect, useState } from "react";
import { OperationsHomeApp } from "./OperationsHomeApp";
import { loadOperationsHome, type PortalOperationsHomeResponse } from "./portal-api";

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
  if (status === 401) return { heading: "Sign in required", detail: "Sign in through the authorized LedgeTop portal to continue." };
  if (status === 403) return { heading: "Service home access is not enabled", detail: "Your account does not currently have permission to view this service home." };
  return { heading: "Service home unavailable", detail: "The service home could not be verified. Please try again later." };
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
  if (state.kind === "operations") return <OperationsHomeApp response={state.response} />;
  if (state.kind === "loading") return <main className="portal-loading-shell" aria-busy="true" aria-label="Loading LedgeTop client portal" />;
  const copy = blockedCopy(state.status);
  return <div className="client-portal"><main className="portal-main"><section className="portal-card" role="alert"><h1>{copy.heading}</h1><p>{copy.detail}</p></section></main></div>;
}
