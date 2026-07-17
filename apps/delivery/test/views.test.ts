import { describe, expect, it } from "vitest";
import { renderAdmin, renderPortal } from "../src/views";

const admin = {
  type: "staff" as const,
  id: "test-admin",
  email: "beaukoltz@ledgetopdroneservices.com",
  displayName: "Beau",
  role: "admin" as const,
};

describe("staff workspace", () => {
  it("renders separate staff navigation without a website link", () => {
    const page = renderAdmin(admin);
    expect(page).toContain("Files");
    expect(page).toContain("Delivery Links");
    expect(page).toContain("Team &amp; API");
    expect(page).not.toContain('href="https://ledgetopdroneservices.com"');
  });

  it("contains syntactically valid client-side JavaScript", () => {
    const page = renderAdmin(admin);
    const script = page.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script || "")).not.toThrow();
  });
});

describe("client portal", () => {
  it("renders live folders, thumbnails, previews, and valid JavaScript", () => {
    const page = renderPortal({
      id: "share-1", project_id: "project-1", token_hash: "hash", label: null,
      password_hash: null, password_salt: null, password_iterations: null,
      expires_at: null, revoked_at: null, client_name: "Acme", project_name: "July flight",
      r2_prefix: "jobs/2026/Acme/", external_ref: null,
    }, "a".repeat(43), {
      prefix: "jobs/2026/Acme/",
      folders: [{ prefix: "jobs/2026/Acme/edited/", name: "edited" }],
      files: [{ key: "jobs/2026/Acme/map.jpg", name: "map.jpg", size: 2048, uploaded: new Date(0).toISOString(), etag: "etag", mediaType: "image" }],
      next_cursor: null,
    });
    expect(page).toContain("edited");
    expect(page).toContain("/thumbnail?key=");
    expect(page).toContain("/view?key=");
    const script = page.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(() => new Function(script || "")).not.toThrow();
  });
});
