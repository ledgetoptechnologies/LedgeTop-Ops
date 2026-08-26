import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";

/** Internal SQL aliases only. Source provenance is not an authorization grant. */
export function primaryAlphaReference(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("invalid-source-alias");
  return `${alias}.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}'`;
}

/** Local-only requests remain supported; no secondary record reaches the sole primary connector. */
export function localOrPrimaryAlphaReference(alias: string): string {
  return `(${alias}.project_alpha_source_id IS NULL OR ${primaryAlphaReference(alias)})`;
}

/** Existing local-only workspace wrappers remain usable, but are never Alpha proof. */
export function primaryWorkspaceAccount(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("invalid-source-alias");
  return `(${alias}.legacy_account_id IS NULL OR EXISTS(SELECT 1 FROM client_accounts source_account
    WHERE source_account.id=${alias}.legacy_account_id AND ${localOrPrimaryAlphaReference("source_account")}))`;
}
