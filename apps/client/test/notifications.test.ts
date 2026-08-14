import { describe, expect, it } from "vitest";
import { firstAccessDedupeKey, recordFirstAccessNotification } from "../src/worker/notifications";

describe("delivery notification recording", () => {
  it("uses one stable first-access key per share", () => {
    expect(firstAccessDedupeKey("share-123")).toBe("first_access:share-123");
    expect(firstAccessDedupeKey("share-123", "principal-a")).toBe("first_access:share-123:principal-a");
  });

  it("falls back to the legacy share recipient before migration 0126", async () => {
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const database = {
      withSession() { return database; },
      prepare(sql: string) {
        const call = { sql, binds: [] as unknown[] };
        calls.push(call);
        const statement = {
          bind(...binds: unknown[]) { call.binds = binds; return statement; },
          async first<T>() { return { count: 0 } as T; },
          async all<T>() { throw new Error(`Unexpected pre-migration query: ${sql}`); },
          async run<T>() { return { results: [] as T[], meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map(statement => statement.run()));
      },
    };
    await recordFirstAccessNotification({ DELIVERY_DB: database as unknown as D1Database }, {
      id: "share-legacy",
      recipient_email: "legacy@example.test",
      public_id: "public-legacy",
      client_name: "Acme",
      project_name: "North site",
      r2_prefix: "Jobs/Clients/Acme/North/",
    });

    expect(calls.some(call => call.sql.includes("JOIN delivery_share_audience_snapshots"))).toBe(false);
    const insert = calls.find(call => call.sql.includes("INSERT OR IGNORE INTO delivery_notifications"));
    expect(insert?.binds.slice(1, 5)).toEqual([
      "first_access:share-legacy",
      "share-legacy",
      "first_access",
      "legacy@example.test",
    ]);
  });
});
