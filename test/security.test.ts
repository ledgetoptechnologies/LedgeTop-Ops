import { describe, expect, it } from "vitest";
import { constantTimeEqual, hashPassword, verifyPassword } from "../src/crypto";
import { normalizePrefix } from "../src/shares";

describe("R2 prefix scoping", () => {
  it("normalizes a project prefix to a slash boundary", () => {
    expect(normalizePrefix("/clients/acme/roof-july")).toBe("clients/acme/roof-july/");
    expect(normalizePrefix("clients\\acme\\roof-july\\")).toBe("clients/acme/roof-july/");
  });

  it("rejects root and traversal prefixes", () => {
    expect(() => normalizePrefix("/")).toThrow();
    expect(() => normalizePrefix("clients/acme/../private")).toThrow();
  });
});

describe("access-code verification", () => {
  it("accepts only the password used to create the hash", async () => {
    const password = await hashPassword("correct-horse-battery-staple");
    await expect(
      verifyPassword("correct-horse-battery-staple", password.hash, password.salt, password.iterations),
    ).resolves.toBe(true);
    await expect(
      verifyPassword("wrong-password", password.hash, password.salt, password.iterations),
    ).resolves.toBe(false);
  });

  it("compares values without early length exits", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different")).toBe(false);
  });
});
