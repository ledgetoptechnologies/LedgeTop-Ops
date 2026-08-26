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
});
