import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import "./AppSidebar.css";

/**
 * The shared Ledge Top app sidebar (Operations, Client Portal): areas grouped by what people are doing,
 * with each area's sections listed underneath. Desktop shows it beside the page and can collapse it to
 * an icon rail; phones show the same tree in the app's navigation drawer. It only links to paths the
 * app already serves, so routing and permission checks stay with the app.
 */
export type SidebarIcon =
  | "home" | "bell" | "operations" | "airspace" | "clients" | "data" | "models" | "intel" | "team" | "administration"
  | "projects" | "deliveries" | "requests" | "feedback" | "account" | "crm";
export type SidebarLink<P extends string = string> = { page: P; label: string; href: string };
export type SidebarArea<P extends string = string> = SidebarLink<P> & { icon: SidebarIcon; sections?: SidebarLink<P>[] };
export type SidebarGroup<P extends string = string> = { label: string; areas: SidebarArea<P>[] };

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
  projects: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  deliveries: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 17v3h16v-3" /></>,
  requests: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3" /></>,
  feedback: <path d="M4 5h16v11H9l-5 4Z" />,
  account: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 18.5a6.5 6.5 0 0 1 11 0" /></>,
  crm: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="2" /><path d="M6 16a3 3 0 0 1 6 0M15 10h3M15 14h3" /></>,
};
const Icon = ({ name }: { name: SidebarIcon }) =>
  <svg className="ltds-sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;

/** The section whose path best matches the address: exact, or the longest prefix ending at a "/". */
export function currentSection<P extends string>(sections: SidebarLink<P>[], pathname: string): SidebarLink<P> | undefined {
  let best: SidebarLink<P> | undefined;
  for (const section of sections) {
    const match = pathname === section.href || pathname.startsWith(section.href.endsWith("/") ? section.href : `${section.href}/`);
    if (match && (!best || section.href.length > best.href.length)) best = section;
  }
  return best;
}

export function readSidebarCollapsed(storageKey: string): boolean {
  try { return localStorage.getItem(storageKey) === "true"; } catch { return false; }
}
function saveSidebarCollapsed(storageKey: string, value: boolean) {
  try { localStorage.setItem(storageKey, String(value)); } catch { /* Collapsing still works for this visit. */ }
}

