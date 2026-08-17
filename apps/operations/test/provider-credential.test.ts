import { describe, expect, it } from "vitest";
import { MAX_PROVIDER_CREDENTIAL_BYTES, providerCredentialError } from "../src/client/provider-credential";

describe("provider credential input", () => {
  it("preserves exact valid token bytes, including spaces", () => {
    expect(providerCredentialError(" token with spaces ")).toBeNull();
    expect(providerCredentialError("x".repeat(MAX_PROVIDER_CREDENTIAL_BYTES))).toBeNull();
  });

  it("rejects empty, control-delimited, and oversized values", () => {
    expect(providerCredentialError("")).toMatch(/Enter/);
    expect(providerCredentialError("token\nnext")).toMatch(/line breaks/);
    expect(providerCredentialError("token\rnext")).toMatch(/line breaks/);
    expect(providerCredentialError("token\0next")).toMatch(/null/);
    expect(providerCredentialError("é".repeat(MAX_PROVIDER_CREDENTIAL_BYTES))).toMatch(/UTF-8 bytes/);
  });
});
