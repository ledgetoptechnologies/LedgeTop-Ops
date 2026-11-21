import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { issueClientOnboardingMailWithHandoff, issueClientOnboardingWithHandoff, revealClientOnboardingSecret } from "../src/worker/client-onboarding-handoff";
import { handleClientOnboardingStaffHttp } from "../src/worker/client-onboarding-staff-http";
import { dispatchInviteMailOnce, recoverInviteMailAttempt } from "../src/worker/client-onboarding-invite-mail-dispatch";
const staffAuthentication = vi.hoisted(() => vi.fn());
vi.mock("../src/worker/native-staff-auth", async original => ({
  ...await original<typeof import("../src/worker/native-staff-auth")>(),
  authenticateNativeStaffWithAdmissionVersion:staffAuthentication,
}));

let runtime: Miniflare | undefined, db: D1Database;
const actor = { identity: { kind: "native" as const, staffId: "mail-test-staff",
  verifiedAccessSubject: "access|mail-test-staff", email: "staff@example.test", displayName: "Staff", profileVersion: 1 },
  verifiedUntil: "2099-01-01T00:00:00.000Z" };
const ring = { activeKeyId:"handoff", keys:{ handoff:"a".repeat(64) } };
const mailKeys = { activeEncryptionKeyId:"mail", activeFingerprintKeyId:"fingerprint",
  encryptionKeys:{mail:"b".repeat(64)}, fingerprintKeys:{fingerprint:"c".repeat(64)} };
const raw = (commandId: string) => ({ authenticatedNativeStaff:actor, request:{ commandId,
  expiresAt:new Date(Date.now()+3600_000).toISOString(), targetClientRecordId:null,
  scopes:[{ businessAreaId:"area:mail", divisionId:"division:mail" }] } });
const id = (n: number) => `70000000-0000-4000-8000-${n.toString(16).padStart(12,"0")}`;
const destination={sourceId:"project-alpha:secondary",businessAreaId:"area:mail",divisionId:"division:mail"};
const destinationBindingsJson=JSON.stringify([destination]);
const destinationRequest=(n:number) => {
  const value=raw(id(n));
  return {...value,request:{...value.request,destinationIntent:[destination]}};
};

