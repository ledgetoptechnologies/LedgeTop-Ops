import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

import { encryptImportSecret, decryptImportSecret } from "../src/worker/dropbox-import";

describe("Dropbox import secret encryption", () => {
  const secret = "test-secret-material-at-least-32-chars-long!!";

  it("round trips JSON and binds ciphertext to its entity purpose", async () => {
    const encrypted = await encryptImportSecret({ accessToken: "test-token" }, secret, "authorization:auth-1");
    const decrypted = await decryptImportSecret<{ accessToken: string }>(
      encrypted.ciphertext, encrypted.iv, secret, "authorization:auth-1",
    );
    expect(decrypted).toEqual({ accessToken: "test-token" });
  });

  it("rejects decryption with the wrong purpose", async () => {
    const encrypted = await encryptImportSecret({ accessToken: "test-token" }, secret, "authorization:auth-1");
    await expect(
      decryptImportSecret<{ accessToken: string }>(encrypted.ciphertext, encrypted.iv, secret, "authorization:auth-2"),
    ).rejects.toThrow();
  });

  it("rejects decryption with the wrong secret", async () => {
    const encrypted = await encryptImportSecret({ accessToken: "test-token" }, secret, "authorization:auth-1");
    await expect(
      decryptImportSecret<{ accessToken: string }>(encrypted.ciphertext, encrypted.iv, "wrong-secret-at-least-32-chars-long!!", "authorization:auth-1"),
    ).rejects.toThrow();
  });
});