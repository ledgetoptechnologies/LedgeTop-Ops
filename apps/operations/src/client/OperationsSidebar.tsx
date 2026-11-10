import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Brand, LtMark } from "@ltds/ui";
import type { OperationsPage as Page } from "./operations-route";
import "./OperationsSidebar.css";

/**
 * The Operations sidebar: areas grouped by what staff are doing, with each area's sections listed
 * underneath. It only links to the paths pages already use, so routing, redirects and permission
 * checks stay with OperationsApp and the pages themselves.
 */
export type SidebarIcon = "home" | "bell" | "operations" | "airspace" | "clients" | "data" | "models" | "intel" | "team" | "administration";
export type SidebarLink = { page: Page; label: string; href: string };
export type SidebarArea = SidebarLink & { icon: SidebarIcon; sections?: SidebarLink[] };
export type SidebarGroup = { label: string; areas: SidebarArea[] };

const ICONS: Record<SidebarIcon, ReactNode> = {
  home: <><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" /><path d="M9 20h6" /></>,
  operations: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></>,
  airspace: <><path d="M2 16 22 8" /><path d="M13 11.5 9 4H6l3 9" /><path d="m8 15-2 5h3l4-6.5" /></>,
  clients: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20" /></>,
  data: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  models: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>,
  intel: <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />,
  team: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  administration: <><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6Z" /><path d="m9 12 2 2 4-4" /></>,
};
const Icon = ({ name }: { name: SidebarIcon }) =>
  <svg className="ops-sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;

/** The section whose path best matches the address: exact, or the longest prefix ending at a "/". */
export function currentSection(sections: SidebarLink[], pathname: string): SidebarLink | undefined {
  let best: SidebarLink | undefined;
  for (const section of sections) {
    const match = pathname === section.href || pathname.startsWith(section.href.endsWith("/") ? section.href : `${section.href}/`);
    if (match && (!best || section.href.length > best.href.length)) best = section;
  }
  return best;
}

const COLLAPSED_KEY = "ltds.ops.sidebar.collapsed";
export function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
}
function saveSidebarCollapsed(value: boolean) {
  try { localStorage.setItem(COLLAPSED_KEY, String(value)); } catch { /* Collapsing still works for this visit. */ }
}

function plainClick(event: ReactMouseEvent) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function OperationsSidebar({ groups, page, variant, collapsed = false, onCollapsedChange, onNavigate }: {
  groups: SidebarGroup[];
  page: Page;
  variant: "desktop" | "drawer";
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate: (page: Page, href: string) => void;
}) {
  const [pathname, setPathname] = useState(() => location.pathname);
  const [open, setOpen] = useState<Set<Page>>(() => new Set([page]));
  const [flyout, setFlyout] = useState<{ area: SidebarArea; top: number; left: number } | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const rail = variant === "desktop" && collapsed;

  useEffect(() => {
    const sync = () => setPathname(location.pathname);
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  // Opening a page from elsewhere (a dashboard tile, a link) also opens its area here.
  useEffect(() => { setPathname(location.pathname); setOpen(previous => previous.has(page) ? previous : new Set(previous).add(page)); }, [page]);
  useEffect(() => {
    if (!flyout) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !flyoutRef.current?.contains(event.target as Node)) setFlyout(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    addEventListener("resize", () => setFlyout(null), { once: true });
    flyoutRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [flyout]);

  const go = (link: SidebarLink) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    setFlyout(null);
    setPathname(link.href);
    onNavigate(link.page, link.href);
  };

  const sectionLink = (section: SidebarLink, current: boolean) =>
    <a key={section.href} className="ops-sidebar-section" href={section.href} aria-current={current ? "page" : undefined} onClick={go(section)}>{section.label}</a>;

  const area = (item: SidebarArea) => {
    const sections = item.sections ?? [];
    const here = page === item.page;
    if (sections.length < 2) {
      const target = sections[0] ?? item;
      return <a key={item.page} className="ops-sidebar-item" href={target.href} title={rail ? item.label : undefined}
        aria-current={here ? "page" : undefined} onClick={go({ ...target, page: item.page })}>
        <Icon name={item.icon} /><span className="ops-sidebar-label">{item.label}</span>
      </a>;
    }
    const current = here ? currentSection(sections, pathname) : undefined;
    const expanded = open.has(item.page);
    const toggle = (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (rail) {
        const box = event.currentTarget.getBoundingClientRect();
        setFlyout(previous => previous?.area.page === item.page ? null : { area: item, top: box.top, left: box.right + 8 });
        return;
      }
      setOpen(previous => { const next = new Set(previous); if (next.has(item.page)) next.delete(item.page); else next.add(item.page); return next; });
    };
    return <div key={item.page} className={`ops-sidebar-area${here ? " is-current" : ""}`}>
      <button type="button" className="ops-sidebar-item" title={rail ? item.label : undefined}
        aria-expanded={rail ? flyout?.area.page === item.page : expanded} aria-haspopup={rail ? "true" : undefined} onClick={toggle}>
        <Icon name={item.icon} /><span className="ops-sidebar-label">{item.label}</span>
        <svg className="ops-sidebar-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      {!rail && expanded && <div className="ops-sidebar-sections">{sections.map(section => sectionLink(section, current?.href === section.href))}</div>}
    </div>;
  };

  return <div className={`ops-sidebar ops-sidebar-${variant}${rail ? " is-collapsed" : ""}`}>
    {variant === "desktop" && <a className="ops-sidebar-brand" href="/" aria-label="Ledge Top Operations dashboard"
      onClick={go({ page: "dashboard", label: "Dashboard", href: "/" })}>{rail ? <LtMark /> : <Brand product="Operations" name="Ledge Top" />}</a>}
    <nav aria-label={variant === "desktop" ? "Primary navigation" : "Mobile primary navigation"} className="ops-sidebar-nav">
      {groups.filter(group => group.areas.length).map(group => <div key={group.label} className="ops-sidebar-group">
        <span className="ops-sidebar-group-label" aria-hidden={rail ? "true" : undefined}>{group.label}</span>
        {group.areas.map(area)}
      </div>)}
    </nav>
    {variant === "desktop" && onCollapsedChange && <button type="button" className="ops-sidebar-collapse" aria-pressed={collapsed}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      onClick={() => { const next = !collapsed; saveSidebarCollapsed(next); setFlyout(null); onCollapsedChange(next); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="1.5" /><path d="M9 5v14" /><path d={collapsed ? "m13 10 2 2-2 2" : "m15 10-2 2 2 2"} /></svg>
      <span className="ops-sidebar-label">Collapse sidebar</span>
    </button>}
    {flyout && <div ref={flyoutRef} className="ops-sidebar-flyout" role="group" aria-label={flyout.area.label}
      style={{ top: Math.max(8, Math.min(flyout.top - 6, innerHeight - 56 * ((flyout.area.sections?.length ?? 1) + 1))), left: flyout.left }}>
      <strong>{flyout.area.label}</strong>
      {(flyout.area.sections ?? []).map(section => sectionLink(section, page === flyout.area.page && currentSection(flyout.area.sections ?? [], pathname)?.href === section.href))}
    </div>}
  </div>;
}
