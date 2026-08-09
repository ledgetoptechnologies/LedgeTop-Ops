import { beforeEach, describe, expect, it } from "vitest";
import {
  DELIVERY_FOLDER_CACHE_TTL_MS,
  activateDeliveryFolderCache,
  deactivateDeliveryFolderCache,
  invalidateDeliveryFolderCache,
  readDeliveryFolderCache,
  writeDeliveryFolderCache,
} from "../src/client/delivery-folder-cache";

describe("Delivery folder memory cache", () => {
  beforeEach(() => {
    activateDeliveryFolderCache(crypto.randomUUID());
  });

  it("reuses only fresh entries in the active identity and authorization scope", () => {
    writeDeliveryFolderCache("Jobs/Clients/", { folders: ["Acme"] }, 1_000);
    expect(readDeliveryFolderCache("Jobs/Clients/", 1_000 + DELIVERY_FOLDER_CACHE_TTL_MS - 1))
      .toEqual({ folders: ["Acme"] });
    expect(readDeliveryFolderCache("Jobs/Clients/", 1_000 + DELIVERY_FOLDER_CACHE_TTL_MS))
      .toBeNull();
  });

  it("clears every entry when the session identity or effective scope changes", () => {
    writeDeliveryFolderCache("Jobs/Clients/", { folders: ["Tenant A"] });
    activateDeliveryFolderCache("different-user-or-scope");
    expect(readDeliveryFolderCache("Jobs/Clients/")).toBeNull();
  });

  it("supports prefix and full invalidation after mutations or access denial", () => {
    writeDeliveryFolderCache("Jobs/", { folders: ["Archive"] });
    writeDeliveryFolderCache("Jobs/Clients/", { folders: ["Acme"] });
    invalidateDeliveryFolderCache("Jobs/");
    expect(readDeliveryFolderCache("Jobs/")).toBeNull();
    expect(readDeliveryFolderCache("Jobs/Clients/")).not.toBeNull();
    invalidateDeliveryFolderCache();
    expect(readDeliveryFolderCache("Jobs/Clients/")).toBeNull();
  });

  it("cannot read or write entries after authorization verification fails", () => {
    writeDeliveryFolderCache("Jobs/Clients/", { folders: ["Acme"] });
    deactivateDeliveryFolderCache();
    expect(readDeliveryFolderCache("Jobs/Clients/")).toBeNull();
    writeDeliveryFolderCache("Jobs/Clients/", { folders: ["Should not persist"] });
    expect(readDeliveryFolderCache("Jobs/Clients/")).toBeNull();
  });
});
