import { describe, expect, it, vi } from "vitest";
import { readNativeDirectoryClientProfileSnapshot } from "../src/worker/native-directory-profile-routes";

const createProfile = { name: "Client", email: "client@example.test", phone: "", clientType: "business",
  addressLine1: "1 Main St", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" };
const updateProfile = { name: "Updated Client", email: "updated@example.test", phone: "555-0100",
  addressLine1: "2 Main St", addressLine2: "Suite 1", city: "Austin", state: "TX", postalCode: "78702", country: "US" };

function database(results: unknown[]) {
  const all = vi.fn(async () => ({ results }));
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: { withSession: vi.fn(() => ({ prepare })) } as unknown as D1Database, prepare, bind };
}

describe("native Directory complete client profile snapshots", () => {
  it("reads an original create revision without changing its immutable type", async () => {
    const { db, bind } = database([{ version: 1, currentProfileJson: JSON.stringify(createProfile),
      creationProfileJson: JSON.stringify(createProfile) }]);
    await expect(readNativeDirectoryClientProfileSnapshot(db, "client-1")).resolves.toEqual({ version: 1, profile: createProfile });
    expect(bind).toHaveBeenCalledWith("client-1");
  });

  it("reconstructs an update revision with the authoritative creation client type", async () => {
    const { db } = database([{ version: 7, currentProfileJson: JSON.stringify(updateProfile),
      creationProfileJson: JSON.stringify(createProfile) }]);
    await expect(readNativeDirectoryClientProfileSnapshot(db, "client-1")).resolves.toEqual({
      version: 7, profile: { ...updateProfile, clientType: "business" },
    });
  });

  it.each([
    ["missing creation type", { ...createProfile, clientType: undefined }],
    ["invalid creation type", { ...createProfile, clientType: "partner" }],
  ])("fails closed for %s", async (_label, creation) => {
    const { db } = database([{ version: 2, currentProfileJson: JSON.stringify(updateProfile),
      creationProfileJson: JSON.stringify(creation) }]);
    await expect(readNativeDirectoryClientProfileSnapshot(db, "client-1")).resolves.toBeNull();
  });

  it("fails closed for ambiguous current-version evidence", async () => {
    const row = { version: 2, currentProfileJson: JSON.stringify(updateProfile), creationProfileJson: JSON.stringify(createProfile) };
    const { db } = database([row, row]);
    await expect(readNativeDirectoryClientProfileSnapshot(db, "client-1")).resolves.toBeNull();
  });

  it("fails closed when a legacy full update contradicts the immutable creation type", async () => {
    const { db } = database([{ version: 2, currentProfileJson: JSON.stringify({ ...updateProfile, clientType: "consumer" }),
      creationProfileJson: JSON.stringify(createProfile) }]);
    await expect(readNativeDirectoryClientProfileSnapshot(db, "client-1")).resolves.toBeNull();
  });
});