describe("provisional onboarding email issuance against migrated D1", () => {
  beforeAll(async () => {
    staffAuthentication.mockResolvedValue({...actor,admissionVersion:1});
    runtime = new Miniflare({ modules:true, compatibilityDate:"2026-08-06", compatibilityFlags:["nodejs_compat"],
      script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(item => /^\d{4}_.+\.sql$/.test(item) && item.slice(0,4) <= "0218").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),"utf8")).map(sql=>db.prepare(sql)));
    for (const name of ["client-onboarding-destination-intent.provisional.sql","client-onboarding-target-proofs.provisional.sql","client-onboarding-invite-mail-outbox.provisional.sql"])
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),"utf8")).map(sql=>db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')")
        .bind(actor.identity.staffId,actor.identity.email,actor.identity.displayName,actor.identity.verifiedAccessSubject),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
        .bind(actor.identity.staffId,actor.identity.verifiedAccessSubject,actor.identity.staffId),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
        .bind(actor.identity.staffId,actor.identity.email,actor.identity.displayName),
      db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area:mail','Mail',1)"),
      db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division:mail','area:mail','Mail',1)"),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES('mail-profile',?,'directory.profile.edit','allow','global',1,?)")
        .bind(actor.identity.staffId,actor.identity.staffId),
    ]);
  },240_000);
  afterAll(async () => runtime?.dispose());

  it("commits exactly one encrypted intent, replays the same recipient and denies both reveal modes",async()=>{
    const request=raw(id(1));
    const result=await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@EXAMPLE.TEST",mailKeys);
    expect(result.mailStatus).toBe("queued");
    expect(Object.keys(result).sort()).toEqual(["expiresAt","invitationId","mailStatus","requestSha256","state"]);
    expect(JSON.stringify(result)).not.toContain("Client@");
    expect(await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys)).toEqual(result);
    await expect(issueClientOnboardingMailWithHandoff(db,request,ring,"Other@example.test",mailKeys)).rejects.toThrow();
    await expect(issueClientOnboardingWithHandoff(db,request,ring)).rejects.toThrow();
    await expect(revealClientOnboardingSecret(db,{authenticatedNativeStaff:actor,commandId:request.request.commandId},ring)).rejects.toThrow();
    for (const table of ["client_onboarding_reveal_consumptions","client_onboarding_reveal_audit"]) {
      await expect(db.prepare(`INSERT INTO ${table}(command_id,reveal_id,actor_staff_id,actor_access_subject,auth_verified_until)
        VALUES(?,?,?,?,?)`).bind(request.request.commandId,id(90),actor.identity.staffId,
          actor.identity.verifiedAccessSubject,actor.verifiedUntil).run()).rejects.toThrow(/mail-mode invitation cannot be revealed/);
    }
    expect(await db.prepare("SELECT count(*) n FROM client_onboarding_invite_mail_outbox WHERE command_id=?")
      .bind(request.request.commandId).first("n")).toBe(1);
  });
  it("does not convert an existing copy-only command to email",async()=>{
    const request=raw(id(2));await issueClientOnboardingWithHandoff(db,request,ring);
    await expect(issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys)).rejects.toThrow();
    const revealed=await revealClientOnboardingSecret(db,{authenticatedNativeStaff:actor,commandId:request.request.commandId},ring);
    expect(revealed.invitationSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.prepare("SELECT count(*) n FROM client_onboarding_invite_mail_outbox WHERE command_id=?")
      .bind(request.request.commandId).first("n")).toBe(0);
  });
  it("concurrent same-command requests converge on one email intent",async()=>{
    const request=raw(id(5));
    const [first,second]=await Promise.all([
      issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys),
      issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys),
    ]);
    expect(first).toEqual(second);
    expect(await db.prepare("SELECT count(*) n FROM client_onboarding_invite_mail_outbox WHERE command_id=?")
      .bind(request.request.commandId).first("n")).toBe(1);
  });
  it("replays the same address with retained keys after rotation and denies changed addresses or retired keys",async()=>{
    const request=raw(id(6));
    const original=await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
    const before=await db.prepare("SELECT * FROM client_onboarding_invite_mail_outbox WHERE command_id=?")
      .bind(request.request.commandId).first();
    const rotated={activeEncryptionKeyId:"mail2",activeFingerprintKeyId:"fingerprint2",
      encryptionKeys:{...mailKeys.encryptionKeys,mail2:"d".repeat(64)},fingerprintKeys:{...mailKeys.fingerprintKeys,fingerprint2:"e".repeat(64)}};
    expect(await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@EXAMPLE.TEST",rotated)).toEqual(original);
    expect(await db.prepare("SELECT * FROM client_onboarding_invite_mail_outbox WHERE command_id=?")
      .bind(request.request.commandId).first()).toEqual(before);
    await expect(issueClientOnboardingMailWithHandoff(db,request,ring,"Other@example.test",rotated)).rejects.toThrow();
    await expect(issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",{
      ...rotated,encryptionKeys:{mail2:"d".repeat(64)},fingerprintKeys:{fingerprint2:"e".repeat(64)},
    })).rejects.toThrow();
  });
  it("rejects schema drift before creating any invitation or outbox row",async()=>{
    const request=raw(id(3));
    await db.prepare("CREATE INDEX mail_unreviewed_index ON client_onboarding_invite_mail_outbox(state)").run();
    try {
      await expect(issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys)).rejects.toThrow();
      expect(await db.prepare("SELECT count(*) n FROM client_onboarding_issuance_commands WHERE command_id=?")
        .bind(request.request.commandId).first("n")).toBe(0);
      expect(await db.prepare("SELECT count(*) n FROM client_onboarding_invite_mail_outbox WHERE command_id=?")
        .bind(request.request.commandId).first("n")).toBe(0);
    } finally { await db.prepare("DROP INDEX mail_unreviewed_index").run(); }
  });
  it("rolls back when the installed schema changes between preflight and batch",async()=>{
    const request=raw(id(4));
    const session=db.withSession("first-primary"); let changed=false;
    const proxy=new Proxy(db,{get(target,property){
      if(property==="withSession")return () => new Proxy(session,{get(inner,key){
        if(key==="batch")return async (statements:D1PreparedStatement[])=>{
          if(!changed){changed=true;await db.prepare("CREATE INDEX mail_race_index ON client_onboarding_invite_mail_outbox(state)").run();}
          return inner.batch(statements);
        };
        const value=Reflect.get(inner,key,inner);return typeof value==="function"?value.bind(inner):value;
      }});
      const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
    }});
    try {
      await expect(issueClientOnboardingMailWithHandoff(proxy,request,ring,"Client@example.test",mailKeys)).rejects.toThrow();
      expect(changed).toBe(true);
      expect(await db.prepare("SELECT count(*) n FROM client_onboarding_issuance_commands WHERE command_id=?")
        .bind(request.request.commandId).first("n")).toBe(0);
    } finally { await db.prepare("DROP INDEX IF EXISTS mail_race_index").run(); }
  });
  it("keeps the email endpoint disabled without an explicit injected test flag",async()=>{
    const request=new Request("https://ops.example.test/api/client-onboarding/staff/create-email",{method:"POST"});
    const response=await handleClientOnboardingStaffHttp(request,{} as never);
    expect(response.status).toBe(404);
  });
  it("issues through authenticated staff HTTP and dispatches the same command once",async()=>{
    const origin="https://ops.ledgetopdroneservices.com";
    const binding={sourceId:"project-alpha:secondary",businessAreaId:"area:mail",divisionId:"division:mail"};
    const dependencies={environment:"production",expectedHost:"ops.ledgetopdroneservices.com",database:db,
      configuration:{enabled:true,issuer:"https://synthetic-team.cloudflareaccess.com",staffAudience:"synthetic-staff-audience",
        origin,csrfSecret:"synthetic-client-onboarding-secret-at-least-32-bytes"},
      handoffKeyringJson:JSON.stringify(ring),inviteDestinationBindingsJson:JSON.stringify([binding]),
      inviteMailIssuanceEnabled:"true",inviteMailKeysJson:JSON.stringify(mailKeys)};
    const req=(path:string,method:string,body?:unknown,csrf?:string)=>new Request(origin+path,{method,
      headers:{Origin:origin,"Sec-Fetch-Site":"same-origin","X-Native-Staff-Request":"1","Content-Type":"application/json",
        ...(csrf?{"X-CSRF-Token":csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const session=await handleClientOnboardingStaffHttp(req("/api/client-onboarding/staff/session","GET"),dependencies);
    expect(session.status).toBe(200);const token=(await session.json() as {csrfToken:string}).csrfToken;
    const scope=await handleClientOnboardingStaffHttp(req("/api/client-onboarding/staff/scope-choices","POST",{},token),dependencies);
    expect(scope.status).toBe(200);
    expect(await scope.json()).toMatchObject({destinationSourceIds:[binding.sourceId],inviteMailIssuanceAvailable:true});
    const body={commandId:id(7),expiresAt:new Date(Date.now()+3600_000).toISOString(),destinationSourceIds:[binding.sourceId],
      recipient:"client@example.test",recipientConfirmed:true};
    const path="/api/client-onboarding/staff/create-email";
    expect((await handleClientOnboardingStaffHttp(req(path,"POST",body),dependencies)).status).toBe(403);
    const response=await handleClientOnboardingStaffHttp(req(path,"POST",body,token),dependencies);
    expect(response.status).toBe(200);
    const result=await response.json() as Record<string,unknown>;
    const queued={invitationId:expect.stringMatching(/^[a-f0-9-]{36}$/),expiresAt:body.expiresAt,
      requestSha256:expect.stringMatching(/^[a-f0-9]{64}$/),state:"pending",mailStatus:"queued"};
    expect(result).toEqual(queued);
    const outbox=async()=>{
      const {results}=await db.prepare(`SELECT mail.invitation_id,mail.expires_at,mail.request_sha256,mail.state,
        command.destination_intent_json FROM client_onboarding_invite_mail_outbox mail
        JOIN client_onboarding_issuance_commands command ON command.command_id=mail.command_id
        WHERE mail.command_id=?`).bind(body.commandId).all();
      return results;
    };
    const outboxRow={invitation_id:result.invitationId,expires_at:body.expiresAt,request_sha256:result.requestSha256,
      destination_intent_json:JSON.stringify([binding])};
    expect(await outbox()).toEqual([{...outboxRow,state:"pending"}]);
    const send=vi.fn(async (_payload:{recipient:string;invitationId:string;invitationSecret:string;expiresAt:string})=>"accepted" as const);
    const options={mailKeyring:mailKeys,destinationBindingsJson:dependencies.inviteDestinationBindingsJson,send};
    expect(await dispatchInviteMailOnce(db,body.commandId,options)).toBe("sent");
    expect(send).toHaveBeenCalledExactlyOnceWith({recipient:body.recipient,invitationId:result.invitationId,
      invitationSecret:expect.stringMatching(/^[a-f0-9]{64}$/),expiresAt:body.expiresAt});
    const replay=await handleClientOnboardingStaffHttp(req(path,"POST",body,token),dependencies);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({...result,mailStatus:"sent"});
    expect(await dispatchInviteMailOnce(db,body.commandId,options)).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
    expect(await outbox()).toEqual([{...outboxRow,state:"sent"}]);
    const denied=await handleClientOnboardingStaffHttp(req(path,"POST",{...body,commandId:id(8),destinationSourceIds:["project-alpha:primary"]},token),dependencies);
    expect(denied.status).toBe(403);
  });

  it("permits only one transport invocation under concurrent dispatch and replay",async()=>{
    const request=destinationRequest(101);
    await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
    let release!:()=>void, started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}), entered=new Promise<void>(resolve=>{started=resolve;});
    const send=vi.fn(async (payload:{recipient:string;invitationId:string;invitationSecret:string;expiresAt:string})=>{
      expect(payload.recipient).toBe("Client@example.test");expect(payload.invitationSecret).toMatch(/^[a-f0-9]{64}$/);
      started();await gate;return "accepted" as const;
    });
    const options={mailKeyring:mailKeys,destinationBindingsJson,send};
    const first=dispatchInviteMailOnce(db,request.request.commandId,options);
    await entered;
    const second=await dispatchInviteMailOnce(db,request.request.commandId,options);
    expect(["not_ready","unknown"]).toContain(second);
    expect(send).toHaveBeenCalledTimes(1);
    release();expect(await first).toBe("sent");
    await dispatchInviteMailOnce(db,request.request.commandId,options);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not resend an uncertain transport response or thrown failure",async()=>{
    for (const n of [102,103]) {
      const request=destinationRequest(n);
      await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
      const send=vi.fn(async()=>{if(n===103)throw Error("private transport diagnostics");return "unknown" as const;});
      const options={mailKeyring:mailKeys,destinationBindingsJson,send};
      expect(await dispatchInviteMailOnce(db,request.request.commandId,options)).toBe("unknown");
      await dispatchInviteMailOnce(db,request.request.commandId,options);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await db.prepare("SELECT state FROM client_onboarding_invite_mail_outbox WHERE command_id=?")
        .bind(request.request.commandId).first("state")).toBe("unknown");
    }
  });

  it("returns unknown when the attempted batch commits but its reply is lost",async()=>{
    const request=destinationRequest(108);
    await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
    const session=db.withSession("first-primary"); let batches=0;
    const proxy=new Proxy(db,{get(target,property){
      if(property==="withSession")return () => new Proxy(session,{get(inner,key){
        if(key==="batch")return async (statements:D1PreparedStatement[])=>{
          const result=await inner.batch(statements);
          if(++batches===2)throw Error("synthetic lost D1 response");
          return result;
        };
        const value=Reflect.get(inner,key,inner);return typeof value==="function"?value.bind(inner):value;
      }});
      const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
    }});
    const send=vi.fn(async()=>"accepted" as const);
    expect(await dispatchInviteMailOnce(proxy,request.request.commandId,{mailKeyring:mailKeys,destinationBindingsJson,send})).toBe("unknown");
    expect(send).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT state FROM client_onboarding_invite_mail_outbox WHERE command_id=?")
      .bind(request.request.commandId).first("state")).toBe("attempted");
    await dispatchInviteMailOnce(db,request.request.commandId,{mailKeyring:mailKeys,destinationBindingsJson,send});
    expect(send).not.toHaveBeenCalled();
  });

  it("records a definitive rejection without automatically retrying",async()=>{
    const request=destinationRequest(107);
    await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
    const send=vi.fn(async()=>"rejected" as const), options={mailKeyring:mailKeys,destinationBindingsJson,send};
    expect(await dispatchInviteMailOnce(db,request.request.commandId,options)).toBe("failed");
    await dispatchInviteMailOnce(db,request.request.commandId,options);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("marks an expired attempt unknown and cannot accept a late settlement or retry",async()=>{
    const request=destinationRequest(104), command=request.request.commandId, lease=id(140), attempt=id(141);
    await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
    await db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state='claimed',version=version+1,
      lease_token=?,lease_until='2099-01-01T00:00:00.000Z' WHERE command_id=? AND state='pending'`).bind(lease,command).run();
    await db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state='attempted',version=version+1,
      lease_token=NULL,lease_until=NULL,attempted_at='2000-01-01T00:00:00.000Z',attempt_id=?
      WHERE command_id=? AND state='claimed' AND lease_token=?`).bind(attempt,command,lease).run();
    expect(await recoverInviteMailAttempt(db,command)).toBe("unknown");
    const late=await db.prepare(`UPDATE client_onboarding_invite_mail_outbox SET state='sent',version=version+1
      WHERE command_id=? AND state='attempted' AND attempt_id=?`).bind(command,attempt).run();
    expect(late.meta.changes).toBe(0);
    const send=vi.fn(async()=>"accepted" as const);
    await dispatchInviteMailOnce(db,command,{mailKeyring:mailKeys,destinationBindingsJson,send});
    expect(send).not.toHaveBeenCalled();
  });

  it("does not call transport when recovery changes state before the attempted acknowledgment arrives",async()=>{
    const request=destinationRequest(109), command=request.request.commandId;
    await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
    let batches=0, sessions=0, acknowledged=false, freshAfterAck=false, release!:()=>void, entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}), waiting=new Promise<void>(resolve=>{entered=resolve;});
    const proxy=new Proxy(db,{get(target,property){
      if(property==="withSession")return (constraint:string) => {
        expect(constraint).toBe("first-primary");
        const session=db.withSession("first-primary");sessions++;
        if(acknowledged && sessions>1)freshAfterAck=true;
        return new Proxy(session,{get(inner,key){
        if(key==="batch")return async (statements:D1PreparedStatement[])=>{
          const result=await inner.batch(statements);if(++batches===2){entered();await gate;acknowledged=true;}return result;
        };
        const value=Reflect.get(inner,key,inner);return typeof value==="function"?value.bind(inner):value;
      }});};
      const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
    }});
    const send=vi.fn(async()=>"accepted" as const);
    const pending=dispatchInviteMailOnce(proxy,command,{mailKeyring:mailKeys,destinationBindingsJson,send});
    await waiting;
    // Simulate the recovery transition while the successful D1 response is delayed.
    await db.prepare("UPDATE client_onboarding_invite_mail_outbox SET state='unknown',version=version+1 WHERE command_id=? AND state='attempted'").bind(command).run();
    expect(await recoverInviteMailAttempt(db,command)).toBe("unknown");
    release();expect(await pending).toBe("unknown");expect(send).not.toHaveBeenCalled();
    expect(freshAfterAck).toBe(true);expect(sessions).toBeGreaterThanOrEqual(2);
  });

  it("does not call transport when the invitation expires during a delayed attempted acknowledgment",async()=>{
    const request=destinationRequest(110), command=request.request.commandId;
    const expiry=Date.now()+6_000;request.request.expiresAt=new Date(expiry).toISOString();
    await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
    const session=db.withSession("first-primary");let batches=0, release!:()=>void, entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}), waiting=new Promise<void>(resolve=>{entered=resolve;});
    const proxy=new Proxy(db,{get(target,property){
      if(property==="withSession")return () => new Proxy(session,{get(inner,key){
        if(key==="batch")return async (statements:D1PreparedStatement[])=>{
          const result=await inner.batch(statements);if(++batches===2){entered();await gate;}return result;
        };
        const value=Reflect.get(inner,key,inner);return typeof value==="function"?value.bind(inner):value;
      }});
      const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
    }});
    const send=vi.fn(async()=>"accepted" as const);
    const pending=dispatchInviteMailOnce(proxy,command,{mailKeyring:mailKeys,destinationBindingsJson,send});
    await waiting;await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiry-Date.now()+100)));
    release();expect(await pending).toBe("unknown");expect(send).not.toHaveBeenCalled();
  },15_000);

  it("suppresses an unattempted invite after destination remapping",async()=>{
    const request=destinationRequest(105);
    await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
    const send=vi.fn(async()=>"accepted" as const);
    const wrong=JSON.stringify([{...destination,divisionId:"division:other"}]);
    expect(await dispatchInviteMailOnce(db,request.request.commandId,{mailKeyring:mailKeys,destinationBindingsJson:wrong,send})).toBe("suppressed");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not call transport after issuer admission is revoked",async()=>{
    const request=destinationRequest(106);
    await issueClientOnboardingMailWithHandoff(db,request,ring,"Client@example.test",mailKeys);
    const delayed=destinationRequest(111);
    await issueClientOnboardingMailWithHandoff(db,delayed,ring,"Client@example.test",mailKeys);
    const session=db.withSession("first-primary");let batches=0, release!:()=>void, entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}), waiting=new Promise<void>(resolve=>{entered=resolve;});
    const proxy=new Proxy(db,{get(target,property){
      if(property==="withSession")return () => new Proxy(session,{get(inner,key){
        if(key==="batch")return async (statements:D1PreparedStatement[])=>{
          const result=await inner.batch(statements);if(++batches===2){entered();await gate;}return result;
        };
        const value=Reflect.get(inner,key,inner);return typeof value==="function"?value.bind(inner):value;
      }});
      const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
    }});
    const delayedSend=vi.fn(async()=>"accepted" as const);
    const pending=dispatchInviteMailOnce(proxy,delayed.request.commandId,{mailKeyring:mailKeys,destinationBindingsJson,send:delayedSend});
    await waiting;
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?").bind(actor.identity.staffId).run();
    release();expect(await pending).toBe("unknown");expect(delayedSend).not.toHaveBeenCalled();
    const send=vi.fn(async()=>"accepted" as const);
    expect(["suppressed","not_ready"]).toContain(await dispatchInviteMailOnce(db,request.request.commandId,{mailKeyring:mailKeys,destinationBindingsJson,send}));
    expect(send).not.toHaveBeenCalled();
  });
});
