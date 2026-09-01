import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { gunzipSync } from "node:zlib";
import { runRetention } from "../src/worker/retention";
import type { Env } from "../src/worker/types";

describe("source-qualified projection receipt retention",()=>{
  let runtime:Miniflare;
  let db:D1Database;
  beforeEach(async()=>{
    runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["DB"]});
    db=await runtime.getD1Database("DB") as D1Database;
    for(const sql of [
      "CREATE TABLE integration_event_receipts(projection_source_id TEXT,event_id TEXT,received_at TEXT,payload_hash TEXT,PRIMARY KEY(projection_source_id,event_id))",
      "CREATE TABLE share_events(id TEXT,created_at TEXT)","CREATE TABLE audit_log(id TEXT,created_at TEXT)",
      "CREATE TABLE audit_events(id TEXT,created_at TEXT)","CREATE TABLE sync_runs(id TEXT,started_at TEXT)",
      "CREATE TABLE idempotency_keys(expires_at TEXT)","CREATE TABLE delivery_reconciliation_alerts(created_at TEXT)",
      "CREATE TABLE bulk_download_quota(updated_at TEXT)","CREATE TABLE bulk_download_jobs(status TEXT,updated_at TEXT)",
      "CREATE TABLE public_rate_limits(expires_at TEXT)","CREATE TABLE file_request_contributors(id TEXT,created_at TEXT)",
      "CREATE TABLE file_request_uploads(contributor_id TEXT,status TEXT)","CREATE TABLE file_requests(revoked_at TEXT,revoked_reason TEXT,updated_at TEXT,expires_at TEXT)",
      `CREATE TABLE portal_authenticated_content_events(
        recorded_sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL,
        resource_fingerprint TEXT NOT NULL,action TEXT NOT NULL,occurred_at TEXT NOT NULL)`,
      "CREATE TABLE portal_authenticated_content_retention_control(singleton INTEGER PRIMARY KEY,delete_enabled INTEGER NOT NULL DEFAULT 0,delete_before TEXT)",
      "INSERT INTO portal_authenticated_content_retention_control(singleton,delete_enabled,delete_before) VALUES(1,0,NULL)",
      `CREATE TRIGGER portal_authenticated_content_events_retention_delete_guard
        BEFORE DELETE ON portal_authenticated_content_events
        WHEN COALESCE((SELECT delete_enabled FROM portal_authenticated_content_retention_control WHERE singleton=1),0)<>1
          OR (SELECT delete_before FROM portal_authenticated_content_retention_control WHERE singleton=1) IS NULL
          OR datetime(OLD.occurred_at)>=datetime((SELECT delete_before FROM portal_authenticated_content_retention_control WHERE singleton=1))
        BEGIN SELECT RAISE(ABORT,'authenticated content event deletion requires an expired retention cutoff'); END`,
    ])await db.prepare(sql).run();
  });
  afterEach(async()=>runtime.dispose());

  it("archives and deletes only old exact source/event pairs, preserving a recent colliding receipt",async()=>{
    await db.batch([
      db.prepare("INSERT INTO integration_event_receipts VALUES ('project-alpha:primary','same-event',datetime('now','-40 days'),'old-primary')"),
      db.prepare("INSERT INTO integration_event_receipts VALUES ('project-alpha:secondary','same-event',datetime('now'),'recent-secondary')"),
      db.prepare("INSERT INTO integration_event_receipts VALUES ('project-alpha:secondary','old-secondary',datetime('now','-40 days'),'old-secondary')"),
    ]);
    const archived:Record<string,unknown>[][]=[];
    const put=vi.fn(async(_key:string,stream:ReadableStream)=>{
      const compressed=await new Response(stream).arrayBuffer();
      archived.push(gunzipSync(Buffer.from(compressed)).toString("utf8").trim().split("\n").map(line=>JSON.parse(line) as Record<string,unknown>));
    });
    expect(await runRetention({OPS_DB:db,DELIVERY_DB:db,DATA_BUCKET:{put}} as unknown as Env)).toBe(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(archived[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({projection_source_id:"project-alpha:primary",event_id:"same-event",payload_hash:"old-primary"}),
      expect.objectContaining({projection_source_id:"project-alpha:secondary",event_id:"old-secondary"}),
    ]));
    expect((await db.prepare("SELECT projection_source_id,event_id,payload_hash FROM integration_event_receipts").all()).results).toEqual([
      {projection_source_id:"project-alpha:secondary",event_id:"same-event",payload_hash:"recent-secondary"},
    ]);
    expect(await runRetention({OPS_DB:db,DELIVERY_DB:db,DATA_BUCKET:{put}} as unknown as Env)).toBe(0);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("does not delete receipts if their archive has not been stored",async()=>{
    await db.prepare("INSERT INTO integration_event_receipts VALUES ('project-alpha:primary','old',datetime('now','-40 days'),'preserve')").run();
    const put=vi.fn(async(_key:string,stream:ReadableStream)=>{await new Response(stream).arrayBuffer();throw new Error("archive-unavailable");});
    await expect(runRetention({OPS_DB:db,DELIVERY_DB:db,DATA_BUCKET:{put}} as unknown as Env)).rejects.toThrow("archive-unavailable");
    expect(await db.prepare("SELECT payload_hash FROM integration_event_receipts WHERE event_id='old'").first("payload_hash")).toBe("preserve");
  });

  it("archives authenticated content events in bounded batches before exact-id deletion and closes the gate",async()=>{
    await db.prepare(`WITH RECURSIVE sequence(value) AS (
      SELECT 0 UNION ALL SELECT value+1 FROM sequence WHERE value<1002
    ) INSERT INTO portal_authenticated_content_events(id,source_id,resource_fingerprint,action,occurred_at)
      SELECT 'old-'||printf('%04d',value),CASE value%2 WHEN 0 THEN 'project-alpha:primary' ELSE 'project-alpha:secondary' END,
        'resource-'||printf('%04d',value),'file.download_requested',datetime('now','-366 days') FROM sequence`).run();
    await db.prepare(`INSERT INTO portal_authenticated_content_events(id,source_id,resource_fingerprint,action,occurred_at)
      VALUES('recent','project-alpha:secondary','resource-recent','file.preview_requested',datetime('now'))`).run();
    const archived:Record<string,unknown>[][]=[];
    const keys:string[]=[];
    const metadata:Array<Record<string,string>|undefined>=[];
    const put=vi.fn(async(key:string,stream:ReadableStream,options?:{customMetadata?:Record<string,string>})=>{
      keys.push(key);metadata.push(options?.customMetadata);
      const compressed=await new Response(stream).arrayBuffer();
      archived.push(gunzipSync(Buffer.from(compressed)).toString("utf8").trim().split("\n")
        .map(line=>JSON.parse(line) as Record<string,unknown>));
    });

    expect(await runRetention({OPS_DB:db,DELIVERY_DB:db,DATA_BUCKET:{put}} as unknown as Env)).toBe(1000);
    expect(await db.prepare("SELECT count(*) n FROM portal_authenticated_content_events WHERE id LIKE 'old-%'").first("n")).toBe(3);
    expect(await db.prepare("SELECT delete_enabled FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_enabled")).toBe(0);
    expect(await db.prepare("SELECT delete_before FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_before")).toBeNull();
    expect(await runRetention({OPS_DB:db,DELIVERY_DB:db,DATA_BUCKET:{put}} as unknown as Env)).toBe(3);
    expect(await runRetention({OPS_DB:db,DELIVERY_DB:db,DATA_BUCKET:{put}} as unknown as Env)).toBe(0);

    expect(put).toHaveBeenCalledTimes(2);
    expect(archived.map(batch=>batch.length)).toEqual([1000,3]);
    expect(new Set(archived.flat().map(row=>row.id)).size).toBe(1003);
    expect(keys.every(key=>key.includes("/delivery/portal_authenticated_content_events/"))).toBe(true);
    expect(metadata).toEqual([
      {table:"portal_authenticated_content_events",rows:"1000",retentionDays:"365"},
      {table:"portal_authenticated_content_events",rows:"3",retentionDays:"365"},
    ]);
    expect((await db.prepare("SELECT id FROM portal_authenticated_content_events").all()).results).toEqual([{id:"recent"}]);
    await expect(db.prepare("DELETE FROM portal_authenticated_content_events WHERE id='recent'").run())
      .rejects.toThrow("authenticated content event deletion requires an expired retention cutoff");
    await expect(db.batch([
      db.prepare("UPDATE portal_authenticated_content_retention_control SET delete_enabled=1,delete_before=? WHERE singleton=1")
        .bind(new Date(Date.now()-365*24*60*60*1_000).toISOString()),
      db.prepare("DELETE FROM portal_authenticated_content_events WHERE id='recent'"),
      db.prepare("UPDATE portal_authenticated_content_retention_control SET delete_enabled=0,delete_before=NULL WHERE singleton=1"),
    ])).rejects.toThrow("authenticated content event deletion requires an expired retention cutoff");
    expect(await db.prepare("SELECT id FROM portal_authenticated_content_events WHERE id='recent'").first("id")).toBe("recent");
    expect(await db.prepare("SELECT delete_enabled FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_enabled")).toBe(0);
    expect(await db.prepare("SELECT delete_before FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_before")).toBeNull();
  },30_000);

  it("keeps authenticated content events and the delete gate closed when archive upload fails",async()=>{
    await db.prepare(`INSERT INTO portal_authenticated_content_events(id,source_id,resource_fingerprint,action,occurred_at)
      VALUES('archive-failure','project-alpha:primary','resource-failure','file.preview_requested',datetime('now','-366 days'))`).run();
    const put=vi.fn(async(_key:string,stream:ReadableStream)=>{
      await new Response(stream).arrayBuffer();
      throw new Error("content-archive-unavailable");
    });
    await expect(runRetention({OPS_DB:db,DELIVERY_DB:db,DATA_BUCKET:{put}} as unknown as Env))
      .rejects.toThrow("content-archive-unavailable");
    expect(await db.prepare("SELECT id FROM portal_authenticated_content_events").first("id")).toBe("archive-failure");
    expect(await db.prepare("SELECT delete_enabled FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_enabled")).toBe(0);
    expect(await db.prepare("SELECT delete_before FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_before")).toBeNull();
  });

  it("rejects a partial guarded-retention schema before archiving or deleting",async()=>{
    await db.prepare("DROP TRIGGER portal_authenticated_content_events_retention_delete_guard").run();
    await db.prepare(`INSERT INTO portal_authenticated_content_events(id,source_id,resource_fingerprint,action,occurred_at)
      VALUES('partial-schema','project-alpha:primary','resource-partial','file.preview_requested',datetime('now','-366 days'))`).run();
    const put=vi.fn();
    await expect(runRetention({OPS_DB:db,DELIVERY_DB:db,DATA_BUCKET:{put}} as unknown as Env))
      .rejects.toThrow("Retention schema for portal_authenticated_content_events is incomplete");
    expect(put).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT id FROM portal_authenticated_content_events").first("id")).toBe("partial-schema");
    expect(await db.prepare("SELECT delete_enabled FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_enabled")).toBe(0);
    expect(await db.prepare("SELECT delete_before FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_before")).toBeNull();
  });

  it("rolls back the retention gate and all exact-id deletes when a guarded batch fails",async()=>{
    await db.batch([
      db.prepare(`INSERT INTO portal_authenticated_content_events(id,source_id,resource_fingerprint,action,occurred_at)
        VALUES('delete-one','project-alpha:primary','resource-one','file.download_requested',datetime('now','-366 days'))`),
      db.prepare(`INSERT INTO portal_authenticated_content_events(id,source_id,resource_fingerprint,action,occurred_at)
        VALUES('delete-rejected','project-alpha:primary','resource-two','file.download_requested',datetime('now','-366 days'))`),
    ]);
    await db.prepare(`CREATE TRIGGER reject_one_authenticated_content_delete BEFORE DELETE ON portal_authenticated_content_events
      WHEN OLD.id='delete-rejected' BEGIN SELECT RAISE(ABORT,'injected retention delete failure'); END`).run();
    const put=vi.fn(async(_key:string,stream:ReadableStream)=>{await new Response(stream).arrayBuffer();});
    await expect(runRetention({OPS_DB:db,DELIVERY_DB:db,DATA_BUCKET:{put}} as unknown as Env))
      .rejects.toThrow("injected retention delete failure");
    expect((await db.prepare("SELECT id FROM portal_authenticated_content_events ORDER BY id").all()).results)
      .toEqual([{id:"delete-one"},{id:"delete-rejected"}]);
    expect(await db.prepare("SELECT delete_enabled FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_enabled")).toBe(0);
    expect(await db.prepare("SELECT delete_before FROM portal_authenticated_content_retention_control WHERE singleton=1").first("delete_before")).toBeNull();
  });
});
