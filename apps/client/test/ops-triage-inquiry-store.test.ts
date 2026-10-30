import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { listOpsTriageInquiries, submitOpsTriageInquiry } from "../src/worker/client-portal/ops-triage-inquiries";
import type { Env } from "../src/worker/types";

const guardSql=vi.hoisted(()=>vi.fn(()=>({sql:"1=1",bindings:[]})));
vi.mock("../src/worker/client-portal/native-request-authority",()=>({
  nativeRequestMutationGuardSql:guardSql,
}));

describe("Ops triage inquiry durable ledger",()=>{
  let runtime:Miniflare,db:D1Database,env:Env;
  beforeAll(async()=>{
    runtime=new Miniflare({compatibilityDate:"2026-08-06",modules:true,
      script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:"ops-triage-inquiry-test"}});
    db=await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec("CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY);"+
      "CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL,entity_type TEXT,entity_id TEXT,details_json TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')));");
    const migration=readFileSync(new URL("../migrations/0242_client_ops_triage_inquiries.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));
    await db.prepare("INSERT INTO portal_v2_identities(id) VALUES(?)").bind("identity-one").run();
    env={DELIVERY_DB:db} as unknown as Env;
  });
  beforeEach(async()=>{
    guardSql.mockReturnValue({sql:"1=1",bindings:[]});
    await db.batch([
      db.prepare("DELETE FROM client_ops_triage_notification_outbox"),
      db.prepare("DELETE FROM client_ops_triage_inquiries"),
      db.prepare("DELETE FROM audit_log WHERE entity_type='client_ops_triage_inquiry'"),
    ]);
  });
  afterAll(async()=>{await runtime?.dispose();});

  it("atomically persists one typed inquiry, owner outbox event, and audit, then replays idempotently",async()=>{
    const proof={identityId:"identity-one",workspaceId:"workspace-drone",sourceId:"project-alpha:primary"} as any;
    const input={kind:"website" as const,title:"Website refresh",details:"Please help us update our website.",location:null,idempotencyKey:"inquiry-idempotency-0001"};
    const created=await submitOpsTriageInquiry(env,proof,input);
    expect(created.kind).toBe("created");
    const replay=await submitOpsTriageInquiry(env,proof,input);
    expect(replay.kind).toBe("replayed");
    if(created.kind!=="created"||replay.kind!=="replayed")throw new Error("unexpected result");
    expect(replay.inquiry.id).toBe(created.inquiry.id);
    expect(await db.prepare("SELECT COUNT(*) n FROM client_ops_triage_inquiries").first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM client_ops_triage_notification_outbox").first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='client.ops_triage_inquiry.submitted'").first("n")).toBe(1);
    expect(await db.prepare("SELECT recipient_kind FROM client_ops_triage_notification_outbox").first("recipient_kind")).toBe("staff_triage");
    expect(await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='client_accounts'").first("n")).toBe(0);
  });
  it("rejects a changed body under the same key and enforces kind/status constraints",async()=>{
    const proof={identityId:"identity-one",workspaceId:"workspace-drone",sourceId:"project-alpha:primary"} as any;
    const input={kind:"drone" as const,title:"Drone work",details:"Need a drone survey.",location:null,idempotencyKey:"inquiry-idempotency-0002"};
    expect((await submitOpsTriageInquiry(env,proof,input)).kind).toBe("created");
    expect((await submitOpsTriageInquiry(env,proof,{...input,kind:"other"})).kind).toBe("conflict");
    await expect(db.prepare("INSERT INTO client_ops_triage_inquiries(id,portal_identity_id,authorizing_workspace_id,"+
      "authorizing_source_id,kind,title,details,idempotency_key,request_fingerprint) VALUES('bad','identity-one','w','s',"+
      "'billing','Bad','Not an allowlisted kind','inquiry-idempotency-000x',?)").bind("a".repeat(64)).run()).rejects.toThrow();
  });
  it("creates no duplicate notice for a different inquiry and exposes newest history rows only for that identity",async()=>{
    const proof={identityId:"identity-one",workspaceId:"workspace-drone",sourceId:"project-alpha:primary"} as any;
    const one=await submitOpsTriageInquiry(env,proof,{kind:"other",title:"Other",details:"Details.",location:null,idempotencyKey:"inquiry-idempotency-0003"});
    expect(one.kind).toBe("created");
    expect(await db.prepare("SELECT COUNT(DISTINCT dedupe_key) n FROM client_ops_triage_notification_outbox").first("n")).toBe(1);
    await db.prepare("INSERT INTO portal_v2_identities(id) VALUES('identity-two')").run();
    const foreign={identityId:"identity-two",workspaceId:"other-workspace",sourceId:"project-alpha:other"} as any;
    await submitOpsTriageInquiry(env,foreign,{kind:"other",title:"Private",details:"Another identity.",location:null,idempotencyKey:"inquiry-idempotency-0004"});
    expect(await db.prepare("SELECT COUNT(*) n FROM client_ops_triage_inquiries WHERE portal_identity_id='identity-one'").first("n")).toBe(1);
    const ownRows=await listOpsTriageInquiries(env,proof,50);
    expect(ownRows).toHaveLength(1);
    expect(ownRows.some(row=>row.title==="Private")).toBe(false);
    expect(await listOpsTriageInquiries(env,foreign,50)).toMatchObject([{title:"Private",kind:"other"}]);
  });
  it("rejects a stale/revoked authority and reports storage failure as unavailable",async()=>{
    const proof={identityId:"identity-one",workspaceId:"workspace-drone",sourceId:"project-alpha:primary"} as any;
    guardSql.mockReturnValue({sql:"0=1",bindings:[]});
    expect(await submitOpsTriageInquiry(env,proof,{kind:"website",title:"Website",details:"Details",location:null,
      idempotencyKey:"inquiry-idempotency-revoked"})).toEqual({kind:"unauthorized"});
    const broken={DELIVERY_DB:{withSession:()=>({prepare:()=>{throw new Error("local D1 unavailable");}})}} as unknown as Env;
    await expect(submitOpsTriageInquiry(broken,proof,{kind:"website",title:"Website",details:"Details",location:null,
      idempotencyKey:"inquiry-idempotency-failure"})).rejects.toMatchObject({status:503});
  });
  it("serializes concurrent same-key submissions into one inquiry, outbox row, and audit",async()=>{
    const proof={identityId:"identity-one",workspaceId:"workspace-drone",sourceId:"project-alpha:primary"} as any;
    const input={kind:"drone" as const,title:"Concurrent inquiry",details:"One logical submission.",location:"North site",
      idempotencyKey:"inquiry-idempotency-concurrent"};
    const results=await Promise.all([submitOpsTriageInquiry(env,proof,input),submitOpsTriageInquiry(env,proof,input)]);
    expect(results.map(result=>result.kind).sort()).toEqual(["created","replayed"]);
    const ids=results.map(result=>result.kind==="created"||result.kind==="replayed"?result.inquiry.id:null);
    expect(new Set(ids).size).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM client_ops_triage_inquiries WHERE idempotency_key=?")
      .bind(input.idempotencyKey).first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM client_ops_triage_notification_outbox WHERE inquiry_id=?")
      .bind(ids[0]).first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_id=? AND action='client.ops_triage_inquiry.submitted'")
      .bind(ids[0]).first("n")).toBe(1);
  });
});
