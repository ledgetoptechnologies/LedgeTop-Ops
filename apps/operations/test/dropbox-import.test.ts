import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

import { dropboxImportPartSize, encryptImportSecret, decryptImportSecret, importOneFile, loadDropboxImportCredential, revokeDropboxImportAuthorization } from "../src/worker/dropbox-import";
import { DropboxImportClient, DropboxImportError } from "../src/worker/dropbox-import-client";
import { dropboxImportCapability, registerDropboxImportRoutes } from "../src/worker/dropbox-import-routes";

describe("Dropbox import secret encryption", () => {
  const secret = "test-secret-material-at-least-32-chars-long!!";

  it("round trips JSON and binds ciphertext to its entity purpose", async () => {
    const encrypted = await encryptImportSecret({ accessToken: "test-token" }, secret, "authorization:auth-1");
    const decrypted = await decryptImportSecret<{ accessToken: string }>(
      encrypted.ciphertext, encrypted.iv, secret, "authorization:auth-1",
    );
    expect(decrypted).toEqual({ accessToken: "test-token" });
  });

  it("rejects decryption with the wrong purpose", async () => {
    const encrypted = await encryptImportSecret({ accessToken: "test-token" }, secret, "authorization:auth-1");
    await expect(
      decryptImportSecret<{ accessToken: string }>(encrypted.ciphertext, encrypted.iv, secret, "authorization:auth-2"),
    ).rejects.toThrow();
  });

  it("rejects decryption with the wrong secret", async () => {
    const encrypted = await encryptImportSecret({ accessToken: "test-token" }, secret, "authorization:auth-1");
    await expect(
      decryptImportSecret<{ accessToken: string }>(encrypted.ciphertext, encrypted.iv, "wrong-secret-at-least-32-chars-long!!", "authorization:auth-1"),
    ).rejects.toThrow();
  });
});

describe("Dropbox import capability", () => {
  it("distinguishes a disabled integration from missing configuration", () => {
    expect(dropboxImportCapability({ DROPBOX_IMPORT_ENABLED: "false" } as never)).toEqual({ enabled: false, reason: "disabled" });
    expect(dropboxImportCapability({ DROPBOX_IMPORT_ENABLED: "true", DROPBOX_CLIENT_ID: "id" } as never)).toEqual({ enabled: false, reason: "not-configured" });
  });

  it("is available only when OAuth secrets and the workflow binding are present", () => {
    expect(dropboxImportCapability({
      DROPBOX_IMPORT_ENABLED: "true",
      DROPBOX_CLIENT_ID: "id",
      DROPBOX_CLIENT_SECRET: "secret",
      DROPBOX_IMPORT_TOKEN_SECRET: "token-secret",
      DROPBOX_IMPORT_WORKFLOW: {},
    } as never)).toEqual({ enabled: true, reason: "available" });
  });
});

describe("Dropbox import client", () => {
  it("requests bounded byte ranges for multipart import parts", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=8388608-16777215");
      expect(new Headers(init?.headers).get("Dropbox-API-Arg")).toBe(JSON.stringify({ path: "/client/large.mov" }));
      return new Response(new Uint8Array(8 * 1024 * 1024), { status: 206, headers: {
        "Content-Range": "bytes 8388608-16777215/33554432",
        "Content-Length": String(8 * 1024 * 1024),
      } });
    });
    const client = new DropboxImportClient({ accessToken: "test-token", fetch: fetcher as typeof fetch });
    const response = await client.downloadFile("/client/large.mov", { offset: 8 * 1024 * 1024, length: 8 * 1024 * 1024 });
    expect(response.status).toBe(206);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects an ignored Range response before its body can be buffered", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      status: 200, ok: true, headers: new Headers({ "Content-Length": "104857600" }),
      body: { cancel }, text: vi.fn(),
    } as unknown as Response;
    const client = new DropboxImportClient({ accessToken: "test-token", fetch: vi.fn(async () => response) as typeof fetch });
    await expect(client.downloadFile("rev:immutable", { offset: 0, length: 8 })).rejects.toThrow("dropbox-download-range failed (200)");
    expect(cancel).toHaveBeenCalledOnce();
    expect((response.text as any)).not.toHaveBeenCalled();
  });

  it("rejects mismatched Content-Range and Content-Length headers", async () => {
    const client = new DropboxImportClient({ accessToken: "test-token", fetch: vi.fn(async () => new Response(new Uint8Array(7), {
      status: 206, headers: { "Content-Range": "bytes 0-6/8", "Content-Length": "7" },
    })) as typeof fetch });
    await expect(client.downloadFile("rev:immutable", { offset: 0, length: 8 })).rejects.toThrow("dropbox-download-range failed (206)");
  });

  it("classifies rate limits and provider failures as retryable without exposing provider bodies", async () => {
    const client = new DropboxImportClient({
      accessToken: "test-token",
      fetch: vi.fn(async () => new Response("sensitive provider detail", { status: 429 })) as typeof fetch,
    });
    const error = await client.downloadFile("/client/file.zip").catch(value => value);
    expect(error).toBeInstanceOf(DropboxImportError);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("sensitive provider detail");
  });
});


