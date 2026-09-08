import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { handleRequest, reconcileScheduledAccess } from "../src/index";
import type { Env, ProjectionEvent } from "../src/types";
import { registerProjectAlphaConnector, reviseProjectAlphaConnector, setProjectAlphaConnectorState, type ProjectAlphaConnectorEnvironment } from "../../operations/src/worker/project-alpha-connectors";
import contractFixture from "../../../packages/shared/fixtures/project-alpha-ops-sync-portal-projection-v1.json";

const primary="project-alpha:primary", secondary="project-alpha:secondary";
let runtime: Miniflare, db: D1Database, environment: Env & Pick<ProjectAlphaConnectorEnvironment,"PROJECT_ALPHA_BASE_URL"|"PROJECT_ALPHA_API_KEY">;
let accessKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
const keys = new Map<string,CryptoKeyPair>();
let legacyAttestation: { status: number; algorithms: string[] };
const accessIssuer=(source:string)=>source===primary?"https://primary.cloudflareaccess.com":"https://secondary.cloudflareaccess.com";
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");

function event(entityId=crypto.randomUUID()): ProjectionEvent {
  const now=new Date().toISOString();
  return {event_id:crypto.randomUUID(),event_type:"projection.changed",occurred_at:now,schema_version:1,application_key:"ltds_ops",
    projection:{entity_type:"business_unit",entity_id:entityId,action:"upsert",source_updated_at:now,data:{name:"Business unit",code:`unit-${entityId}`}}};
}
function portalEvent(kind:"portal"|"catalog"|"service_assignments"="portal") {
  // Portal outbox delivery identities existed before the UUID-only Ops event
  // contract, so exercise a valid legacy-safe identity on every route.
  const now=new Date().toISOString(),eventId=`portal-${crypto.randomUUID()}`;
  return {event_id:eventId,event_type:"portal.projection" as const,occurred_at:now,schema_version:1 as const,
    application_key:"ltds_ops",projection_kind:kind,projection:{deliveryId:eventId,fixture:true}};
}
function deliveryEvent(deliveryId=`delivery-${crypto.randomUUID()}`,label:string|null="Johnson Road"){
  const now=new Date().toISOString();
  return{event_id:`delivery.intent:provision:${deliveryId}`,event_type:"delivery.intent" as const,occurred_at:now,schema_version:1 as const,
    application_key:"ltds_ops",intent_kind:"provision" as const,intent:{schemaVersion:1 as const,applicationKey:"ltds_ops",deliveryId,occurredAt:now,
      scope:{type:"project" as const,publicId:"project-public"},audience:{type:"principal" as const,publicId:"principal-public"},
      accessMode:"portal" as const,expiresAt:null,label,notify:true as const}};
}
type ContractFixtureName=keyof typeof contractFixture.valid;
function contractEvent(name:ContractFixtureName){
  return JSON.parse(contractFixture.valid[name].body) as ReturnType<typeof portalEvent>;
}
async function sha256(value:string):Promise<string>{
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
async function request(source:string,payload:unknown,options:{key?:string;commonName?:string;subject?:string;type?:string;issuer?:string;audience?:string;legacy?:boolean;hmac?:boolean}={}):Promise<Request> {
  const body=JSON.stringify(payload),timestamp=new Date().toISOString();
  const token=await new SignJWT({type:options.type??"app",common_name:options.commonName??`subject-${source}`}).setProtectedHeader({alg:"RS256",kid:"access-key"})
    .setIssuer(options.issuer??accessIssuer(source)).setAudience(options.audience??`aud-${source}`)
    .setSubject(options.subject??"").setIssuedAt().setExpirationTime("5m").sign(accessKeys.privateKey);
  const signed=new TextEncoder().encode(`${timestamp}.${body}`);
  const signature=b64(new Uint8Array(await crypto.subtle.sign("Ed25519",keys.get(options.key??source)!.privateKey,signed)));
  const headers:Record<string,string>={"Content-Type":"application/json","Cf-Access-Jwt-Assertion":token,"X-PA-Timestamp":timestamp,
    "X-PA-Event-ID":(payload as {event_id:string}).event_id,"X-PA-Signature-Ed25519":`ed25519=${signature}`};
  if(options.hmac){
    delete headers["X-PA-Signature-Ed25519"];
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(environment.PROJECT_ALPHA_WEBHOOK_HMAC_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const hash=new Uint8Array(await crypto.subtle.sign("HMAC",key,signed));
    headers["X-PA-Signature"]=`sha256=${[...hash].map(value=>value.toString(16).padStart(2,"0")).join("")}`;
  }
  return new Request(`https://ops-sync.example${options.legacy?"/v1/project-alpha/events":`/v1/project-alpha/sources/${encodeURIComponent(source)}/events`}`,
    {method:"POST",headers,body});
}
async function suspended(source=secondary):Promise<void>{
  await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id=?").bind(source).run();
}

/** Real statements and real D1 transactions, with one deterministic interleave. */
function beforeBatch(match:string,change:()=>Promise<void>):D1Database {
  const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>();
  const queries=new WeakMap<D1PreparedStatement,string>();
  let fired=false;
  const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>{
    const proxy=new Proxy(statement,{get(target,property){
      if(property==="bind")return (...values:unknown[])=>wrap(target.bind(...values),sql);
      const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
    }});
    originals.set(proxy,statement);queries.set(proxy,sql);return proxy;
  };
  return new Proxy(db,{get(target,property){
    if(property==="prepare")return (sql:string)=>wrap(target.prepare(sql),sql);
    if(property==="batch")return async<T>(statements:D1PreparedStatement[])=>{
      if(!fired&&statements.some(statement=>queries.get(statement)?.includes(match))){fired=true;await change();}
      return target.batch<T>(statements.map(statement=>originals.get(statement)??statement));
    };
    const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
  }});
}

// Sequential real-D1 projections can exceed five seconds and must finish before the next case.
describe("authenticated connector business ingress",{timeout:30_000},()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
    db=await runtime.getD1Database("OPS_DB") as D1Database;
    const path=resolve(import.meta.dirname,"../../operations/migrations");
    // This suite imports the current Operations connector writer, so its D1
    // fixture must use the current Operations schema as well. Pinning the
    // fixture to the connector's original migration hides later connector
    // invariants and makes valid registrations fail on missing columns.
    for(const name of (await readdir(path)).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort()){
      const statements=unstable_splitSqlQuery((await readFile(resolve(path,name),"utf8")).replace(/\r\n/g,"\n"))
        .map(sql=>sql.trim()).filter(sql=>sql&&!/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(sql));
      if(statements.length)await db.batch(statements.map(sql=>db.prepare(sql)));
    }
    accessKeys=await generateKeyPair("RS256");publicJwk=await exportJWK(accessKeys.publicKey);publicJwk.kid="access-key";publicJwk.alg="RS256";
    const sets:Record<string,{snapshotApiKey:string;eventCurrent:{keyId:string;algorithm:"ed25519";value:string};eventPrevious?:{keyId:string;algorithm:"ed25519";value:string}}>={};
    for(const source of [primary,secondary,"previous-secondary"]){
      const pair=await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]);keys.set(source,pair);
      sets[source===primary?"primary":source===secondary?"secondary":"previous"]={snapshotApiKey:"fixture-snapshot-secret",eventCurrent:{keyId:`key-${source.replace(/:/g,"-")}`,algorithm:"ed25519",value:b64(new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey)))}};
    }
    sets.secondary!.eventPrevious=sets.previous!.eventCurrent;delete sets.previous;
    environment={OPS_DB:db,DELIVERY_DB:db,EXPECTED_HOST:"ops-sync.example",TEAM_DOMAIN:accessIssuer(primary),CF_ACCESS_AUD:`aud-${primary}`,
      APPLICATION_KEY:"ltds_ops",CF_ACCOUNT_ID:"fixture-account",CF_ACCESS_GROUP_ID:"fixture-group",CF_ACCESS_GROUP_NAME:"Fixture group",
      PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED:"false",
      CF_ACCESS_GROUP_API_TOKEN:"fixture-token",PROJECT_ALPHA_ALLOW_LEGACY_HMAC:"true",PROJECT_ALPHA_WEBHOOK_HMAC_SECRET:"fixture-primary-hmac-secret-at-least-32-bytes",
      PROJECT_ALPHA_CONNECTOR_CREDENTIALS:JSON.stringify({version:1,sets}),PROJECT_ALPHA_BASE_URL:"https://primary.example",PROJECT_ALPHA_API_KEY:"fixture-snapshot-secret",
      PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY:sets.primary!.eventCurrent.value};
    // Exercise the deployed split before enrollment: Ops Sync accepts the
    // scalar-primary event and records only non-secret signing identities in
    // the shared database. Operations can then stage the matching connector
    // without receiving a second copy of either webhook credential.
    const legacyResponse=await handleRequest(await request(primary,event(),{legacy:true,hmac:true}),environment,async()=>({}));
    const attested=(await db.prepare("SELECT algorithm FROM pa_connector_signing_keys WHERE source_id=? ORDER BY algorithm")
      .bind(primary).all<{algorithm:string}>()).results;
    legacyAttestation={status:legacyResponse.status,algorithms:attested.map(row=>row.algorithm)};
    for(const source of [primary,secondary]){
      const suffix=source===primary?"primary":"secondary";
      const connectorEnvironment=source===primary?{...environment,PROJECT_ALPHA_WEBHOOK_HMAC_SECRET:undefined,
        PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY:undefined,PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY:undefined}:environment;
      await registerProjectAlphaConnector(connectorEnvironment,{sourceId:source,producerBindingId:`producer-${suffix}`,snapshotOrigin:`https://${suffix}.example`,
        applicationKey:"ltds_ops",profile:source===primary?"primary_legacy":"business_data",displayName:suffix,
        revision:{credentialRef:suffix,snapshotBasePath:"/",accessIssuer:accessIssuer(source),accessAudience:`aud-${source}`,accessSubject:`subject-${source}`}},"fixture-admin");
      await setProjectAlphaConnectorState(environment,source,{expectedVersion:1,state:"active"},"fixture-admin");
    }
  },60_000);
  beforeEach(async()=>{
    for(const source of [primary,secondary])await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=? AND state='suspended'").bind(source).run();
    vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);
      if([primary,secondary].some(source=>url===`${accessIssuer(source)}/cdn-cgi/access/certs`))return Response.json({keys:[publicJwk]});
      throw new Error(`Unexpected fixture network request: ${url}`);
    }));
    environment.CLIENT_PORTAL_PROJECTION_INGRESS=undefined;
    environment.OPERATIONS_DELIVERY_INTENT_INGRESS=undefined;
  });
  afterEach(()=>vi.unstubAllGlobals());
  afterAll(async()=>{await runtime?.dispose();});

  it("attests a valid legacy HMAC event before Operations stages the primary connector",()=>{
    expect(legacyAttestation).toEqual({status:200,algorithms:["ed25519","hmac-sha256"]});
  });

  it("uses only the event-verifier envelope and never materializes deployment sources",async()=>{
    const rows=(await db.prepare(`SELECT connector.*,revision.credential_ref,revision.access_issuer,revision.access_audience,
      revision.access_subject,revision.current_key_id,revision.current_key_fingerprint,revision.previous_key_id,
      revision.previous_key_fingerprint FROM pa_connectors connector JOIN pa_connector_revisions revision
      ON revision.source_id=connector.source_id AND revision.revision=connector.active_revision ORDER BY connector.source_id`)
      .all<Record<string, string | number | null>>()).results;
    const manifest={version:1,sources:rows.map(row=>({sourceId:row.source_id,producerBindingId:row.producer_binding_id,
      displayName:row.display_name,snapshotOrigin:row.snapshot_origin,applicationKey:row.application_key,profile:row.profile,
      enabled:true,readVisible:true,revision:{credentialRef:row.credential_ref,snapshotBasePath:row.snapshot_base_path,
        accessIssuer:row.access_issuer,accessAudience:row.access_audience,accessSubject:row.access_subject,
        eventCurrent:{keyId:row.current_key_id,algorithm:"ed25519",fingerprint:row.current_key_fingerprint},
        ...(row.previous_key_id?{eventPrevious:{keyId:row.previous_key_id,algorithm:"ed25519",fingerprint:row.previous_key_fingerprint}}:{})}}))};
    const publicValue=async(source:string)=>b64(new Uint8Array(await crypto.subtle.exportKey("raw",keys.get(source)!.publicKey)));
    const eventCredentials={version:1,sets:{
      primary:{eventCurrent:{keyId:`key-${primary.replace(/:/g,"-")}`,algorithm:"ed25519",value:await publicValue(primary)}},
      secondary:{eventCurrent:{keyId:`key-${secondary.replace(/:/g,"-")}`,algorithm:"ed25519",value:await publicValue(secondary)},
        eventPrevious:{keyId:"key-previous-secondary",algorithm:"ed25519",value:await publicValue("previous-secondary")}},
    }};
    const scoped={...environment,PROJECT_ALPHA_CONNECTOR_CREDENTIALS:undefined,
      PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED:"true",PROJECT_ALPHA_CONNECTOR_SOURCES:JSON.stringify(manifest),
      PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS:JSON.stringify(eventCredentials)};
    const auditsBefore=await db.prepare("SELECT count(*) total FROM pa_connector_audit").first<number>("total");
    expect((await handleRequest(await request(secondary,event()),scoped)).status).toBe(200);
    expect(await db.prepare("SELECT count(*) total FROM pa_connector_audit").first<number>("total")).toBe(auditsBefore);
  });

  it("isolates equal external event and entity IDs, retries, versions, and health by authenticated source",async()=>{
    const item=event();
    expect((await handleRequest(await request(primary,item),environment)).status).toBe(200);
    expect((await handleRequest(await request(secondary,item),environment)).status).toBe(200);
    const retry=await handleRequest(await request(secondary,item),environment);
    expect(await retry.json()).toMatchObject({status:"duplicate"});
    const rows=(await db.prepare("SELECT projection_source_id,id FROM pa_business_units WHERE payload_json=? ORDER BY projection_source_id").bind(JSON.stringify(item.projection.data)).all<{projection_source_id:string;id:string}>()).results;
    expect(rows).toHaveLength(2);expect(rows[0]?.id).toBe(item.projection.entity_id);expect(rows[1]?.id).not.toBe(item.projection.entity_id);
    expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts WHERE event_id=? AND status='completed'").bind(item.event_id).first("total")).toBe(2);
    expect(await db.prepare("SELECT count(*) total FROM pa_projection_entity_versions WHERE event_id=?").bind(item.event_id).first("total")).toBe(2);
    expect(await db.prepare("SELECT count(*) total FROM integration_reconciliation WHERE integration='project-alpha' AND last_event_at=?").bind(item.occurred_at).first("total")).toBe(2);
  });
  it("accepts the previous Ed25519 key only for its enrolled source",async()=>{
    expect((await handleRequest(await request(secondary,event(),{key:"previous-secondary"}),environment)).status).toBe(200);
    expect((await handleRequest(await request(primary,event(),{key:"previous-secondary"}),environment)).status).toBe(401);
  });
  it("accepts a registered source's exact service-token common_name", async () => {
    const item = event();
    expect((await handleRequest(await request(secondary, item, { commonName: `subject-${secondary}` }), environment)).status).toBe(200);
    expect(await db.prepare("SELECT status FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?")
      .bind(secondary, item.event_id).first("status")).toBe("completed");
  });
  it.each([{key:primary},{commonName:`subject-${primary}`},{issuer:accessIssuer(primary)},{audience:`aud-${primary}`},{hmac:true}])("rejects a cross-source credential or HMAC without reserving a receipt: %j",async(options)=>{
    const item=event();const response=await handleRequest(await request(secondary,item,options),environment);
    expect(response.status).toBe(401);
    expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts WHERE event_id=?").bind(item.event_id).first("total")).toBe(0);
  });
  it.each([
    ["wrong common_name", { commonName: `subject-${primary}` }],
    ["empty sub without the exact common_name", { commonName: "another-service-token" }],
    ["identity-user claim", { type: "user", subject: "human-subject" }],
    ["non-service app claim", { subject: "human-subject" }],
  ])("requires the exact service-token identity for a registered source: %s", async (_label, options) => {
    const item = event();
    const response = await handleRequest(await request(secondary, item, options), environment);
    expect(response.status).toBe(401);
    expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts WHERE event_id=?").bind(item.event_id).first("total")).toBe(0);
  });
  it("keeps the legacy path bound to the enrolled primary even when secondary credentials are valid",async()=>{
    const item=event();expect((await handleRequest(await request(secondary,item,{legacy:true}),environment)).status).toBe(401);
    expect((await handleRequest(await request(primary,item,{legacy:true}),environment)).status).toBe(200);
  });
  it.each([
    ["portal", "portal_contact_upsert"],
    ["catalog", "catalog_upsert"],
    ["service_assignments", "service_assignments_page"],
  ] as const)("routes the byte-pinned signed %s projection through the private Client binding",async(kind,fixtureName)=>{
    const item=contractEvent(fixtureName),ingestProjectAlphaPortalProjection=vi.fn(async()=>({ok:true as const,protocolVersion:1 as const,status:"completed" as const}));
    expect(item.projection_kind).toBe(kind);
    expect(JSON.stringify(item)).toBe(contractFixture.valid[fixtureName].body);
    expect(await sha256(contractFixture.valid[fixtureName].body)).toBe(contractFixture.valid[fixtureName].sha256);
    environment.CLIENT_PORTAL_PROJECTION_INGRESS={ingestProjectAlphaPortalProjection};
    const response=await handleRequest(await request(primary,item,{legacy:true}),environment);
    expect(response.status).toBe(200);
    expect(ingestProjectAlphaPortalProjection).toHaveBeenCalledWith({protocolVersion:1,sourceId:primary,
      applicationKey:"ltds_ops",deliveryId:item.event_id,projectionKind:kind,body:JSON.stringify(item.projection)});
    expect(await db.prepare("SELECT status FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?")
      .bind(primary,item.event_id).first("status")).toBe("completed");
  });
  it("preserves contact upsert/tombstone order and rejects a conflicting replay",async()=>{
    const calls:string[]=[],ingestProjectAlphaPortalProjection=vi.fn(async(input:{body:string})=>{
      calls.push((JSON.parse(input.body) as {event:{action:string}}).event.action);
      return {ok:true as const,protocolVersion:1 as const,status:"completed" as const};
    });
    environment.CLIENT_PORTAL_PROJECTION_INGRESS={ingestProjectAlphaPortalProjection};
    const upsert=contractEvent("portal_contact_upsert"),tombstone=contractEvent("portal_contact_tombstone");
    await db.prepare("DELETE FROM integration_event_receipts WHERE projection_source_id=? AND event_id IN (?,?)")
      .bind(primary,upsert.event_id,tombstone.event_id).run();
    expect((await handleRequest(await request(primary,upsert,{legacy:true}),environment)).status).toBe(200);
    expect((await handleRequest(await request(primary,tombstone,{legacy:true}),environment)).status).toBe(200);
    expect(calls).toEqual(["upsert","tombstone"]);
    expect(await (await handleRequest(await request(primary,tombstone,{legacy:true}),environment)).json())
      .toMatchObject({status:"duplicate"});
    const conflict={...tombstone,occurred_at:"2026-09-02T18:02:01.000Z"};
    expect((await handleRequest(await request(primary,conflict,{legacy:true}),environment)).status).toBe(409);
    expect(ingestProjectAlphaPortalProjection).toHaveBeenCalledTimes(2);
  });
  it("rejects portal projection application/source claims outside the authenticated envelope",async()=>{
    const base=contractEvent("portal_contact_upsert");
    for(const payload of [
      {...base,event_id:"contract-wrong-application",application_key:"another_app",
        projection:{...base.projection,deliveryId:"contract-wrong-application"}},
      {...base,event_id:"contract-source-claim",source_id:primary,
        projection:{...base.projection,deliveryId:"contract-source-claim"}},
    ]){
      const response=await handleRequest(await request(primary,payload,{legacy:true}),environment);
      expect(response.status).toBe(422);
      expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?")
        .bind(primary,payload.event_id).first("total")).toBe(0);
    }
  });
  it("routes a non-staff source portal projection only under its authenticated source identity",async()=>{
    const item=portalEvent(),ingestProjectAlphaPortalProjection=vi.fn(async()=>({ok:true as const,protocolVersion:1 as const,status:"completed" as const}));
    environment.CLIENT_PORTAL_PROJECTION_INGRESS={ingestProjectAlphaPortalProjection};
    expect((await handleRequest(await request(secondary,item),environment)).status).toBe(200);
    expect(ingestProjectAlphaPortalProjection).toHaveBeenCalledWith(expect.objectContaining({sourceId:secondary,deliveryId:item.event_id}));
    expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts WHERE projection_source_id=? AND event_id=? AND status='completed'")
      .bind(secondary,item.event_id).first("total")).toBe(1);
  });
  it("routes delivery intents through Operations, recovers exact replays, and rejects conflicts",async()=>{
    const item=deliveryEvent(),ingestProjectAlphaDeliveryIntent=vi.fn(async()=>({ok:true as const,protocolVersion:1 as const,result:{receiptId:"receipt-one",status:"accepted"}}));
    environment.OPERATIONS_DELIVERY_INTENT_INGRESS={ingestProjectAlphaDeliveryIntent};
    expect((await handleRequest(await request(primary,item,{legacy:true}),environment)).status).toBe(200);
    expect(await (await handleRequest(await request(primary,item,{legacy:true}),environment)).json()).toMatchObject({status:"duplicate",result:{receiptId:"receipt-one"}});
    expect(ingestProjectAlphaDeliveryIntent).toHaveBeenCalledTimes(2);
    expect(ingestProjectAlphaDeliveryIntent).toHaveBeenLastCalledWith({protocolVersion:1,sourceId:primary,applicationKey:"ltds_ops",deliveryId:item.intent.deliveryId,
      intentKind:"provision",body:JSON.stringify(item.intent),connectorProof:{revision:expect.any(Number),version:expect.any(Number)}});
    expect((await handleRequest(await request(primary,{...item,intent:{...item.intent,label:"Changed"}},{legacy:true}),environment)).status).toBe(409);
  });
  it("keeps a portal receipt pending when Client is unavailable, then completes the exact retry",async()=>{
    const item=portalEvent(),ingestProjectAlphaPortalProjection=vi.fn()
      .mockRejectedValueOnce(new Error("rpc unavailable"))
      .mockResolvedValueOnce({ok:true as const,protocolVersion:1 as const,status:"completed" as const});
    environment.CLIENT_PORTAL_PROJECTION_INGRESS={ingestProjectAlphaPortalProjection};
    expect((await handleRequest(await request(primary,item,{legacy:true}),environment)).status).toBe(503);
    expect(await db.prepare("SELECT status FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?")
      .bind(primary,item.event_id).first("status")).toBe("pending");
    expect((await handleRequest(await request(primary,item,{legacy:true}),environment)).status).toBe(200);
    expect(ingestProjectAlphaPortalProjection).toHaveBeenCalledTimes(2);
    expect(await db.prepare("SELECT status FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?")
      .bind(primary,item.event_id).first("status")).toBe("completed");
  });
  it("rejects another application or body source selector before any source write",async()=>{
    for(const payload of [{...event(),application_key:"another_app"},{...event(),sourceId:primary}]){
      expect((await handleRequest(await request(secondary,payload),environment)).status).toBe(422);
      expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts WHERE event_id=?").bind(payload.event_id).first("total")).toBe(0);
    }
  });
  it("does not permit a business connector to change staff entitlements or Access",async()=>{
    const item={event_id:crypto.randomUUID(),event_type:"application_entitlement.changed",occurred_at:new Date().toISOString(),schema_version:1,
      user:{id:"77",email:"another@example.com",display_name:"Another",active:true},entitlement:{application_key:"ltds_ops",enabled:true,role_key:"role-admin",business_unit_ids:[]}};
    expect((await handleRequest(await request(secondary,item),environment)).status).toBe(403);
    expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts WHERE event_id=?").bind(item.event_id).first("total")).toBe(0);
    expect(await db.prepare("SELECT count(*) total FROM staff_users WHERE email='another@example.com'").first("total")).toBe(0);
  });
  it("accepts a secondary client without invoking the primary Delivery bridge",async()=>{
    const item=event();item.projection={...item.projection,entity_type:"client",data:{name:"Secondary customer"}};
    // This fixture deliberately has no Delivery tables. A bridge call would fail.
    expect((await handleRequest(await request(secondary,item),environment)).status).toBe(200);
    expect(await db.prepare("SELECT count(*) total FROM pa_clients WHERE projection_source_id=? AND name='Secondary customer'").bind(secondary).first("total")).toBe(1);
  });
  it("records a secondary processing failure without modifying the primary receipt with the same ID",async()=>{
    const item=event();expect((await handleRequest(await request(primary,item),environment)).status).toBe(200);
    const broken={...item,projection:{...item.projection,entity_type:"project_assignment",data:{user_id:"77"}}};
    expect((await handleRequest(await request(secondary,broken),environment)).status).toBe(422);
    expect(await db.prepare("SELECT status,last_error FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?").bind(primary,item.event_id).first()).toEqual({status:"completed",last_error:null});
    expect(await db.prepare("SELECT status,last_error FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?").bind(secondary,item.event_id).first()).toEqual({status:"pending",last_error:"projection-data-project_id-required"});
  });
  it("cannot process business events when the primary enrollment is suspended",async()=>{
    await suspended(primary);const item=event();
    expect((await handleRequest(await request(secondary,item),environment)).status).toBe(409);
    expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts WHERE event_id=?").bind(item.event_id).first("total")).toBe(0);
  });
  it.each(["INSERT INTO integration_event_receipts","INSERT INTO pa_projection_record_ids","INSERT INTO pa_business_units"]) ("fences suspension inside the actual write transaction: %s",async(sql)=>{
    const item=event();const guarded={...environment,OPS_DB:beforeBatch(sql,()=>suspended())};
    const response=await handleRequest(await request(secondary,item),guarded);
    expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"project-alpha-connector-changed"});
    expect(await db.prepare("SELECT count(*) total FROM pa_business_units WHERE projection_source_id=? AND payload_json=?").bind(secondary,JSON.stringify(item.projection.data)).first("total")).toBe(0);
    expect(await db.prepare("SELECT count(*) total FROM pa_projection_entity_versions WHERE projection_source_id=? AND event_id=?").bind(secondary,item.event_id).first("total")).toBe(0);
  });
  it("fences completion without marking a pending accepted projection completed after suspension",async()=>{
    const item=event();const guarded={...environment,OPS_DB:beforeBatch("SET status='completed'",()=>suspended())};
    expect((await handleRequest(await request(secondary,item),guarded)).status).toBe(409);
    expect(await db.prepare("SELECT status FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?").bind(secondary,item.event_id).first("status")).toBe("pending");
  });
  it("fences a changed active revision without requiring the connector to be suspended",async()=>{
    const item=event();
    const guarded={...environment,OPS_DB:beforeBatch("INSERT INTO pa_business_units",async()=>{
      const version=await db.prepare("SELECT version FROM pa_connectors WHERE source_id=?").bind(secondary).first<number>("version");
      await reviseProjectAlphaConnector(environment,secondary,version!,{credentialRef:"secondary",snapshotBasePath:"/",accessIssuer:accessIssuer(secondary),
        accessAudience:`aud-${secondary}`,accessSubject:`subject-${secondary}`},"fixture-admin");
    })};
    expect((await handleRequest(await request(secondary,item),guarded)).status).toBe(409);
    expect(await db.prepare("SELECT count(*) total FROM pa_business_units WHERE projection_source_id=? AND payload_json=?").bind(secondary,JSON.stringify(item.projection.data)).first("total")).toBe(0);
  });
  it("does not use a suspended primary enrollment for scheduled Access synchronization",async()=>{
    await suspended(primary);
    await expect(reconcileScheduledAccess(environment)).rejects.toThrow("Connector configuration changed");
    expect(fetch).not.toHaveBeenCalled();
  });
});
