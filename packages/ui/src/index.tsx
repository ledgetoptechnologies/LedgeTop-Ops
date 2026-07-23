import type { PropsWithChildren, ReactNode } from "react";
import { BRAND } from "@ltds/shared";

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
