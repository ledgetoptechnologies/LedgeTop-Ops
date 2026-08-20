import { describe, expect, it } from "vitest";
import { activeShareForPrefix, deriveShareMetadata, resolveAccessCodeChange, resolveDivisionAssociation, resolveShareExpiration, resolveShareUpdateSecurity } from "../src/worker/delivery";
import { accessCodeMatches, decryptDeliveryToken, encryptDeliveryToken, hashAccessCode } from "../src/worker/crypto";

describe("delivery share metadata", () => {
  it("derives required legacy project metadata from the shared folder", () => {
    expect(deriveShareMetadata("jobs/2026/Client/Real Estate photos/")).toEqual({
      clientName: "Real Estate photos",
      projectName: "Real Estate photos",
    });
  });

  it("preserves optional metadata supplied by future integrations", () => {
    expect(deriveShareMetadata("jobs/2026/client/edited/", {
      clientName: "Client record",
      projectName: "Project record",
    })).toEqual({ clientName: "Client record", projectName: "Project record" });
  });
});

describe("delivery share scope inference", () => {
  it("uses the most specific folder association", () => {
    expect(resolveDivisionAssociation("jobs/2026/client/edited/", [
      { division_id: "north", r2_prefix: "jobs/2026/" },
      { division_id: "chippewa", r2_prefix: "jobs/2026/client/" },
    ])).toBe("chippewa");
  });

  it("returns no division for an unassociated folder", () => {
    expect(resolveDivisionAssociation("jobs/2026/other/", [
      { division_id: "chippewa", r2_prefix: "jobs/2026/client/" },
    ])).toBeNull();
  });

  it("rejects equally specific associations across divisions", () => {
    expect(() => resolveDivisionAssociation("jobs/2026/client/edited/", [
      { division_id: "chippewa", r2_prefix: "jobs/2026/client/" },
      { division_id: "madison", r2_prefix: "jobs/2026/client/" },
    ])).toThrow("multiple divisions");
  });
});

describe("delivery share expiration", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");

  it("defaults to a non-expiring share", () => {
    expect(resolveShareExpiration(undefined, 90, now)).toBeNull();
    expect(resolveShareExpiration(null, 90, now)).toBeNull();
  });

  it("normalizes a valid explicit expiration", () => {
    expect(resolveShareExpiration("2026-08-01T12:00:00Z", 90, now)).toBe("2026-08-01T12:00:00.000Z");
  });

  it("rejects expired and over-limit dates", () => {
    expect(() => resolveShareExpiration("2026-07-15T12:00:00Z", 90, now)).toThrow("within 90 days");
    expect(() => resolveShareExpiration("2027-01-01T12:00:00Z", 90, now)).toThrow("within 90 days");
  });
});

