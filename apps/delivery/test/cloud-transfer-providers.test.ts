import { describe, expect, it, vi } from "vitest";
import { decryptJson, encryptJson, randomBase64Url, sha256Base64Url } from "../src/worker/cloud-transfer/crypto";
import {
  buildDropboxAuthorizationUrl,
  buildGoogleAuthorizationUrl,
  exchangeDropboxCode,
  refreshGoogleToken,
} from "../src/worker/cloud-transfer/oauth";
import { DropboxClient } from "../src/worker/cloud-transfer/providers/dropbox";
import { createCloudProviderAdapter } from "../src/worker/cloud-transfer/providers";
import { GoogleDriveClient } from "../src/worker/cloud-transfer/providers/google-drive";
import { ProviderHttpError, parseRetryAfter, providerFetch } from "../src/worker/cloud-transfer/providers/provider";

describe("cloud transfer cryptography and OAuth", () => {
  it("creates PKCE-compatible authorization URLs with exact minimal provider settings", () => {
    const common = {
      clientId: "client",
      redirectUri: "https://delivery.example/api/callback",
      state: "state",
      challenge: "challenge",
    };
    const dropbox = new URL(buildDropboxAuthorizationUrl(common));
    expect(dropbox.origin).toBe("https://www.dropbox.com");
    expect(dropbox.searchParams.get("token_access_type")).toBe("offline");
    expect(dropbox.searchParams.get("code_challenge_method")).toBe("S256");

    const google = new URL(buildGoogleAuthorizationUrl(common));
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(google.searchParams.get("access_type")).toBe("offline");
  });

  it("exchanges and refreshes tokens without putting credentials in URLs", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).not.toContain("secret");
      expect(init?.method).toBe("POST");
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    });
    const exchanged = await exchangeDropboxCode({
      clientId: "id", clientSecret: "secret", redirectUri: "https://delivery.example/callback",
      code: "code", verifier: "verifier", fetch: fetcher,
    });
    expect(exchanged.accessToken).toBe("access");
    expect(exchanged.refreshToken).toBe("refresh");

    const refreshed = await refreshGoogleToken({
      clientId: "id", clientSecret: "secret", refreshToken: "persisted", fetch: fetcher,
    });
    expect(refreshed.refreshToken).toBe("persisted");
  });

  it("encrypts authenticated JSON and rejects the wrong context", async () => {
    const key = randomBase64Url(32);
    const encrypted = await encryptJson({ token: "not-logged" }, key, "google|job|share|1");
    expect(encrypted.ciphertext).not.toContain("not-logged");
    await expect(decryptJson(encrypted, key, "google|job|share|2")).rejects.toThrow(
      "cloud-transfer-encrypted-value-invalid",
    );
    await expect(decryptJson<{ token: string }>(encrypted, key, "google|job|share|1"))
      .resolves.toEqual({ token: "not-logged" });
    expect(await sha256Base64Url("state")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("provider HTTP behavior", () => {
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3", 0)).toBe(3000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 4000)).toBe(6000);
    expect(parseRetryAfter("invalid", 0)).toBeUndefined();
  });

  it("classifies retryable provider responses without exposing response bodies", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: "secret raw provider detail" }),
      { status: 429, headers: { "Retry-After": "2", "Content-Type": "application/json" } },
    ));
    const error = await providerFetch(fetcher, "https://provider.invalid", {}, { operation: "provider-test" })
      .catch(value => value);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000 });
    expect((error as Error).message).not.toContain("secret raw provider detail");
  });
});

describe("Dropbox primitives", () => {
  it("submits and polls save_url jobs with bearer authorization", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
      return String(input).endsWith("check_job_status")
        ? Response.json({ ".tag": "complete", metadata: { id: "dbid:file" } })
        : Response.json({ async_job_id: "async" });
    });
    const client = new DropboxClient({ accessToken: "token", fetch: fetcher });
    await expect(client.saveUrl("/Delivery/file.jpg", "https://delivery.example/grant")).resolves.toEqual(
      { kind: "async", jobId: "async" },
    );
    await expect(client.saveUrlStatus("async")).resolves.toEqual(
      { kind: "complete", fileId: "dbid:file" },
    );
  });

  it("uses upload cursors and non-destructive finish semantics", async () => {
    const requests: Array<{ url: string; argument: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        argument: JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg") || "{}") as Record<string, unknown>,
      });
      if (String(input).endsWith("/start")) return Response.json({ session_id: "session" });
      if (String(input).endsWith("/finish")) return Response.json({ id: "dbid:complete" });
      return new Response(null, { status: 200 });
    });
    const client = new DropboxClient({ accessToken: "token", fetch: fetcher });
    expect(await client.uploadSessionStart()).toBe("session");
    await client.uploadSessionAppend("session", 0, new Uint8Array([1, 2]));
    await client.uploadSessionFinish("session", 2, "/Delivery/file.jpg");
    const commit = requests[2]?.argument.commit as Record<string, unknown>;
    expect(commit).toMatchObject({ mode: "add", autorename: true, strict_conflict: false });
  });
});

