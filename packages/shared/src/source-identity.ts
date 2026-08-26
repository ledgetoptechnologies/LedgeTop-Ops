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