describe("delivery share lifecycle security",()=>{
  it("encrypts a recoverable fragment without allowing a different share to decrypt it",async()=>{const key="k".repeat(48),encrypted=await encryptDeliveryToken("fragment-secret",key,"share-1");expect(encrypted.ciphertext).not.toContain("fragment-secret");await expect(decryptDeliveryToken(encrypted.ciphertext,encrypted.iv,key,"share-1")).resolves.toBe("fragment-secret");await expect(decryptDeliveryToken(encrypted.ciphertext,encrypted.iv,key,"share-2")).rejects.toThrow("must be rotated");});
  it("distinguishes preserve, set, generated, and remove access-code actions",()=>{expect(resolveAccessCodeChange({})).toEqual({kind:"preserve",accessCode:null});expect(resolveAccessCodeChange({accessCode:"client-code"})).toEqual({kind:"set",accessCode:"client-code"});expect(resolveAccessCodeChange({generateAccessCode:true})).toMatchObject({kind:"set"});expect(resolveAccessCodeChange({removeAccessCode:true})).toEqual({kind:"remove",accessCode:null});expect(()=>resolveAccessCodeChange({generateAccessCode:true,accessCode:"client-code"})).toThrow("only one");});
  it("creates an idempotent versioned HMAC access-code verifier instead of CPU-heavy PBKDF2",async()=>{const pepper="p".repeat(48),stored=await hashAccessCode("client-code",pepper);expect(stored.algorithm).toBe("hmac-sha256-v1");expect(stored.iterations).toBe(1);expect(stored.hash).not.toContain("client-code");await expect(accessCodeMatches("client-code",stored.hash,stored.salt,stored.algorithm,pepper)).resolves.toBe(true);await expect(accessCodeMatches("different-code",stored.hash,stored.salt,stored.algorithm,pepper)).resolves.toBe(false);});
  it("keeps metadata-only edits on the current credential version",()=>{
    expect(resolveShareUpdateSecurity({accessCodeChanged:false,recipientChanged:false,hasRecoverableSecret:true,publicIdChanged:false})).toEqual({mustRotateCredential:false,versionIncrement:0});
  });
  it.each([
    {accessCodeChanged:true,recipientChanged:false,hasRecoverableSecret:true,publicIdChanged:false},
    {accessCodeChanged:false,recipientChanged:true,hasRecoverableSecret:true,publicIdChanged:false},
    {accessCodeChanged:false,recipientChanged:false,hasRecoverableSecret:false,publicIdChanged:false},
  ])("rotates the bearer credential and security version for $accessCodeChanged/$recipientChanged/$hasRecoverableSecret",input=>{
    expect(resolveShareUpdateSecurity(input)).toEqual({mustRotateCredential:true,versionIncrement:1});
  });
  it("versions a legacy public-id upgrade without rotating a recoverable secret",()=>{
    expect(resolveShareUpdateSecurity({accessCodeChanged:false,recipientChanged:false,hasRecoverableSecret:true,publicIdChanged:true})).toEqual({mustRotateCredential:false,versionIncrement:1});
  });
});

describe("active delivery share lookup", () => {
  function lookupEnv(results: unknown[]) {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const database = { prepare(query: string) {
      const call = { query, values: [] as unknown[] }; calls.push(call);
      const statement = {
        bind(...values: unknown[]) { call.values = values; return statement; },
        async first<T>() { return (results.shift() ?? null) as T | null; },
      };
      return statement;
    } };
    return { env: { DELIVERY_DB: database } as never, calls };
  }

  it("uses the indexed share prefix path for current rows", async () => {
    const row = { id: "share-current" }; const { env, calls } = lookupEnv([row]);
    await expect(activeShareForPrefix(env, "Jobs/Clients/Acme/")).resolves.toBe(row);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain("WHERE s.r2_prefix=?");
    expect(calls[0]!.query).not.toContain("COALESCE(s.r2_prefix,p.r2_prefix)=?");
    expect(calls[0]!.values).toEqual(["Jobs/Clients/Acme/", null, null]);
  });

  it("falls back only to legacy null-prefix rows after an indexed miss", async () => {
    const legacy = { id: "share-legacy" }; const { env, calls } = lookupEnv([null, legacy]);
    await expect(activeShareForPrefix(env, "Jobs/Clients/Legacy/")).resolves.toBe(legacy);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.query).toContain("s.r2_prefix IS NULL AND p.r2_prefix=?");
    expect(calls[1]!.query).not.toContain("COALESCE(s.r2_prefix,p.r2_prefix)=?");
    expect(calls[1]!.values).toEqual(["Jobs/Clients/Legacy/"]);
  });

  it("looks up an exact-file share by both its parent prefix and object key without folder fallback", async () => {
    const row = { id: "share-file", r2_object_key: "Jobs/Clients/Acme/video.mov" };
    const { env, calls } = lookupEnv([row]);
    await expect(activeShareForPrefix(env, "Jobs/Clients/Acme/", row.r2_object_key)).resolves.toBe(row);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain("r2_object_key=?");
    expect(calls[0]!.values).toEqual(["Jobs/Clients/Acme/", row.r2_object_key, row.r2_object_key]);
  });
});
