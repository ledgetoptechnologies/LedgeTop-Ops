import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {dispatchNextClientPortalAuthorityIntent,enqueueClientPortalAuthorityIntent,type AuthorityEnv,type ClientPortalAuthorityBinding} from "../src/worker/client-portal-access-authority-outbox";
import {splitD1MigrationStatements} from "../../client/test/helpers/d1-migrations";

const intent={idempotencyKey:"ops-intent-1",clientAuthorityId:"22222222-2222-4222-8222-222222222222",
  issuer:"https://access.example.test",subject:"exact-subject",desiredState:"active" as const,expectedRevision:0,
  authorizedByStaffId:"11111111-1111-4111-8111-111111111111",authorizationVersion:7};
describe("Operations portal authority durable outbox",()=>{
  let mf:Miniflare,db:D1Database,migration:string[];
  beforeAll(async()=>{mf=new Miniflare({compatibilityDate:"2026-07-22",modules:true,script:"export default {}",d1Databases:{OPS_DB:"authority-outbox"}});
    db=await mf.getD1Database("OPS_DB") as unknown as D1Database;
    migration=splitD1MigrationStatements(readFileSync(new URL("../migrations/0142_client_portal_access_authority_outbox.sql",import.meta.url),"utf8"));
    await db.batch(migration.map(value=>db.prepare(value)));});afterAll(async()=>mf.dispose());
  beforeEach(async()=>{await db.exec(`DROP TABLE client_portal_access_authority_receipts; DROP TABLE client_portal_access_authority_outbox_audit;
    DROP TABLE client_portal_access_authority_outbox;`);await db.batch(migration.map(value=>db.prepare(value)));});

  it("persists source-neutral intent plus staff authorization evidence",async()=>{
    const {operationId}=await enqueueClientPortalAuthorityIntent({OPS_DB:db},intent);
    const row=await db.prepare("SELECT * FROM client_portal_access_authority_outbox WHERE operation_id=?").bind(operationId).first<Record<string,unknown>>();
    expect(row).toMatchObject({client_authority_id:intent.clientAuthorityId,issuer:intent.issuer,subject:intent.subject,
      authorized_by_staff_id:intent.authorizedByStaffId,authorization_version:7,state:"pending"});
    expect(JSON.stringify(row)).not.toMatch(/email|project-alpha|credential/i);
    await expect(db.prepare("UPDATE client_portal_access_authority_outbox SET subject='changed'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM client_portal_access_authority_outbox_audit").run()).rejects.toThrow(/immutable/);
  });
  it("is default-off before invoking Client",async()=>{
    await enqueueClientPortalAuthorityIntent({OPS_DB:db},intent);const recordAuthority=vi.fn();
    await expect(dispatchNextClientPortalAuthorityIntent({OPS_DB:db,CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED:"false",
      CLIENT_PORTAL_ACCESS_AUTHORITY:{recordAuthority}} as AuthorityEnv)).resolves.toEqual({status:"disabled"});expect(recordAuthority).not.toHaveBeenCalled();
  });
  it("sends only the bounded authority DTO and durably acknowledges its receipt",async()=>{
    const {operationId}=await enqueueClientPortalAuthorityIntent({OPS_DB:db},intent);const calls:unknown[]=[];
    const binding:ClientPortalAuthorityBinding={recordAuthority:async command=>{calls.push(command);return{ok:true,protocolVersion:1,status:"recorded",revision:1,state:"active"};}};
    await expect(dispatchNextClientPortalAuthorityIntent({OPS_DB:db,CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED:"true",CLIENT_PORTAL_ACCESS_AUTHORITY:binding} as AuthorityEnv))
      .resolves.toEqual({status:"acknowledged",operationId});
    expect(calls[0]).toEqual(expect.objectContaining({protocolVersion:1,clientAuthorityId:intent.clientAuthorityId,issuer:intent.issuer,subject:intent.subject}));
    expect(calls[0]).not.toHaveProperty("authorizedByStaffId");
    expect(await db.prepare("SELECT state FROM client_portal_access_authority_outbox").first("state")).toBe("acknowledged");
    expect(await db.prepare("SELECT count(*) n FROM client_portal_access_authority_receipts").first("n")).toBe(1);
  });
  it("retries transport failures and dead-letters nonretryable conflicts",async()=>{
    await enqueueClientPortalAuthorityIntent({OPS_DB:db},intent);
    const retry:ClientPortalAuthorityBinding={recordAuthority:async()=>{throw new Error("transport")}};
    await expect(dispatchNextClientPortalAuthorityIntent({OPS_DB:db,CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED:"true",CLIENT_PORTAL_ACCESS_AUTHORITY:retry} as AuthorityEnv))
      .resolves.toMatchObject({status:"retry",code:"temporarily-unavailable"});
    await db.prepare("UPDATE client_portal_access_authority_outbox SET next_attempt_at=datetime('now')").run();
    const conflict:ClientPortalAuthorityBinding={recordAuthority:async()=>({ok:false,protocolVersion:1,code:"conflict",retryable:false})};
    await expect(dispatchNextClientPortalAuthorityIntent({OPS_DB:db,CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED:"true",CLIENT_PORTAL_ACCESS_AUTHORITY:conflict} as AuthorityEnv))
      .resolves.toMatchObject({status:"dead",code:"conflict"});
  });
  it("leases a due row so concurrent dispatchers call Client once",async()=>{
    await enqueueClientPortalAuthorityIntent({OPS_DB:db},intent);let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const recordAuthority=vi.fn(async()=>{await gate;return{ok:true as const,protocolVersion:1 as const,status:"recorded" as const,revision:1,state:"active" as const};});
    const env={OPS_DB:db,CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED:"true",CLIENT_PORTAL_ACCESS_AUTHORITY:{recordAuthority}} as AuthorityEnv;
    const first=dispatchNextClientPortalAuthorityIntent(env),second=dispatchNextClientPortalAuthorityIntent(env);release();
    const results=await Promise.all([first,second]);expect(results.map(value=>value.status).sort()).toEqual(["acknowledged","idle"]);
    expect(recordAuthority).toHaveBeenCalledTimes(1);
  });
  it("does not acknowledge or write a receipt after losing its exact lease",async()=>{
    const {operationId}=await enqueueClientPortalAuthorityIntent({OPS_DB:db},intent);
    const binding:ClientPortalAuthorityBinding={recordAuthority:async()=>{
      await db.prepare(`UPDATE client_portal_access_authority_outbox SET claim_token=?,claim_until=datetime('now','+2 minutes')
        WHERE operation_id=? AND state='dispatching'`).bind("replacement-lease",operationId).run();
      return{ok:true,protocolVersion:1,status:"recorded",revision:1,state:"active"};
    }};
    await expect(dispatchNextClientPortalAuthorityIntent({OPS_DB:db,CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED:"true",CLIENT_PORTAL_ACCESS_AUTHORITY:binding} as AuthorityEnv))
      .resolves.toEqual({status:"retry",operationId,code:"lease-lost"});
    expect(await db.prepare("SELECT count(*) n FROM client_portal_access_authority_receipts").first("n")).toBe(0);
    expect(await db.prepare("SELECT state FROM client_portal_access_authority_outbox").first("state")).toBe("dispatching");
  });
  it("rejects a malformed or mismatched success receipt instead of acknowledging",async()=>{
    await enqueueClientPortalAuthorityIntent({OPS_DB:db},intent);
    const binding={recordAuthority:async()=>({ok:true,protocolVersion:1,status:"duplicate",revision:99,state:"active"})} as unknown as ClientPortalAuthorityBinding;
    await expect(dispatchNextClientPortalAuthorityIntent({OPS_DB:db,CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED:"true",CLIENT_PORTAL_ACCESS_AUTHORITY:binding} as AuthorityEnv))
      .resolves.toMatchObject({status:"retry",code:"temporarily-unavailable"});
  });
  it("releases the lease to retry when Client returns no receipt",async()=>{
    await enqueueClientPortalAuthorityIntent({OPS_DB:db},intent);
    const binding:ClientPortalAuthorityBinding={recordAuthority:async()=>undefined};
    await expect(dispatchNextClientPortalAuthorityIntent({OPS_DB:db,CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED:"true",CLIENT_PORTAL_ACCESS_AUTHORITY:binding} as AuthorityEnv))
      .resolves.toMatchObject({status:"retry",code:"temporarily-unavailable"});
    expect(await db.prepare("SELECT state FROM client_portal_access_authority_outbox").first("state")).toBe("retry");
    expect(await db.prepare("SELECT claim_token FROM client_portal_access_authority_outbox").first("claim_token")).toBeNull();
  });
});