describe("Google Drive primitives", () => {
  it("starts resumable uploads and reconciles committed offsets", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("uploadType=resumable")) {
        return new Response(null, { headers: { Location: "https://upload.example/session" } });
      }
      expect(new Headers(init?.headers).get("Content-Range")).toBe("bytes 0-3/8");
      return new Response(null, { status: 308, headers: { Range: "bytes=0-3" } });
    });
    const client = new GoogleDriveClient({ accessToken: "token", fetch: fetcher });
    const session = await client.startResumableUpload({
      name: "file.jpg", parentId: "folder", mimeType: "image/jpeg", size: 8, transferId: "item",
    });
    await expect(client.uploadChunk(session, 0, 8, new Uint8Array([1, 2, 3, 4]))).resolves.toEqual(
      { complete: false, committedBytes: 4 },
    );
  });

  it("queries an ambiguous resumable session without replaying data", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Content-Range")).toBe("bytes */100");
      expect(new Headers(init?.headers).get("Content-Length")).toBe("0");
      return new Response(null, { status: 308, headers: { Range: "bytes=0-63" } });
    });
    const client = new GoogleDriveClient({ accessToken: "token", fetch: fetcher });
    await expect(client.queryUploadStatus("https://upload.example/session", 100)).resolves.toEqual(
      { complete: false, committedBytes: 64 },
    );
  });
});
describe("Dropbox staged-beta transfer behavior", () => {
  it("skips an existing destination without reading the R2 object", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("files/get_metadata");
      return Response.json({ id: "dbid:existing" });
    });
    vi.stubGlobal("fetch", fetcher);
    const get = vi.fn();
    const adapter = createCloudProviderAdapter("dropbox", { DATA_BUCKET: { get } } as never);
    const result = await adapter.transfer({
      env: {} as never,
      job: {} as never,
      item: { id: "item", source_key: "source", source_etag: "etag", source_size: 20, destination_path: "nested/file.bin" } as never,
      credential: { accessToken: "token" },
      destination: { path: "/LTDS Delivery/" },
      conflictMode: "skip",
      signalCancelled: async () => false,
      loadUploadState: async () => null,
      saveUploadState: async () => undefined,
    });
    expect(result).toEqual({ status: "skipped", providerFileId: "dbid:existing", uploadedBytes: 0 });
    expect(get).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("resumes a saved Dropbox session and applies the destination root once", async () => {
    const requests: Array<{ url: string; argument: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), argument: JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg") || "{}") as Record<string, unknown> });
      return String(input).endsWith("/finish") ? Response.json({ id: "dbid:done" }) : new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const get = vi.fn(async (_key: string, options: { range: { offset: number; length: number } }) => ({
      body: new ReadableStream(),
      arrayBuffer: async () => new Uint8Array(options.range.length).buffer,
    }));
    const adapter = createCloudProviderAdapter("dropbox", { DATA_BUCKET: { get } } as never);
    const saved: Array<{ state: unknown; bytes: number }> = [];
    const result = await adapter.transfer({
      env: {} as never,
      job: {} as never,
      item: { id: "item", source_key: "source", source_etag: "etag", source_size: 6, destination_path: "nested/file.bin" } as never,
      credential: { accessToken: "token" },
      destination: { path: "/LTDS Delivery/" },
      conflictMode: "autorename",
      signalCancelled: async () => false,
      loadUploadState: async () => ({ state: { provider: "dropbox", sessionId: "saved-session" }, uploadedBytes: 2 }),
      saveUploadState: async (state, bytes) => { saved.push({ state, bytes }); },
    });
    expect(result).toMatchObject({ status: "completed", uploadedBytes: 6 });
    expect(fetcher.mock.calls.some(call => String(call[0]).endsWith("/start"))).toBe(false);
    expect(get).toHaveBeenCalledWith("source", expect.objectContaining({ range: { offset: 2, length: 4 } }));
    const append = requests.find(request => request.url.endsWith("append_v2"));
    expect(append?.argument).toMatchObject({ cursor: { session_id: "saved-session", offset: 2 } });
    const finish = requests.find(request => request.url.endsWith("/finish"));
    expect(finish?.argument).toMatchObject({ commit: { path: "/LTDS Delivery/nested/file.bin", mode: "add", autorename: true } });
    expect(saved.at(-1)?.bytes).toBe(6);
    vi.unstubAllGlobals();
  });

  it("reconciles Dropbox's committed offset after an ambiguous append", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error_summary: "lookup_failed/incorrect_offset/..",
      error: { ".tag": "lookup_failed", reason: { ".tag": "incorrect_offset", correct_offset: 8 } },
    }), { status: 409, headers: { "Content-Type": "application/json" } }));
    const client = new DropboxClient({ accessToken: "token", fetch: fetcher });
    await expect(client.uploadSessionAppend("session", 0, new Uint8Array(8))).resolves.toBe(8);
  });

  it("treats a finish-time conflict as skipped without overwrite", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("get_metadata")) return new Response(JSON.stringify({ error_summary: "path/not_found/.." }), { status: 409, headers: { "Content-Type": "application/json" } });
      if (String(input).endsWith("/start")) return Response.json({ session_id: "session" });
      const argument = JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg") || "{}") as { commit?: Record<string, unknown> };
      expect(argument.commit).toMatchObject({ autorename: false, strict_conflict: true });
      return new Response(JSON.stringify({ error_summary: "path/conflict/file/.." }), { status: 409, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const adapter = createCloudProviderAdapter("dropbox", { DATA_BUCKET: {} } as never);
    await expect(adapter.transfer({
      env: {} as never, job: {} as never,
      item: { id: "item", source_key: "source", source_etag: "etag", source_size: 0, destination_path: "file.bin" } as never,
      credential: { accessToken: "token" }, destination: { path: "/Delivery" }, conflictMode: "skip",
      signalCancelled: async () => false, loadUploadState: async () => null, saveUploadState: async () => undefined,
    })).resolves.toEqual({ status: "skipped", uploadedBytes: 0 });
    vi.unstubAllGlobals();
  });
});
