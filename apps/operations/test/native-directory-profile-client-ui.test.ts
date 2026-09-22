import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editor = readFileSync(new URL("../src/client/NativeDirectoryProfileEditor.tsx", import.meta.url), "utf8");
const hub = readFileSync(new URL("../src/client/ClientHub.tsx", import.meta.url), "utf8");
const directory = readFileSync(new URL("../src/client/ClientDirectory.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/client/OperationsApp.tsx", import.meta.url), "utf8");

describe("Client Hub profile editor UI contract", () => {
  it("is mounted only behind the server session capability and exact mapped record ID", () => {
    expect(app).toContain("session.capabilities?.nativeDirectoryProfileWrites?.enabled === true");
    expect(directory).toContain("nativeDirectoryProfileWrites && <NativeDirectoryProfileCreate />");
    expect(hub).toContain("data.nativeDirectoryProfile.recordId");
    expect(hub).not.toContain("recordId={data.client.public_id}");
  });

  it("uses server-owned choices and sends only the mutation intent to the two-step create and update routes", () => {
    expect(editor).toContain("/api/client-hub/directory/create-options?kind=${kind}");
    expect(editor).toContain('"Idempotency-Key": mutationId');
    expect(editor).toContain("/api/client-hub/directory/create-admissions");
    expect(editor).toContain("expectedLocalVersion: snapshot.version");
    expect(editor).not.toContain("expectedAuthorizationGeneration");
    expect(editor).not.toContain("sourceInstanceUUID");
    expect(editor).not.toContain("applicationUUID");
    expect(editor).not.toContain("historyEpoch");
  });

  it("keeps linked-client profile changes visibly unavailable", () => {
    expect(editor).toContain("linked-client profile is read-only here");
    expect(editor).toContain("immutable relationship assertion");
  });
});
