import { describe, expect, it } from "vitest";
import { CLOUDFLARE_ACCESS_LOGOUT_PATH } from "../../../packages/ui/src/access";

describe("account menu logout contract", () => {
  it("uses only Cloudflare Access's literal same-origin application logout path", () => {
    expect(CLOUDFLARE_ACCESS_LOGOUT_PATH).toBe("/cdn-cgi/access/logout");
    const parsed = new URL(CLOUDFLARE_ACCESS_LOGOUT_PATH, "https://ops.example.test");
    expect(parsed.origin).toBe("https://ops.example.test");
    expect(parsed.pathname).toBe("/cdn-cgi/access/logout");
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
  });
});
