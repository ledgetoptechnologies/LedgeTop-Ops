import { describe, expect, it } from "vitest";
import { IncrementalSha256, sha256Blob } from "../src/client/incremental-sha256";

describe("streaming browser SHA-256", () => {
  it("matches standard empty and abc vectors across update boundaries", async () => {
    expect(new IncrementalSha256().digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const hash = new IncrementalSha256().update(new TextEncoder().encode("a"))
      .update(new TextEncoder().encode("bc")).digestHex();
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    await expect(sha256Blob(new Blob(["abc"]))).resolves.toBe(hash);
  });
});