describe("Dropbox browse credential refresh", () => {
  it("refreshes and persists an expiring access token before browse uses it", async () => {
    const secret = "test-secret-material-at-least-32-chars-long!!";
    const encrypted = await encryptImportSecret(
      { accessToken: "old-access", refreshToken: "refresh-1", expiresAt: "2000-01-01T00:00:00.000Z" },
      secret,
      "authorization:auth-1",
    );
    const updateRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    const db = {
      withSession: () => ({
        prepare: (sql: string) => ({
          bind: (..._values: unknown[]) => sql.startsWith("SELECT")
            ? { first: async () => ({
                credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, key_id: "v1",
                token_expires_at: "2000-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", revoked_at: null,
              }) }
            : { run: updateRun },
        }),
      }),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 14400 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const credential = await loadDropboxImportCredential({
        OPS_DB: db, DROPBOX_CLIENT_ID: "client", DROPBOX_CLIENT_SECRET: "client-secret", DROPBOX_IMPORT_TOKEN_SECRET: secret,
      } as any, "auth-1", "staff-1");
      expect(credential.accessToken).toBe("fresh-access");
      expect(credential.refreshToken).toBe("refresh-1");
      expect(updateRun).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});


describe("Dropbox import routes", () => {
  it("returns a safe, specific capability error before OAuth work starts", async () => {
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("principal", { id: "staff-1" }); c.set("administrator", false); await next(); });
    registerDropboxImportRoutes(app);
    const response = await app.request("/api/dropbox-import/oauth/start", { method: "POST" }, { DROPBOX_IMPORT_ENABLED: "false" });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("currently disabled");
  });

  it("does not accept OAuth callbacks while the integration is unavailable", async () => {
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("principal", { id: "staff-1" }); c.set("administrator", false); await next(); });
    registerDropboxImportRoutes(app);
    const response = await app.request("/api/dropbox-import/oauth/callback?state=x&code=y", {}, { DROPBOX_IMPORT_ENABLED: "true" });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("not configured");
  });
});

