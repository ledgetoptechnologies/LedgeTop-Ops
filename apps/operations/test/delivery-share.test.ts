import { describe, expect, it } from "vitest";
import { deriveShareMetadata, resolveAccessCodeChange, resolveDivisionAssociation, resolveShareExpiration } from "../src/worker/delivery";
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
});
