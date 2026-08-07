import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src/client/OperationsApp.tsx", import.meta.url),
  "utf8",
);

describe("authenticated browser upload UI", () => {
  it("uses the private same-origin intent, checkpoint, part, and completion routes", () => {
    expect(source).toContain('"/api/delivery/uploads/intents"');
    expect(source).toContain("`/api/delivery/uploads/${encodeURIComponent(created.sessionId)}`");
    expect(source).toContain("/parts/${partNumber}`");
    expect(source).toContain("/complete`");
    expect(source).not.toContain("/parts/${partNumber}/ticket");
    expect(source).not.toContain("fetch(ticket.url");
  });

  it("gates uploads on administrator, permission, and the runtime capability", () => {
    expect(source).toContain('admin &&\n      allowed(session.user, "delivery.files.upload")');
    expect(source).toContain("session.capabilities?.directDeliveryUploads?.enabled === true");
    expect(source).toContain("Direct browser uploads require administrator access.");
  });

  it("supports bounded file and folder batches with explicit collision behavior", () => {
    expect(source).toContain("const MAX_BROWSER_UPLOAD_FILES = 100");
    expect(source).toContain("const MAX_BROWSER_UPLOAD_BYTES = 500 * 1024 ** 3");
    expect(source).toContain('webkitdirectory: ""');
    expect(source).toContain('<option value="fail">Fail existing files</option>');
    expect(source).toContain('<option value="rename">');
    expect(source).toContain('<option value="replace">');
  });

  it("stops rather than retrying when authorization expires or is revoked", () => {
    expect(source).toContain("error.status === 401 || error.status === 403");
    expect(source).toContain("authorization expired or changed");
    expect(source).toContain('status: "stopped"');
  });
});
