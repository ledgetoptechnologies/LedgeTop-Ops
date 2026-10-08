import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/client/ProjectAlphaConnections.tsx", import.meta.url), "utf8");

describe("PA-created Project adoption operator UI contract", () => {
  it("keeps review, reservation, and bind as three explicit guarded actions", () => {
    expect(source).toContain("Create review evidence only");
    expect(source).toContain("Reserve reviewed intent");
    expect(source).toContain("Create local bind plan and queue command");
    expect(source).toContain("PROJECT_ADOPTION_REVIEW_ENDPOINT");
    expect(source).toContain('"/api/admin/project-alpha/private/projects/adoption/reserve"');
    expect(source).toContain('"/api/admin/project-alpha/private/projects/adoption/bind"');
    expect(source).toContain("window.confirm(\"Reserve this exact reviewed adoption intent?");
    expect(source).toContain("window.confirm(\"Create the native Operations Project and enqueue the exact PA binding command?");
  });

  it("freezes selection and idempotency after the first deliberate request", () => {
    expect(source).toContain("const frozen = Boolean(reviewRequest || reviewKey || reviewItemId || reserveKey || reservationId || commandId)");
    expect(source).toContain("disabled={busy || disabled || frozen}");
    expect(source).toContain("const request = reviewRequest ?? { idempotencyKey: crypto.randomUUID(), sourceId,");
    expect(source).toContain("const idempotencyKey = request.idempotencyKey");
    expect(source).toContain("sourceId: request.sourceId, externalProjectId: request.externalProjectId");
    expect(source).toContain("const idempotencyKey = reserveKey || crypto.randomUUID()");
    expect(source).toContain('headers: { "Idempotency-Key": reservationId }');
    expect(source).toContain("Reset local flow");
  });

  it("retains identifiers on uncertainty and describes a planned bind honestly", () => {
    expect(source).toContain("same frozen request key is retained");
    expect(source).toContain("review ID and frozen reservation key are retained");
    expect(source).toContain("reservation ID is retained");
    expect(source).toContain("Project Alpha acknowledgement is not yet confirmed");
    expect(source).toContain("does not acknowledge remote completion, grant client access, or publish a portal");
    expect(source).toContain("No step in this panel grants client access or publishes the Project to a portal");
  });
});
