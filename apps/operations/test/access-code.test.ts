import { describe, expect, it } from "vitest";
import { generateSecureAccessCode } from "../src/client/access-code";

describe("generateSecureAccessCode", () => {
  it("generates a readable 16-character code accepted by the share API", () => {
    const code = generateSecureAccessCode();
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{16}$/);
  });

  it("rejects lengths below the delivery system minimum", () => {
    expect(() => generateSecureAccessCode(7)).toThrow("at least eight");
  });
});
