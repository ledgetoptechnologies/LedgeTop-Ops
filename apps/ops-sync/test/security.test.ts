import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { parseEntitlementEvent, parseIntegrationEvent } from "../src/schema";
import { MAX_BODY_BYTES, readWebhookBody, requireAccessSubject, validateRequestTimestamp, verifyAccessAssertion, verifyWebhookHmac, verifyWebhookSignature } from "../src/security";

const baseEvent = {
  event_id: "0d80755c-2945-4d7e-94cd-288d341d501d",
  event_type: "application_entitlement.changed",
  occurred_at: "2026-07-17T20:00:00.000000Z",
  schema_version: 1,
  user: { id: 42, email: "User@Example.COM", display_name: "Example User", active: true },
  entitlement: { application_key: "ltds_ops", enabled: true, role_key: "role-operator", business_unit_ids: [30,30,20] },
};

async function paHmacHeader(body:Uint8Array,timestamp:string,secret:string):Promise<string>{
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}.${new TextDecoder().decode(body)}`)));
  return `sha256=${[...signature].map((byte)=>byte.toString(16).padStart(2,"0")).join("")}`;
}

describe("Project Alpha webhook validation", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("normalizes and validates the versioned event contract", () => {
    const event = parseEntitlementEvent(baseEvent,"ltds_ops");
    expect(event.user.id).toBe("42");
    expect(event.user.email).toBe("user@example.com");
    expect(event.entitlement.business_unit_ids).toEqual(["20","30"]);
    expect(parseEntitlementEvent(baseEvent," LTDS_OPS ").entitlement.application_key).toBe("ltds_ops");
    expect(parseEntitlementEvent({...baseEvent,user:{...baseEvent.user,display_name:"A".repeat(255)}},"ltds_ops").user.display_name).toHaveLength(255);
    expect(() => parseEntitlementEvent({...baseEvent,schema_version:2},"ltds_ops")).toThrow();
    expect(() => parseEntitlementEvent(baseEvent,"another_app")).toThrow("application-key-mismatch");
    expect(parseEntitlementEvent({...baseEvent,entitlement:{...baseEvent.entitlement,role_key:"role-admin"}},"ltds_ops").entitlement.role_key).toBe("role-admin");
  });

  it("enforces the five minute timestamp window", () => {
    const now = Date.parse("2026-07-17T20:00:00Z");
    expect(validateRequestTimestamp("2026-07-17T19:55:01Z",now)).toBeTruthy();
    expect(() => validateRequestTimestamp("2026-07-17T19:54:59Z",now)).toThrow("timestamp-invalid");
  });

  it("requires the exact verified Access subject, never an unrelated identity claim", () => {
    expect(() => requireAccessSubject({sub:"connector-b"},"connector-b")).not.toThrow();
    expect(() => requireAccessSubject({sub:"connector-a",email:"connector-b"},"connector-b")).toThrow("access-subject-invalid");
    expect(() => requireAccessSubject(undefined,"connector-b")).toThrow("access-subject-invalid");
  });

  it("bounds streamed unknown-length webhook bodies and cancels oversized input", async () => {
    const cancel=vi.fn();
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(MAX_BODY_BYTES));controller.enqueue(new Uint8Array(1));},cancel});
    const request=new Request("https://example.test",{method:"POST",body,duplex:"half"} as RequestInit);
    await expect(readWebhookBody(request)).rejects.toThrow("payload-too-large");
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(readWebhookBody(new Request("https://example.test",{method:"POST",body:"{}"}))).resolves.toEqual(new TextEncoder().encode("{}"));
  });

  it("does not wait indefinitely for an unfinished webhook body", async () => {
    const cancel=vi.fn();
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([123]));},cancel});
    await expect(readWebhookBody(new Request("https://example.test",{method:"POST",body,duplex:"half"} as RequestInit),10)).rejects.toThrow("payload-read-timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts versioned projection changes only for the configured application", () => {
    const projection={event_id:"8db76af1-d6c8-41b3-a717-6517a8f50508",event_type:"projection.changed",occurred_at:"2026-07-17T20:00:00.000000Z",schema_version:1,application_key:"community_operations",projection:{entity_type:"task_assignment",entity_id:"110:42",action:"upsert",source_updated_at:"2026-07-17T19:59:00.000000Z",data:{task_id:110,user_id:42}}};
    expect(parseIntegrationEvent(projection,"community_operations").event_type).toBe("projection.changed");
    expect(()=>parseIntegrationEvent(projection,"another_application")).toThrow("application-key-mismatch");
    expect(()=>parseIntegrationEvent({...projection,projection:{...projection.projection,entity_type:"password"}},"community_operations")).toThrow();
    expect(parseIntegrationEvent({...projection,projection:{...projection.projection,entity_type:"client",entity_id:"70"}},"community_operations").event_type).toBe("projection.changed");
  });

  it("accepts only explicit, data-free schema-v2 tombstones", () => {
    const tombstone={event_id:"8db76af1-d6c8-41b3-a717-6517a8f50509",event_type:"projection.changed",
      occurred_at:"2026-08-30T19:00:00.000Z",schema_version:2,application_key:"community_operations",
      projection:{entity_type:"client",entity_id:"70",action:"tombstone",
        source_updated_at:"2026-08-30T18:59:00.000Z",data:{}}};
    const parsed=parseIntegrationEvent(tombstone,"community_operations");
    expect(parsed.event_type).toBe("projection.changed");
    if(parsed.event_type==="projection.changed"){
      expect(parsed.schema_version).toBe(2);
      expect(parsed.projection).toEqual(tombstone.projection);
    }
    expect(()=>parseIntegrationEvent({...tombstone,projection:{...tombstone.projection,action:"upsert"}},"community_operations")).toThrow();
    expect(()=>parseIntegrationEvent({...tombstone,projection:{...tombstone.projection,data:{name:"Private Client"}}},"community_operations")).toThrow();
    expect(()=>parseIntegrationEvent({...tombstone,projection:{...tombstone.projection,data:{email:"private@example.test"}}},"community_operations")).toThrow();
    expect(()=>parseIntegrationEvent({...tombstone,schema_version:1},"community_operations")).toThrow();
    expect(()=>parseIntegrationEvent({...tombstone,application_key:"other"},"community_operations")).toThrow("application-key-mismatch");
  });

  it("verifies the timestamp and raw body HMAC", async () => {
    const body = new TextEncoder().encode(JSON.stringify(baseEvent));
    const timestamp = "2026-07-17T20:00:00Z";
    const secret = "a-long-random-test-secret";
    const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}.${new TextDecoder().decode(body)}`)));
    const hex = [...signature].map((byte) => byte.toString(16).padStart(2,"0")).join("");
    await expect(verifyWebhookHmac(body,timestamp,`sha256=${hex}`,secret)).resolves.toBeUndefined();
    await expect(verifyWebhookHmac(body,timestamp,`sha256=${"0".repeat(64)}`,secret)).rejects.toThrow("signature-invalid");
  });

  it("accepts the exact PA HMAC-only contract when compatibility is enabled",async()=>{
    const body=new TextEncoder().encode(JSON.stringify(baseEvent));
    const timestamp="2026-07-17T20:00:00Z",secret="a-long-random-test-secret";
    const header=await paHmacHeader(body,timestamp,secret);
    await expect(verifyWebhookSignature(body,timestamp,null,"future-ed25519-public-key",undefined,header,secret,true)).resolves.toBe("hmac-legacy");
    await expect(verifyWebhookSignature(body,timestamp,null,undefined,undefined,header,secret,false)).rejects.toThrow("signature-required");
  });

  it("retains previous primary HMAC compatibility during an enrolled key rotation",async()=>{
    const body=new TextEncoder().encode("{}"),timestamp=new Date().toISOString();
    const header=await paHmacHeader(body,timestamp,"previous-primary-key");
    await expect(verifyWebhookSignature(body,timestamp,null,undefined,undefined,header,"current-primary-key",true,"previous-primary-key")).resolves.toBe("hmac-legacy");
    await expect(verifyWebhookSignature(body,timestamp,"ed25519=invalid",undefined,undefined,header,"current-primary-key",true,"previous-primary-key")).rejects.toThrow("signature-invalid");
    await expect(verifyWebhookSignature(body,timestamp,"ed25519=a",undefined,undefined,header,"current-primary-key",true)).rejects.toThrow("signature-invalid");
  });

  it("enables the audited HMAC-only contract in the production Worker configuration",async()=>{
    const config=JSON.parse(await readFile(resolve(import.meta.dirname,"../wrangler.jsonc"),"utf8")) as {vars?:Record<string,string>};
    expect(config.vars?.PROJECT_ALPHA_ALLOW_LEGACY_HMAC).toBe("true");
  });

  it("prefers Ed25519 and permits the previous key during rotation", async () => {
    const body = new TextEncoder().encode(JSON.stringify(baseEvent));
    const timestamp = "2026-07-17T20:00:00Z";
    const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    const publicValue = btoa(String.fromCharCode(...rawKey)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const message = new TextEncoder().encode(`${timestamp}.${new TextDecoder().decode(body)}`);
    const rawSignature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, message));
    const signature = btoa(String.fromCharCode(...rawSignature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const invalidRawSignature = rawSignature.slice(); invalidRawSignature[0] = invalidRawSignature[0]! ^ 1;
    const invalidSignature = btoa(String.fromCharCode(...invalidRawSignature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const validHmac=await paHmacHeader(body,timestamp,"valid-fallback-secret");
    await expect(verifyWebhookSignature(body, timestamp, `ed25519=${signature}`, undefined, publicValue, null, "", false)).resolves.toBe("ed25519-previous");
    await expect(verifyWebhookSignature(body, timestamp, `ed25519=${invalidSignature}`, publicValue, undefined, validHmac, "valid-fallback-secret", true)).rejects.toThrow("signature-invalid");
  });

  it("verifies issuer, audience, algorithm, and signature on the Access assertion", async () => {
    const {privateKey,publicKey}=await generateKeyPair("RS256");
    const jwk=await exportJWK(publicKey); jwk.kid="test-key"; jwk.alg="RS256";
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({keys:[jwk]})));
    const issuer="https://team.cloudflareaccess.com";
    const token=await new SignJWT({type:"service_token"}).setProtectedHeader({alg:"RS256",kid:"test-key"}).setIssuer(issuer).setAudience("expected-aud").setSubject("service-token").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const env={TEAM_DOMAIN:issuer,CF_ACCESS_AUD:"expected-aud"};
    await expect(verifyAccessAssertion(new Request("https://example.test",{headers:{"Cf-Access-Jwt-Assertion":token}}),env)).resolves.toMatchObject({sub:"service-token"});
    const wrongAudience={...env,CF_ACCESS_AUD:"wrong"};
    await expect(verifyAccessAssertion(new Request("https://example.test",{headers:{"Cf-Access-Jwt-Assertion":token}}),wrongAudience)).rejects.toThrow("access-assertion-invalid");
  });
});
