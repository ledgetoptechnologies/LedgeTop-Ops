import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLIENT_DELEGATED_SHARE_CURSOR_MAX_PAGES,
  CLIENT_DELEGATED_SHARE_PAGE_SIZE,
  clientDelegatedShareCursorExpired,
  decodeClientDelegatedShareCursor,
  encodeClientDelegatedShareCursor,
  pageClientDelegatedShareRows,
  pageClientDelegatedShareTargetRows,
} from "../src/worker/client-portal/delegated-shares";
import { DELEGATED_SHARE_LIST_PAGE_LIMIT, loadPortalDelegatedShares, loadPortalDelegatedShareTargets, type PortalRequest } from "../src/client/portal-api";

const workspaceId = "workspace-paging-01";
const identityId = "identity-paging-01";
const TOTAL = 250;
const pad = (n: number) => String(n).padStart(4, "0");

describe("delegated share listings page past 100 rows", () => {
  let miniflare: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-16",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "delegated-share-paging" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec([
      "CREATE TABLE client_delegated_shares(id TEXT PRIMARY KEY,public_id TEXT,workspace_id TEXT,delegation_id TEXT,folder_target_id TEXT,label TEXT,status TEXT,expires_at TEXT,revoked_at TEXT,created_at TEXT)",
      "CREATE TABLE client_share_delegations(id TEXT PRIMARY KEY,workspace_id TEXT,identity_id TEXT,folder_binding_id TEXT,maximum_link_lifetime_seconds INTEGER,require_password INTEGER,status TEXT,revoked_at TEXT,expires_at TEXT)",
      "CREATE TABLE client_share_folder_targets(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT,status TEXT,revoked_at TEXT)",
      "CREATE TABLE client_share_folder_target_labels(target_id TEXT,workspace_id TEXT,display_name TEXT)",
    ].join(";\n"));
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < TOTAL; i++) {
      // Ten shares per timestamp exercise the id tie-break inside one created_at.
      statements.push(db.prepare(`INSERT INTO client_delegated_shares VALUES (?,?,?,'delegation-x','target-x',NULL,'active',
        datetime('now','+1 day'),NULL,datetime('2026-01-01','+' || ? || ' minutes'))`)
        .bind(`share-${pad(i)}`, `public-${pad(i)}`, workspaceId, Math.floor(i / 10)));
      statements.push(db.prepare(`INSERT INTO client_share_folder_targets VALUES (?,?,?,'active',NULL)`)
        .bind(`target-${pad(i)}`, workspaceId, `binding-${pad(i % 5)}`));
      // Mixed case and repeated labels exercise NOCASE ordering and the id tie-breaks.
      statements.push(db.prepare(`INSERT INTO client_share_folder_target_labels VALUES (?,?,?)`)
        .bind(`target-${pad(i)}`, workspaceId, `${i % 2 ? "folder" : "Folder"} ${pad(Math.floor(i / 25))}`));
    }
    for (let b = 0; b < 5; b++) statements.push(db.prepare(`INSERT INTO client_share_delegations
      VALUES (?,?,?,?,86400,0,'active',NULL,datetime('now','+30 days'))`).bind(`delegation-${b}`, workspaceId, identityId, `binding-${pad(b)}`));
    // A share in another workspace must never appear.
    statements.push(db.prepare(`INSERT INTO client_delegated_shares VALUES ('share-other','public-other','workspace-other','d','t',NULL,'active',
      datetime('now','+1 day'),NULL,'2026-01-01 00:00:00')`));
    await db.batch(statements);
  }, 60_000);

  afterAll(async () => { await miniflare?.dispose(); });

  it("returns every one of 250 shares exactly once, newest first, in bounded pages", async () => {
    const seen: string[] = [];
    let cursor: string[] | null = null, pages = 0;
    do {
      const page: Awaited<ReturnType<typeof pageClientDelegatedShareRows>> = await pageClientDelegatedShareRows(db, workspaceId, { after: cursor });
      expect(page.rows.length).toBeLessThanOrEqual(CLIENT_DELEGATED_SHARE_PAGE_SIZE);
      seen.push(...page.rows.map(row => row.id));
      cursor = page.nextAfter; pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    expect(seen).not.toContain("share-other");
    const expected = Array.from({ length: TOTAL }, (_, i) => i)
      .sort((a, b) => Math.floor(b / 10) - Math.floor(a / 10) || a - b).map(i => `share-${pad(i)}`);
    expect(seen).toEqual(expected);
  });

  it("does not duplicate or skip shares when some are revoked between pages", async () => {
    const seen: string[] = [];
    const first = await pageClientDelegatedShareRows(db, workspaceId, { limit: 40 });
    seen.push(...first.rows.map(row => row.id));
    // Revoke one already-returned share, the next unread share, and one far ahead.
    const revoked = [first.rows[0]!.id, "share-0209", "share-0005"];
    await db.batch(revoked.map(id => db.prepare(
      "UPDATE client_delegated_shares SET status='revoked',revoked_at=datetime('now') WHERE id=?").bind(id)));
    let cursor = first.nextAfter;
    while (cursor) {
      const page: Awaited<ReturnType<typeof pageClientDelegatedShareRows>> = await pageClientDelegatedShareRows(db, workspaceId, { after: cursor, limit: 40 });
      seen.push(...page.rows.map(row => row.id));
      cursor = page.nextAfter;
    }
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    await db.prepare("UPDATE client_delegated_shares SET status='active',revoked_at=NULL").run();
  });

  it("pages 250 delegation targets exactly once and survives a delegation revoked mid-walk", async () => {
    const seen: string[] = [];
    let cursor: string[] | null = null, pages = 0;
    do {
      const page: Awaited<ReturnType<typeof pageClientDelegatedShareTargetRows>> = await pageClientDelegatedShareTargetRows(db, workspaceId, identityId, { after: cursor });
      expect(page.rows.length).toBeLessThanOrEqual(CLIENT_DELEGATED_SHARE_PAGE_SIZE);
      seen.push(...page.rows.map(row => `${row.target_id}/${row.delegation_id}`));
      cursor = page.nextAfter; pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);

    const walked: string[] = [];
    const first = await pageClientDelegatedShareTargetRows(db, workspaceId, identityId, { limit: 60 });
    walked.push(...first.rows.map(row => `${row.target_id}/${row.delegation_id}`));
    await db.prepare("UPDATE client_share_delegations SET status='revoked',revoked_at=datetime('now') WHERE id='delegation-4'").run();
    cursor = first.nextAfter;
    while (cursor) {
      const page: Awaited<ReturnType<typeof pageClientDelegatedShareTargetRows>> = await pageClientDelegatedShareTargetRows(db, workspaceId, identityId, { after: cursor, limit: 60 });
      walked.push(...page.rows.map(row => `${row.target_id}/${row.delegation_id}`));
      cursor = page.nextAfter;
    }
    expect(new Set(walked).size).toBe(walked.length);
    const stillActive = seen.filter(key => !key.endsWith("/delegation-4"));
    const revokedBeforeWalk = first.rows.filter(row => row.delegation_id === "delegation-4").length;
    expect(walked.filter(key => !key.endsWith("/delegation-4")).sort()).toEqual(stillActive.sort());
    expect(walked.length).toBe(stillActive.length + revokedBeforeWalk);
    await db.prepare("UPDATE client_share_delegations SET status='active',revoked_at=NULL WHERE id='delegation-4'").run();
  });

  it("a target label renamed mid-walk is neither skipped nor repeated", async () => {
    const first = await pageClientDelegatedShareTargetRows(db, workspaceId, identityId, { limit: 50 });
    const walked = first.rows.map(row => `${row.target_id}/${row.delegation_id}`);
    // Rename one already-read and one unread target to sort far away by label.
    await db.prepare("UPDATE client_share_folder_target_labels SET display_name='aaa' WHERE target_id=?").bind(first.rows[0]!.target_id).run();
    await db.prepare("UPDATE client_share_folder_target_labels SET display_name='zzz' WHERE target_id='target-0249'").run();
    let cursor = first.nextAfter;
    while (cursor) {
      const page: Awaited<ReturnType<typeof pageClientDelegatedShareTargetRows>> = await pageClientDelegatedShareTargetRows(db, workspaceId, identityId, { after: cursor, limit: 50 });
      walked.push(...page.rows.map(row => `${row.target_id}/${row.delegation_id}`));
      cursor = page.nextAfter;
    }
    expect(walked).toHaveLength(TOTAL);
    expect(new Set(walked).size).toBe(TOTAL);
  });

  it("caps the page size and seals cursors to one caller, workspace and list kind", async () => {
    const page = await pageClientDelegatedShareRows(db, workspaceId, { limit: 10_000 });
    expect(page.rows).toHaveLength(CLIENT_DELEGATED_SHARE_PAGE_SIZE);
    expect(page.nextAfter).toEqual([page.rows.at(-1)!.created_at, page.rows.at(-1)!.id]);
    const env = { DELIVERY_SESSION_SECRET: "s".repeat(32) };
    const principal = { issuer: "https://clients.example.test", subject: "paging-subject", email: "p@example.test" };
    const context = { env, principal, workspaceId, kind: "shares" as const };
    const deadline = Date.now() + 15 * 60_000;
    const cursor = await encodeClientDelegatedShareCursor(context, { keys: page.nextAfter!, page: 1, deadline });
    expect(cursor).not.toContain(page.rows.at(-1)!.id);
    expect(atob(cursor.slice(4).replace(/-/g, "+").replace(/_/g, "/"))).not.toContain(page.rows.at(-1)!.id);
    expect(await decodeClientDelegatedShareCursor(context, cursor)).toEqual({ keys: page.nextAfter, page: 1, deadline });
    expect(await decodeClientDelegatedShareCursor({ ...context, workspaceId: "workspace-other" }, cursor)).toBeNull();
    expect(await decodeClientDelegatedShareCursor({ ...context, kind: "targets" }, cursor)).toBeNull();
    expect(await decodeClientDelegatedShareCursor({ ...context, principal: { ...principal, subject: "someone-else" } }, cursor)).toBeNull();
    expect(await decodeClientDelegatedShareCursor({ ...context, env: { DELIVERY_SESSION_SECRET: "t".repeat(32) } }, cursor)).toBeNull();
    expect(clientDelegatedShareCursorExpired({ deadline }, deadline - 1)).toBe(false);
    expect(clientDelegatedShareCursorExpired({ deadline }, deadline)).toBe(true);
    expect(clientDelegatedShareCursorExpired({ deadline: Date.now() + 60 * 60_000 })).toBe(true);
    const last = await encodeClientDelegatedShareCursor(context, { keys: page.nextAfter!, page: CLIENT_DELEGATED_SHARE_CURSOR_MAX_PAGES, deadline });
    expect(await decodeClientDelegatedShareCursor(context, last)).toBeNull();
    expect(await decodeClientDelegatedShareCursor(context, "ds2.%%%")).toBeNull();
    expect(await decodeClientDelegatedShareCursor(context, `ds2.${"A".repeat(3000)}`)).toBeNull();
  });

  it("portal client follows nextCursor and still accepts responses without it", async () => {
    const calls: string[] = [];
    const pages: Record<string, { shares: { id: string }[]; nextCursor?: string | null }> = {
      "": { shares: [{ id: "a" }], nextCursor: "c1" },
      "?cursor=c1": { shares: [{ id: "b" }], nextCursor: null },
    };
    const request = (async (path: string) => {
      const query = path.slice(path.indexOf("/delegated-shares") + "/delegated-shares".length);
      calls.push(query);
      return pages[query];
    }) as unknown as PortalRequest;
    expect((await loadPortalDelegatedShares(workspaceId, request)).map(share => share.id)).toEqual(["a", "b"]);
    expect(calls).toEqual(["", "?cursor=c1"]);
    const legacy = (async () => ({ shares: [{ id: "only" }] })) as unknown as PortalRequest;
    expect((await loadPortalDelegatedShares(workspaceId, legacy)).map(share => share.id)).toEqual(["only"]);
    const endless = (async () => ({ shares: [], nextCursor: "again" })) as unknown as PortalRequest;
    await expect(loadPortalDelegatedShares(workspaceId, endless)).rejects.toThrow(/too many shares/);
    expect(DELEGATED_SHARE_LIST_PAGE_LIMIT).toBe(CLIENT_DELEGATED_SHARE_CURSOR_MAX_PAGES);
    // An expired walk (410 on a cursor page) restarts once from page one without duplicates.
    const restartCalls: string[] = [];
    let expireOnce = true;
    const restarting = (async (path: string) => {
      const query = path.slice(path.indexOf("/delegated-shares") + "/delegated-shares".length);
      restartCalls.push(query);
      if (query === "?cursor=c1" && expireOnce) { expireOnce = false; throw Object.assign(new Error("expired"), { status: 410 }); }
      return pages[query];
    }) as unknown as PortalRequest;
    expect((await loadPortalDelegatedShares(workspaceId, restarting)).map(share => share.id)).toEqual(["a", "b"]);
    expect(restartCalls).toEqual(["", "?cursor=c1", "", "?cursor=c1"]);
    const alwaysExpired = (async (path: string) => {
      const query = path.slice(path.indexOf("/delegated-shares") + "/delegated-shares".length);
      if (query) throw Object.assign(new Error("expired"), { status: 410 });
      return pages[query];
    }) as unknown as PortalRequest;
    await expect(loadPortalDelegatedShares(workspaceId, alwaysExpired)).rejects.toMatchObject({ status: 410 });
    // Targets arrive in id order across pages and are shown by label after the walk.
    const target = (folderTargetId: string, displayName: string) => ({ delegationId: "d", folderTargetId, displayName });
    const targetPages: Record<string, unknown> = {
      "": { targets: [target("t1", "beta"), target("t2", "Alpha")], nextCursor: "c1" },
      "?cursor=c1": { targets: [target("t3", "alpha"), target("t4", "Gamma")] },
    };
    const targetRequest = (async (path: string) => targetPages[path.slice(path.indexOf("/delegated-share-targets") + "/delegated-share-targets".length)]) as unknown as PortalRequest;
    expect((await loadPortalDelegatedShareTargets(workspaceId, targetRequest)).map(t => t.folderTargetId)).toEqual(["t2", "t3", "t1", "t4"]);
  });
});
