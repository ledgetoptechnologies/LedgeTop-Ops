import { describe, expect, it } from "vitest";
import { assertSafeCrudDestination, normalizeCrudKey, operationsMultipartPartSize, requiresAdministratorForMutation } from "../src/worker/r2-crud-validation";
import { presignOperationsR2Part } from "../src/worker/r2-signing";

describe("Operations R2 CRUD boundaries", () => {
  it("accepts only canonical Jobs/Clients paths", () => {
    expect(normalizeCrudKey("Jobs/Clients/Acme/photo.jpg")).toBe("Jobs/Clients/Acme/photo.jpg");
    expect(normalizeCrudKey("Jobs/Clients/Acme/Edited", true)).toBe("Jobs/Clients/Acme/Edited/");
    expect(() => normalizeCrudKey("Jobs/Demo/photo.jpg")).toThrow();
    expect(() => normalizeCrudKey("Jobs/Clients/Acme/.previews/x.webp")).toThrow();
    expect(() => normalizeCrudKey("Jobs/Clients/Acme/DUMP/raw.jpg")).toThrow();
    expect(() => normalizeCrudKey("Jobs/Clients/Acme/../Other/photo.jpg")).toThrow();
  });

  it("keeps a 500 GiB upload inside R2's part-count limit", () => {
    const size = 500 * 1024 ** 3;
    const partSize = operationsMultipartPartSize(size);
    expect(Math.ceil(size / partSize)).toBeLessThanOrEqual(10_000);
    expect(partSize % (5 * 1024 ** 2)).toBe(0);
  });

  it("requires administrators for state changes except delegated share actions and stream tickets", () => {
    expect(requiresAdministratorForMutation("POST","/api/projects/project-1/folder")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/delivery/trash/trash-1/restore")).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/delivery/items/item-1/source")).toBe(true);
    expect(requiresAdministratorForMutation("PATCH","/api/delivery/items/item-1/display-name")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/delivery/fs/move")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/delivery/uploads/upload-1/complete")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/delivery/shares")).toBe(false);
    expect(requiresAdministratorForMutation("DELETE","/api/delivery/shares/share-1")).toBe(false);
    expect(requiresAdministratorForMutation("POST","/api/delivery/items/item-1/stream-ticket")).toBe(false);
    expect(requiresAdministratorForMutation("POST","/api/delivery/incoming-link/rotate")).toBe(false);
    expect(requiresAdministratorForMutation("DELETE","/api/delivery/shares")).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/delivery/shares/share-1/extra")).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/delivery/shares/share%2F1")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/delivery/items/item%2F1/stream-ticket")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/delivery/shares/share-1")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/API/delivery/shares")).toBe(true);
    expect(requiresAdministratorForMutation("GET","/api/delivery/fs/jobs/job-1")).toBe(false);
  });

  it("prevents folders from being copied, moved, or renamed into themselves or descendants", () => {
    expect(() => assertSafeCrudDestination("Jobs/Clients/Acme/Edited","Jobs/Clients/Acme/Edited",true)).toThrow("Source and destination must differ");
    expect(() => assertSafeCrudDestination("Jobs/Clients/Acme/Edited","Jobs/Clients/Acme/Edited/Exports",true)).toThrow("own descendants");
    expect(() => assertSafeCrudDestination("Jobs/Clients/Acme/Edited/","Jobs/Clients/Acme/Edited/Exports/",true)).toThrow("own descendants");
    expect(() => assertSafeCrudDestination("Jobs/Clients/Acme/Edited","Jobs/Clients/Acme/Edited Backup",true)).not.toThrow();
    expect(() => assertSafeCrudDestination("Jobs/Clients/Acme/Edited","Jobs/Clients/Other/Edited",true)).not.toThrow();
    expect(() => assertSafeCrudDestination("Jobs/Clients/Acme/photo.jpg","Jobs/Clients/Acme/photo.jpg.bak",false)).not.toThrow();
  });

  it("creates a bounded object-specific multipart ticket", async () => {
    const url=await presignOperationsR2Part({accountId:"0123456789abcdef0123456789abcdef",bucket:"client-data",key:"Jobs/Clients/Acme/photo 1.jpg",uploadId:"upload+id",partNumber:2,accessKeyId:"key",secretAccessKey:"secret",now:new Date("2026-07-24T12:00:00Z")});
    expect(url).toContain("partNumber=2");
    expect(url).toContain("uploadId=upload%2Bid");
    expect(url).toContain("photo%201.jpg");
    expect(url).toMatch(/X-Amz-Signature=[a-f0-9]{64}$/);
  });
});
