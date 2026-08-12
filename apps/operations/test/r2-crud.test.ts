import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { assertSafeCrudDestination, browserUploadObjectKey, normalizeAdministratorDeleteKey, normalizeCrudKey, operationsMultipartPartSize, requiresAdministratorForMutation } from "../src/worker/r2-crud-validation";
import { presignOperationsR2Part } from "../src/worker/r2-signing";

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(secret: string | Buffer, value: string): Buffer {
  return createHmac("sha256", secret).update(value).digest();
}

function validPartSignature(
  value: string,
  headers: { "content-length": string; "content-type": string },
  secret: string,
  now: Date,
): boolean {
  const url = new URL(value);
  const supplied = url.searchParams.get("X-Amz-Signature") || "";
  const timestamp = url.searchParams.get("X-Amz-Date") || "";
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  const issuedAt = Date.UTC(
    Number(timestamp.slice(0, 4)), Number(timestamp.slice(4, 6)) - 1, Number(timestamp.slice(6, 8)),
    Number(timestamp.slice(9, 11)), Number(timestamp.slice(11, 13)), Number(timestamp.slice(13, 15)),
  );
  if (!Number.isFinite(issuedAt) || !Number.isInteger(expires) || now.getTime() > issuedAt + expires * 1000) return false;
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") || "";
  const query = [...url.searchParams.entries()]
    .filter(([key]) => key !== "X-Amz-Signature")
    .map(([key, entry]) => [awsEncode(key), awsEncode(entry)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([key, entry]) => `${key}=${entry}`)
    .join("&");
  const canonicalHeaders = `content-length:${headers["content-length"]}\ncontent-type:${headers["content-type"]}\nhost:${url.host}\n`;
  const canonical = `PUT\n${url.pathname}\n${query}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const scope = (url.searchParams.get("X-Amz-Credential") || "").split("/").slice(1).join("/");
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  const dateKey = hmac(`AWS4${secret}`, timestamp.slice(0, 8));
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex") === supplied;
}

describe("Operations R2 CRUD boundaries", () => {
  it("accepts only canonical Jobs/Clients paths", () => {
    expect(normalizeCrudKey("Jobs/Clients/Acme/photo.jpg")).toBe("Jobs/Clients/Acme/photo.jpg");
    expect(normalizeCrudKey("Jobs/Clients/Acme/Edited", true)).toBe("Jobs/Clients/Acme/Edited/");
    expect(normalizeCrudKey("Jobs/Clients", true)).toBe("Jobs/Clients/");
    expect(() => normalizeCrudKey("Jobs/Clients")).toThrow();
    expect(browserUploadObjectKey("Jobs/Clients", "root-photo.jpg")).toEqual({
      root: "Jobs/Clients/", relative: "root-photo.jpg", key: "Jobs/Clients/root-photo.jpg",
    });
    expect(() => normalizeCrudKey("Jobs/Demo/photo.jpg")).toThrow();
    expect(() => normalizeCrudKey("Jobs/Clients/Acme/.previews/x.webp")).toThrow();
    expect(() => normalizeCrudKey("Jobs/Clients/Acme/DUMP/raw.jpg")).toThrow();
    expect(() => normalizeCrudKey("Jobs/Clients/Acme/../Other/photo.jpg")).toThrow();
  });

  it("enforces R2's 1,024-byte key limit using UTF-8 bytes rather than characters", () => {
    const prefix = "Jobs/Clients/Acme/";
    const exact = `${prefix}${"é".repeat(503)}`;
    const over = `${prefix}${"é".repeat(502)}€`;

    expect(new TextEncoder().encode(exact)).toHaveLength(1_024);
    expect(normalizeCrudKey(exact)).toBe(exact);
    expect(new TextEncoder().encode(over)).toHaveLength(1_025);
    expect(() => normalizeCrudKey(over)).toThrow("1,024-byte storage limit");
    expect(() => normalizeCrudKey(exact, true)).toThrow("1,024-byte storage limit");
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
    expect(requiresAdministratorForMutation("POST","/api/client-portal/accounts/account-1/folder-grants")).toBe(false);
    expect(requiresAdministratorForMutation("DELETE","/api/client-portal/accounts/account-1/folder-grants/grant-1")).toBe(false);
    expect(requiresAdministratorForMutation("POST","/api/delivery/items/item-1/stream-ticket")).toBe(false);
    expect(requiresAdministratorForMutation("POST","/api/delivery/incoming-link/rotate")).toBe(false);
    expect(requiresAdministratorForMutation("PUT","/api/operations/operation-1/job-brief")).toBe(false);
    expect(requiresAdministratorForMutation("POST","/api/operations/operation-1/job-brief/attachments/upload")).toBe(false);
    expect(requiresAdministratorForMutation("POST","/api/operations/operation-1/job-brief/attachments/reference")).toBe(false);
    expect(requiresAdministratorForMutation("POST","/api/operations/operation%2F1/job-brief/attachments/upload")).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/operations/operation-1/job-brief/attachments/file-1")).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/operations/operation-1/job-brief")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/operations/operation-1/job-brief")).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/delivery/shares")).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/delivery/shares/share-1/extra")).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/delivery/shares/share%2F1")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/delivery/items/item%2F1/stream-ticket")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/delivery/shares/share-1")).toBe(true);
    expect(requiresAdministratorForMutation("POST","/api/client-portal/accounts/account%2F1/folder-grants")).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/client-portal/accounts/account-1/folder-grants/grant%2F1")).toBe(true);
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
    const input={accountId:"0123456789abcdef0123456789abcdef",bucket:"client-data",key:"_ltds/browser-uploads/intent/session",uploadId:"upload+id",partNumber:2,contentLength:32*1024**2,contentType:"application/octet-stream",accessKeyId:"key",secretAccessKey:"secret",now:new Date("2026-07-24T12:00:00Z")};
    const url=await presignOperationsR2Part(input);
    expect(url).toContain("partNumber=2");
    expect(url).toContain("uploadId=upload%2Bid");
    expect(url).toContain("_ltds/browser-uploads/intent/session");
    expect(url).toContain("X-Amz-Expires=300");
    expect(url).toContain("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost");
    expect(url).toMatch(/X-Amz-Signature=[a-f0-9]{64}$/);
    expect(validPartSignature(url, { "content-length": String(input.contentLength), "content-type": input.contentType }, input.secretAccessKey, input.now)).toBe(true);

    const otherSession=await presignOperationsR2Part({...input,key:"_ltds/browser-uploads/other/session",uploadId:"other",partNumber:1});
    const otherLength=await presignOperationsR2Part({...input,contentLength:1});
    expect(new URL(otherSession).searchParams.get("X-Amz-Signature")).not.toBe(new URL(url).searchParams.get("X-Amz-Signature"));
    expect(new URL(otherLength).searchParams.get("X-Amz-Signature")).not.toBe(new URL(url).searchParams.get("X-Amz-Signature"));
    const replayed = new URL(url);
    replayed.pathname = new URL(otherSession).pathname;
    replayed.searchParams.set("uploadId", "other");
    expect(validPartSignature(replayed.toString(), { "content-length": String(input.contentLength), "content-type": input.contentType }, input.secretAccessKey, input.now)).toBe(false);
    expect(validPartSignature(url, { "content-length": "1", "content-type": input.contentType }, input.secretAccessKey, input.now)).toBe(false);
    expect(validPartSignature(url, { "content-length": String(input.contentLength), "content-type": "text/plain" }, input.secretAccessKey, input.now)).toBe(false);
    expect(validPartSignature(url, { "content-length": String(input.contentLength), "content-type": input.contentType }, input.secretAccessKey, new Date("2026-07-24T12:05:01Z"))).toBe(false);
  });

  it("allows administrator deletion under Jobs only without widening ordinary CRUD", () => {
    expect(normalizeAdministratorDeleteKey("Jobs/.stfolder", true)).toBe("Jobs/.stfolder/");
    expect(normalizeAdministratorDeleteKey("Jobs/Demo/old-photo.jpg")).toBe("Jobs/Demo/old-photo.jpg");
    expect(() => normalizeAdministratorDeleteKey("Jobs", true)).toThrow();
    expect(() => normalizeAdministratorDeleteKey("_ltds/derivatives/x.webp")).toThrow();
    expect(() => normalizeAdministratorDeleteKey("Jobs/Clients/Acme/_ltds/internal.json")).toThrow();
    expect(() => normalizeAdministratorDeleteKey("Jobs/Clients/Acme/incoming/raw.jpg")).toThrow();
    expect(() => normalizeAdministratorDeleteKey("Outside/Jobs/file.jpg")).toThrow();
    expect(() => normalizeCrudKey("Jobs/.stfolder", true)).toThrow();
  });

  it("clamps multipart ticket expiry to five minutes and permits a one-second session remainder", async () => {
    const base={accountId:"0123456789abcdef0123456789abcdef",bucket:"client-data",key:"_ltds/browser-uploads/intent/session",uploadId:"upload",partNumber:1,contentLength:4,contentType:"application/octet-stream",accessKeyId:"key",secretAccessKey:"secret",now:new Date("2026-07-24T12:00:00Z")};
    expect(new URL(await presignOperationsR2Part({...base,expiresSeconds:999})).searchParams.get("X-Amz-Expires")).toBe("300");
    expect(new URL(await presignOperationsR2Part({...base,expiresSeconds:1})).searchParams.get("X-Amz-Expires")).toBe("1");
  });
});
