/** Stable local provenance, not a producer credential or an authorization grant. */
export const PRIMARY_ALPHA_SOURCE_ID = "project-alpha:primary" as const;

export interface CatalogSourceContext { readonly sourceId: string }

/** Only trusted server configuration may select this context; never a browser/header. */
export function createCatalogSourceContext(sourceId: unknown): CatalogSourceContext {
  if (typeof sourceId !== "string" || sourceId !== sourceId.trim()
    || !/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId)) {
    throw new Error("catalog-source-invalid");
  }
  return Object.freeze({ sourceId });
}

export const PRIMARY_CATALOG_SOURCE = createCatalogSourceContext(PRIMARY_ALPHA_SOURCE_ID);

/** Staff-facing name for a Project Alpha source. Display only; never an identity or authority input. */
export function projectAlphaSourceName(sourceId: string | null | undefined): string {
  if (!sourceId) return "Unknown Project Alpha source";
  if (sourceId === "project-alpha:primary") return "Ledge Top Drone Services";
  if (sourceId === "project-alpha:secondary") return "Ledge Top Technologies";
  const suffix = /^project-alpha:([a-z0-9][a-z0-9_-]{0,63})$/.exec(sourceId)?.[1];
  return suffix ? `Project Alpha (${suffix})` : "Unknown Project Alpha source";
}
