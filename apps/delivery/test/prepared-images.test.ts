import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { preparedKey } from "../src/worker/artifacts";
import {
  type PreparedImageBucket,
  type PreparedImageDatabase,
  servePreparedImage,
} from "../src/worker/prepared-images";

const SOURCE_KEY = "jobs/2026/Hemp For Horses/photo.jpg";

interface Registration {
  source_etag: string;
  manifest_etag: string;
  derivative_etags_json: string;
}

interface ObjectMetadata {
  size: number;
  etag: string;
  httpEtag: string;
}

interface FixtureOptions {
  registration?: Registration | null;
  sourceEtag?: string;
  manifestEtag?: string;
  derivativeEtag?: string;
  derivativeSize?: number;
  bodySize?: number;
  bodyAvailable?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const prefix = (await preparedKey(SOURCE_KEY, "thumb")).replace(/thumb\.webp$/, "");
  const derivativeKey = await preparedKey(SOURCE_KEY, "preview");
  const sourceEtag = options.sourceEtag ?? "source-etag";
  const manifestEtag = options.manifestEtag ?? "manifest-etag";
  const derivativeEtag = options.derivativeEtag ?? "preview-etag";
  const derivativeSize = options.derivativeSize ?? 7;
  const bodySize = options.bodySize ?? derivativeSize;
  const registration = options.registration === undefined
    ? {
      source_etag: "\"source-etag\"",
      manifest_etag: "\"manifest-etag\"",
      derivative_etags_json: JSON.stringify({ preview: "\"preview-etag\"" }),
    }
    : options.registration;
  const metadata = (etag: string, size: number): ObjectMetadata => ({
    size,
    etag,
    httpEtag: `"${etag}"`,
  });
  const source = metadata(sourceEtag, 1_000);
  const manifest = metadata(manifestEtag, 200);
  const derivative = metadata(derivativeEtag, derivativeSize);
  const get = vi.fn(async (
    key: string,
    getOptions: { onlyIf: { etagMatches: string } },
  ) => {
    if (key !== derivativeKey || getOptions.onlyIf.etagMatches !== derivative.etag) {
      return derivative;
    }
    if (options.bodyAvailable === false) return derivative;
    return {
      ...derivative,
      size: bodySize,
      body: new Blob(["preview"]).stream(),
    };
  });
  const bucket: PreparedImageBucket = {
    async head(key) {
      if (key === SOURCE_KEY) return source;
      if (key === `${prefix}manifest.json`) return manifest;
      if (key === derivativeKey) return derivative;
      return null;
    },
    get,
  };
  const bind = vi.fn();
  const first = vi.fn();
  const prepare = vi.fn();
  const statement = {
    bind(...values: unknown[]) {
      bind(...values);
      return statement;
    },
    async first<T>() {
      first();
      return registration as T | null;
    },
  };
  const database: PreparedImageDatabase = {
    prepare(query) {
      prepare(query);
      return statement;
    },
  };
  return { bucket, database, derivative, derivativeKey, get, bind, prepare };
}

async function expectUnavailable(promise: Promise<Response>): Promise<void> {
  try {
    await promise;
    throw new Error("Expected prepared preview to be unavailable");
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException);
    expect(error).toMatchObject({ status: 404, message: "Prepared preview unavailable" });
  }
}

describe("prepared delivery images", () => {
  it("uses the live derivative's unquoted R2 ETag for the conditional body read", async () => {
    const test = await fixture();

    const response = await servePreparedImage({
      bucket: test.bucket,
      database: test.database,
    }, SOURCE_KEY, "preview");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("ETag")).toBe("\"preview-etag\"");
    expect(response.headers.get("Content-Length")).toBe("7");
    await expect(response.text()).resolves.toBe("preview");
    expect(test.get).toHaveBeenCalledWith(test.derivativeKey, {
      onlyIf: { etagMatches: "preview-etag" },
    });
    expect(test.bind).toHaveBeenCalledWith(
      test.derivativeKey.replace(/preview\.webp$/, ""),
      SOURCE_KEY,
    );
  });

  it("returns 304 with the registered response headers without reading the body", async () => {
    const test = await fixture();

    const response = await servePreparedImage({
      bucket: test.bucket,
      database: test.database,
      ifNoneMatch: "W/\"preview-etag\"",
    }, SOURCE_KEY, "preview");

    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe("\"preview-etag\"");
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.has("Content-Length")).toBe(false);
    expect(test.get).not.toHaveBeenCalled();
  });

  it.each([
    ["source", { sourceEtag: "changed-source" }],
    ["manifest", { manifestEtag: "changed-manifest" }],
    ["derivative", { derivativeEtag: "changed-preview" }],
  ] satisfies Array<[string, FixtureOptions]>)(
    "rejects a stale %s identity",
    async (_identity, options) => {
      const test = await fixture(options);
      await expectUnavailable(servePreparedImage({
        bucket: test.bucket,
        database: test.database,
      }, SOURCE_KEY, "preview"));
      expect(test.get).not.toHaveBeenCalled();
    },
  );

  it("rejects missing registrations and malformed registered derivative identities", async () => {
    const missing = await fixture({ registration: null });
    await expectUnavailable(servePreparedImage({
      bucket: missing.bucket,
      database: missing.database,
    }, SOURCE_KEY, "preview"));

    const malformed = await fixture({
      registration: {
        source_etag: "\"source-etag\"",
        manifest_etag: "\"manifest-etag\"",
        derivative_etags_json: "not-json",
      },
    });
    await expectUnavailable(servePreparedImage({
      bucket: malformed.bucket,
      database: malformed.database,
    }, SOURCE_KEY, "preview"));
    expect(missing.get).not.toHaveBeenCalled();
    expect(malformed.get).not.toHaveBeenCalled();
  });

  it("rejects metadata-only conditional reads and oversized derivatives", async () => {
    const metadataOnly = await fixture({ bodyAvailable: false });
    await expectUnavailable(servePreparedImage({
      bucket: metadataOnly.bucket,
      database: metadataOnly.database,
    }, SOURCE_KEY, "preview"));

    const oversizedHead = await fixture({ derivativeSize: 512_001 });
    await expectUnavailable(servePreparedImage({
      bucket: oversizedHead.bucket,
      database: oversizedHead.database,
    }, SOURCE_KEY, "preview"));
    expect(oversizedHead.get).not.toHaveBeenCalled();

    const oversizedBody = await fixture({ bodySize: 512_001 });
    await expectUnavailable(servePreparedImage({
      bucket: oversizedBody.bucket,
      database: oversizedBody.database,
    }, SOURCE_KEY, "preview"));
  });
});