function plainClick(event: ReactMouseEvent) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function usePathname(page: string) {
  const [pathname, setPathname] = useState(() => location.pathname);
  useEffect(() => {
    const sync = () => setPathname(location.pathname);
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  useEffect(() => { setPathname(location.pathname); }, [page]);
  return [pathname, setPathname] as const;
}

/**
 * "Area › Section" above the page for areas with more than one section. The sidebar lists the sections;
 * this replaces in-page tab bars that used to repeat them, and is the location cue on phones.
 */
export function AppBreadcrumb<P extends string>({ groups, page, onNavigate }: { groups: SidebarGroup<P>[]; page: P; onNavigate: (page: P, href: string) => void }) {
  const [pathname] = usePathname(page);
  const area = groups.flatMap(group => group.areas).find(item => item.page === page);
  const sections = area?.sections ?? [];
  const section = sections.length > 1 ? currentSection(sections, pathname) : undefined;
  if (!area || !section) return null;
  const first = sections[0]!;
  return <nav className="ltds-breadcrumb" aria-label="Breadcrumb"><ol>
    <li>{section.href === first.href ? <span>{area.label}</span> : <a href={first.href} onClick={event => {
      if (!plainClick(event)) return;
      event.preventDefault();
      onNavigate(page, first.href);
    }}>{area.label}</a>}</li>
    <li aria-current="page">{section.label}</li>
  </ol></nav>;
}

export function AppSidebar<P extends string>({ groups, page, variant, home, brand, mark, navigationLabel, collapsed = false, storageKey, onCollapsedChange, onNavigate, isCurrent }: {
  groups: SidebarGroup<P>[];
  page: P;
  variant: "desktop" | "drawer";
  /** Where the brand at the top of the desktop sidebar leads, and its accessible name. */
  home?: SidebarLink<P> & { name: string };
  /** The full brand, and the mark shown in the collapsed rail. */
  brand?: ReactNode;
  mark?: ReactNode;
  navigationLabel: string;
  collapsed?: boolean;
  /** localStorage key that remembers the collapsed rail between visits. */
  storageKey?: string;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate: (page: P, href: string) => void;
  /** Optional: treat an area as current on related pages (e.g. a project inside Projects). */
  isCurrent?: (area: SidebarArea<P>) => boolean;
}) {
  const [pathname, setPathname] = usePathname(page);
  const [open, setOpen] = useState<Set<P>>(() => new Set([page]));
  const [flyout, setFlyout] = useState<{ area: SidebarArea<P>; top: number; left: number } | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const rail = variant === "desktop" && collapsed;

  // Opening a page from elsewhere (a dashboard tile, a link) also opens its area here.
  useEffect(() => { setOpen(previous => previous.has(page) ? previous : new Set(previous).add(page)); }, [page]);
  useEffect(() => {
    if (!flyout) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !flyoutRef.current?.contains(event.target as Node)) setFlyout(null);
    };
    const resize = () => setFlyout(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    addEventListener("resize", resize);
    flyoutRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); removeEventListener("resize", resize); };
  }, [flyout]);

  const go = (link: SidebarLink<P>) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    setFlyout(null);
    setPathname(link.href);
    onNavigate(link.page, link.href);
  };

  const sectionLink = (section: SidebarLink<P>, current: boolean) =>
    <a key={section.href} className="ltds-sidebar-section" href={section.href} aria-current={current ? "page" : undefined} onClick={go(section)}>{section.label}</a>;

  const area = (item: SidebarArea<P>) => {
    const sections = item.sections ?? [];
    const here = page === item.page || isCurrent?.(item) === true;
    if (sections.length < 2) {
      const target = sections[0] ?? item;
      return <a key={item.page} className="ltds-sidebar-item" href={target.href} title={rail ? item.label : undefined}
        aria-current={here ? "page" : undefined} onClick={go({ ...target, page: item.page })}>
        <Icon name={item.icon} /><span className="ltds-sidebar-label">{item.label}</span>
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
    return <div key={item.page} className={`ltds-sidebar-area${here ? " is-current" : ""}`}>
      <button type="button" className="ltds-sidebar-item" title={rail ? item.label : undefined}
        aria-expanded={rail ? flyout?.area.page === item.page : expanded} aria-haspopup={rail ? "true" : undefined} onClick={toggle}>
        <Icon name={item.icon} /><span className="ltds-sidebar-label">{item.label}</span>
        <svg className="ltds-sidebar-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      {!rail && expanded && <div className="ltds-sidebar-sections">{sections.map(section => sectionLink(section, current?.href === section.href))}</div>}
    </div>;
  };

  return <div className={`ltds-sidebar ltds-sidebar-${variant}${rail ? " is-collapsed" : ""}`}>
    {variant === "desktop" && home && <a className="ltds-sidebar-brand" href={home.href} aria-label={home.name}
      onClick={go(home)}>{rail ? mark : brand}</a>}
    <nav aria-label={navigationLabel} className="ltds-sidebar-nav">
      {groups.filter(group => group.areas.length).map(group => <div key={group.label} className="ltds-sidebar-group">
        {group.label && <span className="ltds-sidebar-group-label" aria-hidden={rail ? "true" : undefined}>{group.label}</span>}
        {group.areas.map(area)}
      </div>)}
    </nav>
    {variant === "desktop" && onCollapsedChange && <button type="button" className="ltds-sidebar-collapse" aria-pressed={collapsed}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      onClick={() => { const next = !collapsed; if (storageKey) saveSidebarCollapsed(storageKey, next); setFlyout(null); onCollapsedChange(next); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="1.5" /><path d="M9 5v14" /><path d={collapsed ? "m13 10 2 2-2 2" : "m15 10-2 2 2 2"} /></svg>
      <span className="ltds-sidebar-label">Collapse sidebar</span>
    </button>}
    {flyout && <div ref={flyoutRef} className="ltds-sidebar-flyout" role="group" aria-label={flyout.area.label}
      style={{ top: Math.max(8, Math.min(flyout.top - 6, innerHeight - 56 * ((flyout.area.sections?.length ?? 1) + 1))), left: flyout.left }}>
      <strong>{flyout.area.label}</strong>
      {(flyout.area.sections ?? []).map(section => sectionLink(section, page === flyout.area.page && currentSection(flyout.area.sections ?? [], pathname)?.href === section.href))}
    </div>}
  </div>;
}
