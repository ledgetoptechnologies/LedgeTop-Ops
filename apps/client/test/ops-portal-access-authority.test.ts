import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
import {recordOpsPortalAuthority,type OpsPortalAuthorityCommand} from "../src/worker/ops-portal-access-authority";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";

const base:OpsPortalAuthorityCommand={protocolVersion:1,operationId:"11111111-1111-4111-8111-111111111111",idempotencyKey:"intent-1",
  clientAuthorityId:"22222222-2222-4222-8222-222222222222",issuer:"https://access.example.test",subject:"exact-subject",
  desiredState:"active",expectedRevision:0};
describe("Operations portal access authority shadow receiver",()=>{
  let mf:Miniflare,db:D1Database,migration:string[];const env=(flag="true")=>({DELIVERY_DB:db,OPS_PORTAL_ACCESS_AUTHORITY_SHADOW_ENABLED:flag});
  beforeAll(async()=>{mf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",d1Databases:{DELIVERY_DB:"authority-shadow"}});
    db=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const sql=readFileSync(new URL("../migrations/0215_operations_portal_access_authority_shadow.sql",import.meta.url),"utf8");
    migration=splitD1MigrationStatements(sql);await db.batch(migration.map(value=>db.prepare(value)));
    await db.prepare("CREATE TABLE portal_v2_workspace_memberships(marker TEXT)").run();
    await db.prepare("CREATE TABLE portal_v2_entitlements(marker TEXT)").run();});
  afterAll(async()=>mf.dispose());
  beforeEach(async()=>{await db.exec(`DROP TABLE operations_portal_access_authority_receipts;
    DROP TABLE operations_portal_access_authority_audit; DROP TABLE operations_portal_access_authorities;`);
    await db.batch(migration.map(value=>db.prepare(value)));});

  it("is default-off and does not touch live authorization tables",async()=>{
    await expect(recordOpsPortalAuthority(env("false"),base)).resolves.toMatchObject({ok:false,code:"disabled"});
    expect(await db.prepare("SELECT count(*) n FROM operations_portal_access_authorities").first("n")).toBe(0);
  });
  it("records exact issuer/subject intent and idempotently replays it",async()=>{
    await expect(recordOpsPortalAuthority(env(),base)).resolves.toMatchObject({ok:true,status:"recorded",revision:1});
    await expect(recordOpsPortalAuthority(env(),base)).resolves.toMatchObject({ok:true,status:"duplicate",revision:1});
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements").first("n")).toBe(0);
  });
  it("rejects changed idempotency content, stale revisions, and unsafe objects",async()=>{
    await recordOpsPortalAuthority(env(),base);
    await expect(recordOpsPortalAuthority(env(),{...base,subject:"other"})).resolves.toMatchObject({ok:false,code:"conflict"});
    await expect(recordOpsPortalAuthority(env(),{...base,idempotencyKey:"intent-2",operationId:"33333333-3333-4333-8333-333333333333"}))
      .resolves.toMatchObject({ok:false,code:"conflict"});
    const cyclic:Record<string,unknown>={...base};cyclic.extra=cyclic;
    await expect(recordOpsPortalAuthority(env(),cyclic)).resolves.toMatchObject({ok:false,code:"invalid"});
    let accessed=false;const accessor=Object.defineProperty({...base},"subject",{enumerable:true,get(){accessed=true;return"subject";}});
    await expect(recordOpsPortalAuthority(env(),accessor)).resolves.toMatchObject({ok:false,code:"invalid"});expect(accessed).toBe(false);
    const hostile=new Proxy({...base},{getPrototypeOf(){throw new Error("hostile")}});
    await expect(recordOpsPortalAuthority(env(),hostile)).resolves.toMatchObject({ok:false,code:"invalid"});
  });
  it("writes a revisioned revocation tombstone and cannot resurrect it with a stale command",async()=>{
    await recordOpsPortalAuthority(env(),base);
    const revoke={...base,operationId:"33333333-3333-4333-8333-333333333333",idempotencyKey:"intent-2",desiredState:"revoked" as const,expectedRevision:1};
    await expect(recordOpsPortalAuthority(env(),revoke)).resolves.toMatchObject({ok:true,revision:2,state:"revoked"});
    await expect(recordOpsPortalAuthority(env(),{...base,operationId:"44444444-4444-4444-8444-444444444444",idempotencyKey:"intent-3",expectedRevision:1}))
      .resolves.toMatchObject({ok:false,code:"conflict"});
    expect(await db.prepare("SELECT state FROM operations_portal_access_authorities").first("state")).toBe("revoked");
  });
  it("permits exactly one concurrent expected revision",async()=>{
    const a={...base},b={...base,operationId:"33333333-3333-4333-8333-333333333333",idempotencyKey:"intent-2",desiredState:"revoked" as const};
    const results=await Promise.all([recordOpsPortalAuthority(env(),a),recordOpsPortalAuthority(env(),b)]);
    expect(results.filter(value=>value.ok).length).toBe(1);expect(results.filter(value=>!value.ok&&value.code==="conflict").length).toBe(1);
  });
  it("keeps receipt and audit evidence immutable",async()=>{
    await recordOpsPortalAuthority(env(),base);
    await expect(db.prepare("UPDATE operations_portal_access_authority_receipts SET result_revision=9").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM operations_portal_access_authority_audit").run()).rejects.toThrow(/immutable/);
  });
});
