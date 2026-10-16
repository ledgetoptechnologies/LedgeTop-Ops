import type { ReactNode } from "react";
import { LtMark } from "@ltds/ui";

/** One generic Ledge Top identity on every portal domain and workspace. */
export function PortalBrand({ product }: { product: string }) {
  return <div className="ltds-brand portal-brand" data-portal-division="generic" aria-label={`Ledge Top ${product}`}>
    <LtMark />
    <span className="portal-brand-copy"><strong>Ledge Top</strong><small>{product}</small></span>
  </div>;
}

/** Branded frame for portal states shown before a workspace loads. */
export function PortalBoundary({ children }: { children: ReactNode }) {
  return (
    <div className="client-portal-boundary">
      <header className="client-portal-gate-header">
        <PortalBrand product="Client portal" />
      </header>
      <main className="client-portal-gate-main">{children}</main>
    </div>
  );
}

