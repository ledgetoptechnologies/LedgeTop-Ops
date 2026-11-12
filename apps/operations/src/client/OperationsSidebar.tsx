import { Brand, LtMark } from "@ltds/ui";
import { AppBreadcrumb, AppSidebar, readSidebarCollapsed as readCollapsed, type SidebarArea as Area, type SidebarGroup as Group, type SidebarLink as Link } from "@ltds/ui/app-sidebar";
import type { OperationsPage as Page } from "./operations-route";
import "./OperationsShell.css";

/** Operations' use of the shared sidebar (@ltds/ui/app-sidebar); the Client Portal uses the same component. */
export type { SidebarIcon } from "@ltds/ui/app-sidebar";
export { currentSection } from "@ltds/ui/app-sidebar";
export type SidebarLink = Link<Page>;
export type SidebarArea = Area<Page>;
export type SidebarGroup = Group<Page>;

const COLLAPSED_KEY = "ltds.ops.sidebar.collapsed";
export const readSidebarCollapsed = () => readCollapsed(COLLAPSED_KEY);

export function OperationsSidebar({ groups, page, variant, collapsed, onCollapsedChange, onNavigate }: {
  groups: SidebarGroup[];
  page: Page;
  variant: "desktop" | "drawer";
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate: (page: Page, href: string) => void;
}) {
  return <AppSidebar groups={groups} page={page} variant={variant} collapsed={collapsed} onCollapsedChange={onCollapsedChange} onNavigate={onNavigate}
    navigationLabel={variant === "desktop" ? "Primary navigation" : "Mobile primary navigation"} storageKey={COLLAPSED_KEY}
    home={{ page: "dashboard", label: "Dashboard", href: "/", name: "Ledge Top Operations dashboard" }}
    brand={<Brand product="Operations" name="Ledge Top" />} mark={<LtMark />} />;
}

export const OperationsBreadcrumb = AppBreadcrumb<Page>;
