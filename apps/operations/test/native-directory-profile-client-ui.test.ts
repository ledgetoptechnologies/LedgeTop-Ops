import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serializeNativeDirectoryProfile, type ProfileForm } from "../src/client/NativeDirectoryProfileEditor";

const editor = readFileSync(new URL("../src/client/NativeDirectoryProfileEditor.tsx", import.meta.url), "utf8");
const hub = readFileSync(new URL("../src/client/ClientHub.tsx", import.meta.url), "utf8");
const directory = readFileSync(new URL("../src/client/ClientDirectory.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/client/OperationsApp.tsx", import.meta.url), "utf8");
const hubRoute = readFileSync(new URL("../src/worker/client-hub.ts", import.meta.url), "utf8");
const clientFields: ProfileForm = { name: " Example Client ", generalEmail: "", generalPhone: "", email: " client@example.test ",
  phone: " 512-555-0101 ", clientType: "business", addressLine1: " 2 Main Street ", addressLine2: " Suite 3 ",
  city: " Austin ", state: " TX ", postalCode: " 78702 ", country: " US " };

describe("Client Hub profile editor UI contract", () => {
  it("is mounted only behind the server session capability and exact mapped record ID", () => {
    expect(app).toContain("session.capabilities?.nativeDirectoryProfileWrites?.enabled === true");
    expect(directory).toContain("nativeDirectoryProfileWrites && <NativeDirectoryProfileCreate />");
    expect(hub).toContain("data.nativeDirectoryProfile.recordId");
    expect(hub).toContain("data.nativeDirectoryLinkedClients");
    expect(hub).toContain('NativeDirectoryProfileEdit kind="client" recordId={linkedClientRecordId}');
    expect(hub).not.toContain("recordId={data.client.public_id}");
    expect(hubRoute).toContain("nativeDirectoryProfileWritesEnabled(env)");
  });

  it("uses server-owned choices and sends only the mutation intent to the two-step create and update routes", () => {
    expect(editor).toContain("/api/client-hub/directory/create-options?kind=${kind}");
    expect(editor).toContain('"Idempotency-Key": request.mutationId');
    expect(editor).toContain("/api/client-hub/directory/create-admissions");
    expect(editor).toContain("expectedLocalVersion: snapshot.version");
    expect(editor).not.toContain("expectedAuthorizationGeneration");
    expect(editor).not.toContain("sourceInstanceUUID");
    expect(editor).not.toContain("applicationUUID");
    expect(editor).not.toContain("historyEpoch");
  });

  it("serializes client create profiles with the create-only client type", () => {
    expect(serializeNativeDirectoryProfile("client", clientFields, "create")).toEqual({
      name: "Example Client", email: "client@example.test", phone: "512-555-0101", clientType: "business",
      addressLine1: "2 Main Street", addressLine2: "Suite 3", city: "Austin", state: "TX", postalCode: "78702", country: "US",
    });
  });

  it("serializes client update profiles without the rejected create-only client type", () => {
    const profile = serializeNativeDirectoryProfile("client", clientFields, "update");

    expect(profile).toEqual({ name: "Example Client", email: "client@example.test", phone: "512-555-0101",
      addressLine1: "2 Main Street", addressLine2: "Suite 3", city: "Austin", state: "TX", postalCode: "78702", country: "US" });
    expect(Object.hasOwn(profile, "clientType")).toBe(false);
  });

  it("offers linked creation and keeps profile and relationship actions visibly separate", () => {
    expect(editor).toContain("Organization relationship");
    expect(editor).toContain("No organization (standalone client)");
    expect(editor).toContain("This is separate from profile editing");
    expect(editor).toContain("snapshot.relationship.editing.available");
    expect(editor).toContain("The organization relationship is read-only");
    expect(editor).toContain("expectedRelationshipVersion: snapshot.relationship!.version");
    expect(editor).toContain("Retry same profile creation");
    expect(editor).toContain("Retry same profile update");
    expect(editor).toContain("Retry same relationship update");
    expect(editor).not.toContain("organizationPublicId");
  });
});
