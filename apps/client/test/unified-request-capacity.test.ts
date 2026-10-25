import { describe, expect, it, vi } from "vitest";
import { listPortalWorkspaces } from "../src/worker/client-portal/workspace-v2";
import { createUnifiedRequestRouter } from "../src/worker/client-portal/unified-request-routes";
import type { Env } from "../src/worker/types";

const principal = { issuer: "issuer", subject: "subject", email: "client@example.com" };
function overflowDatabase() {
  const queries: string[] = [];
  const db = {
    withSession: () => db,
    prepare: (sql: string) => {
      queries.push(sql);
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async (column?: string) => {
          if (sql.includes("SELECT id FROM portal_v2_identities")) return { id: "person" };
          if (sql.includes("portal_v2_identity_eligibility_blocks")) return null;
          if (column === "n" && sql.includes("sqlite_master")) return 5;
          if (sql.includes("sqlite_master")) return { count: 1 };
          throw Error(`Unexpected first query: ${sql}`);
        },
        all: async () => {
          if (sql.includes("w.legacy_account_id IS NOT NULL")) return { results: [], success: true };
          if (sql.includes("SELECT w.id") && sql.includes("w.legacy_account_id IS NULL") && sql.includes("LIMIT 33"))
            return { results: Array.from({ length: 33 }, (_, n) => ({ id: `native-${n}` })), success: true };
          throw Error(`Unexpected all query: ${sql}`);
        },
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, queries };
}

describe("authoritative workspace discovery capacity", () => {
  it("retains legacy empty-on-overflow behavior but strict discovery returns 503 from the actual D1 sentinel path", async () => {
    const { db, queries } = overflowDatabase();
    const env = { DELIVERY_DB: db, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_ORIGIN: "https://client.example" } as Env;
    expect(await listPortalWorkspaces(env, principal)).toEqual([]);
    await expect(listPortalWorkspaces(env, principal, { strictCapacity: true })).rejects.toMatchObject({ status: 503 });
    const scopedFetch = vi.fn();
    const router = createUnifiedRequestRouter({ resolvePrincipal: async () => principal, checkConfiguration: false, scopedFetch });
    const response = await router.request("https://client.example/request-services", {}, env);
    expect(response.status).toBe(503);
    expect(scopedFetch).not.toHaveBeenCalled();
    expect(queries.filter(sql => sql.includes("w.legacy_account_id IS NULL") && sql.includes("LIMIT 33"))).toHaveLength(3);
  });
});