describe("Dropbox import multipart lifecycle", () => {
  function dbForStatus(status: string) {
    return {
      withSession: () => ({
        prepare: () => ({ bind: () => ({
          first: async () => ({ status, cancel_requested_at: status === "cancelling" ? "now" : null }),
          run: async () => ({ meta: { changes: 1 } }),
        }) }),
      }),
    };
  }

  const item = {
    id: "item-1", job_id: "job-1", ordinal: 0, dropbox_path: "/large.bin", dropbox_id: "rev:immutable-1",
    destination_key: "Jobs/Clients/large.bin", size: 8, status: "running", attempts: 1,
    downloaded_bytes: 0, uploaded_bytes: 0, r2_etag: null, error_code: null, error_message: null,
  };

  it("aborts multipart state without downloading when cancellation wins the race", async () => {
    const abort = vi.fn(async () => undefined);
    const downloadFile = vi.fn();
    const env = {
      OPS_DB: dbForStatus("cancelling"),
      DATA_BUCKET: {
        head: vi.fn(async () => null),
        delete: vi.fn(async () => undefined),
        createMultipartUpload: vi.fn(async () => ({ uploadPart: vi.fn(), complete: vi.fn(), abort })),
      },
    } as any;
    await expect(importOneFile(env, { downloadFile } as any, item as any, "replace")).rejects.toThrow("cancelled");
    expect(downloadFile).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
  });

  it("aborts an incomplete multipart upload when an R2 part fails", async () => {
    const abort = vi.fn(async () => undefined);
    const env = {
      OPS_DB: dbForStatus("running"),
      DATA_BUCKET: {
        head: vi.fn(async () => null),
        delete: vi.fn(async () => undefined),
        createMultipartUpload: vi.fn(async () => ({
          uploadPart: vi.fn(async () => { throw new Error("r2-part-failed"); }), complete: vi.fn(), abort,
        })),
      },
    } as any;
    const client = { downloadFile: vi.fn(async () => new Response(new Uint8Array(8), { status: 206 })) };
    await expect(importOneFile(env, client as any, item as any, "replace")).rejects.toThrow("r2-part-failed");
    expect(client.downloadFile).toHaveBeenCalledWith("rev:immutable-1", { offset: 0, length: 8 });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("writes an imported MP4 with authoritative video/mp4 object metadata", async () => {
    const stagingKey = "_ltds/dropbox-imports/job-1/item-1";
    let stagingExists = true;
    const complete = vi.fn(async () => ({ etag: "staging-etag", httpEtag: '"staging-etag"' }));
    const createMultipartUpload = vi.fn(async () => ({
      uploadPart: vi.fn(async (partNumber: number) => ({ partNumber, etag: "part-1" })),
      complete,
      abort: vi.fn(),
    }));
    const put = vi.fn(async (_key: string, _body: unknown, _options: any) => ({ httpEtag: '"imported-video"' }));
    const remove = vi.fn(async (key: string) => { if (key === stagingKey) stagingExists = false; });
    const env = {
      OPS_DB: dbForStatus("running"),
      DATA_BUCKET: {
        head: vi.fn(async (key: string) => key === stagingKey && stagingExists ? { key: stagingKey } : null),
        get: vi.fn(async () => ({
          body: new ReadableStream(), httpMetadata: { contentType: "video/mp4" },
          customMetadata: { ltdsDropboxImportItem: item.id },
        })),
        put, delete: remove, createMultipartUpload,
      },
    } as any;
    const videoItem = {
      ...item,
      dropbox_path: "/flight.mp4",
      destination_key: "Jobs/Clients/Acme/Delivery/flight.mp4",
    };
    const client = { downloadFile: vi.fn(async () => new Response(new Uint8Array(8), { status: 206 })) };

    await expect(importOneFile(env, client as any, videoItem as any, "replace"))
      .resolves.toEqual({ r2Etag: '"imported-video"', size: 8 });

    expect(createMultipartUpload).toHaveBeenCalledWith(stagingKey, {
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: { ltdsDropboxImportItem: item.id },
    });
    expect(complete).toHaveBeenCalledWith([{ partNumber: 1, etag: "part-1" }]);
    expect(env.DATA_BUCKET.get).toHaveBeenCalledWith(stagingKey, { onlyIf: { etagMatches: "staging-etag" } });
    expect(put).toHaveBeenCalledOnce();
    const [publishedKey, , publishOptions] = put.mock.calls[0]!;
    expect(publishedKey).toBe(videoItem.destination_key);
    expect(publishOptions.httpMetadata).toEqual({ contentType: "video/mp4" });
    expect(publishOptions.customMetadata).toEqual({ ltdsDropboxImportItem: item.id });
    expect(publishOptions.onlyIf).toBeInstanceOf(Headers);
    expect(publishOptions.onlyIf.get("If-None-Match")).toBe("*");
    expect(remove).toHaveBeenCalledWith(stagingKey);
    expect(stagingExists).toBe(false);
  });

  it("cleans staging and preserves a destination that wins the conditional publish race", async () => {
    const stagingKey = "_ltds/dropbox-imports/job-1/item-1";
    let stagingExists = true;
    const remove = vi.fn(async (key: string) => { if (key === stagingKey) stagingExists = false; });
    const env = {
      OPS_DB: dbForStatus("running"),
      DATA_BUCKET: {
        head: vi.fn(async (key: string) => key === stagingKey && stagingExists ? { key: stagingKey } : null),
        get: vi.fn(async () => ({ body: new ReadableStream(), httpMetadata: {}, customMetadata: {} })),
        put: vi.fn(async () => null),
        delete: remove,
        createMultipartUpload: vi.fn(async () => ({
          uploadPart: vi.fn(async (partNumber: number) => ({ partNumber, etag: "part-1" })),
          complete: vi.fn(async () => ({ etag: "staging-etag", httpEtag: '"staging-etag"' })),
          abort: vi.fn(async () => undefined),
        })),
      },
    } as any;
    const client = { downloadFile: vi.fn(async () => new Response(new Uint8Array(8), { status: 206 })) };

    await expect(importOneFile(env, client as any, item as any, "replace"))
      .rejects.toThrow("destination-changed-before-publication");
    expect(env.DATA_BUCKET.put).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(stagingKey);
    expect(stagingExists).toBe(false);
  });

  it("recognizes its already-published object on retry and removes leftover staging without re-downloading", async () => {
    const stagingKey = "_ltds/dropbox-imports/job-1/item-1";
    let stagingExists = true;
    const published = {
      key: item.destination_key, httpEtag: '"published-etag"', size: item.size,
      customMetadata: { ltdsDropboxImportItem: item.id },
    };
    const remove = vi.fn(async (key: string) => { if (key === stagingKey) stagingExists = false; });
    const env = {
      OPS_DB: dbForStatus("running"),
      DATA_BUCKET: {
        head: vi.fn(async (key: string) => key === item.destination_key ? published :
          key === stagingKey && stagingExists ? { key: stagingKey } : null),
        delete: remove,
        createMultipartUpload: vi.fn(),
      },
    } as any;
    const client = { downloadFile: vi.fn() };

    await expect(importOneFile(env, client as any, item as any, "replace"))
      .resolves.toEqual({ r2Etag: '"published-etag"', size: item.size });
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(env.DATA_BUCKET.createMultipartUpload).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(stagingKey);
    expect(stagingExists).toBe(false);
  });
});


describe("Dropbox import multipart sizing", () => {
  it("keeps a 500 GiB import within the R2 10,000-part limit", () => {
    const size = 500 * 1024 ** 3;
    const partSize = dropboxImportPartSize(size);
    expect(Math.ceil(size / partSize)).toBeLessThanOrEqual(9_999);
    expect(partSize).toBeGreaterThanOrEqual(8 * 1024 ** 2);
    expect(partSize).toBeLessThanOrEqual(5 * 1024 ** 3);
  });

  it("retains the 8 MiB floor for ordinary files", () => {
    expect(dropboxImportPartSize(100 * 1024 ** 2)).toBe(8 * 1024 ** 2);
  });
});


describe("Dropbox authorization revocation", () => {
  async function revocationFixture() {
    const secret = "test-secret-material-at-least-32-chars-long!!";
    const encrypted = await encryptImportSecret({ accessToken: "access-1", refreshToken: "refresh-1" }, secret, "authorization:auth-1");
    const clearRun = vi.fn(async () => ({ meta: { changes: 1 } }));
    const db = { withSession: () => ({ prepare: (sql: string) => ({ bind: (..._values: unknown[]) => sql.startsWith("SELECT")
      ? { first: async () => ({ credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv, key_id: "v1", token_expires_at: null, expires_at: "2000-01-01", revoked_at: null }) }
      : { run: clearRun } }) }) };
    return { env: { OPS_DB: db, DROPBOX_IMPORT_TOKEN_SECRET: secret } as any, clearRun };
  }

  it("retains encrypted credentials when provider revocation fails", async () => {
    const { env, clearRun } = await revocationFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    try {
      await expect(revokeDropboxImportAuthorization(env, "auth-1", "staff-1")).rejects.toThrow("dropbox-token-revoke failed (503)");
      expect(clearRun).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("clears local credentials only after provider revocation succeeds", async () => {
    const { env, clearRun } = await revocationFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    try {
      await revokeDropboxImportAuthorization(env, "auth-1", "staff-1");
      expect(clearRun).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});
