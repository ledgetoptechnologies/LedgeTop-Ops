export type PortalBrandKey = "drone-services" | "technologies" | "generic";

export interface PortalBrandContext {
  key: PortalBrandKey;
  /** Shared umbrella presentation. Legal/business division is shown separately. */
  name: "Ledge Top";
  division: "Drone Services" | "Technologies" | "Workspace";
  shortName: "LTDS" | "LTT" | "Ledge Top";
  sourceId: string | null;
}

const SOURCE_BRANDS: Readonly<Record<string, PortalBrandContext>> = {
  "project-alpha:primary": {
    key: "drone-services",
    name: "Ledge Top",
    division: "Drone Services",
    shortName: "LTDS",
    sourceId: "project-alpha:primary",
  },
  "project-alpha:secondary": {
    key: "technologies",
    name: "Ledge Top",
    division: "Technologies",
    shortName: "LTT",
    sourceId: "project-alpha:secondary",
  },
};

const HOST_BRANDS: Readonly<Record<string, PortalBrandContext>> = {
  "portal.ledgetopdroneservices.com": SOURCE_BRANDS["project-alpha:primary"]!,
  "portal.ledgetoptechnologies.com": SOURCE_BRANDS["project-alpha:secondary"]!,
};

const GENERIC_BRAND: PortalBrandContext = {
  key: "generic",
  name: "Ledge Top",
  division: "Workspace",
  shortName: "Ledge Top",
  sourceId: null,
};

/**
 * Resolves the presentation from the strongest available context. A selected
 * Project Alpha source wins over the hostname so a user switching workspaces
 * never sees the other company's legal context by accident. Unknown sources
 * stay generic until the source is explicitly mapped.
 */
export function resolvePortalBrand(
  hostname: string | null | undefined,
  sourceId?: string | null,
): PortalBrandContext {
  if (typeof sourceId === "string" && sourceId.trim()) {
    return SOURCE_BRANDS[sourceId.trim().toLocaleLowerCase("en-US")] ?? GENERIC_BRAND;
  }
  const host = typeof hostname === "string"
    ? HOST_BRANDS[hostname.trim().toLocaleLowerCase("en-US")]
    : undefined;
  return host ?? GENERIC_BRAND;
}
