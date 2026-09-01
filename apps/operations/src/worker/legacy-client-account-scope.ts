/**
 * Native request storage accounts satisfy the mature request-table foreign
 * keys only. They are not login workspaces and must never appear in, or be a
 * mutation target of, the legacy client-account administration surface.
 */
export function excludesNativeRequestStorageAccount(
  accountAlias: "a" | "account" | "client_accounts",
  bindingTablePresent = true,
): string {
  const reservedNamespace = `${accountAlias}.id NOT LIKE 'native-request-account:%'`;
  if (!bindingTablePresent) return reservedNamespace;
  return `${reservedNamespace} AND NOT EXISTS (
    SELECT 1 FROM portal_native_request_storage_bindings native_request_storage
    WHERE native_request_storage.account_id=${accountAlias}.id
  )`;
}

export async function listLegacyClientAccountsForAdministration(
  env: Pick<Env, "DELIVERY_DB">,
): Promise<unknown[]> {
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT a.id,a.display_name,a.status,a.project_alpha_client_id,a.project_alpha_organization_id,
       COUNT(DISTINCT g.project_id) project_count
     FROM client_accounts a
     LEFT JOIN client_project_grants g ON g.account_id=a.id AND g.revoked_at IS NULL
     WHERE ${excludesNativeRequestStorageAccount("a")}
     GROUP BY a.id ORDER BY a.display_name`,
  ).all();
  return rows.results;
}
import type { Env } from "./types";
