import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { artifactDirectory } from "../src/worker/artifacts";
import { servePreparedArtifact, type PreparedArtifactVariant } from "../src/worker/prepared-artifact";

type StoredObject = {
  size: number;
  etag: string;
  httpEtag: string;
  body?: Uint8Array;
};

async function fixture(variant: PreparedArtifactVariant = "preview") {
  const sourceKey = "Jobs/Clients/Acme/Edited/photo.jpg";
  const prefix = await artifactDirectory(sourceKey);
  const derivativeKey = `${prefix}${variant}.webp`;
  const stored = new Map<string, StoredObject>([
    [sourceKey, { size: 2_000, etag: "source-etag", httpEtag: "\"source-etag\"" }],
    [`${prefix}manifest.json`, { size: 500, etag: "manifest-etag", httpEtag: "\"manifest-etag\"" }],
    [derivativeKey, { size: 4, etag: "preview-etag", httpEtag: "\"preview-etag\"", body: new Uint8Array([1, 2, 3, 4]) }],
  ]);
  const registration = {
    source_etag: "\"source-etag\"",
    manifest_etag: "\"manifest-etag\"",
    derivative_etags_json: JSON.stringify({ [variant]: "\"preview-etag\"" }),
  };
  const gets: Array<{ key: string; options: unknown }> = [];
  const statement = {
    bind(...values: unknown[]) {
      expect(values).toEqual([prefix, sourceKey]);
      return statement;
    },
    async first() {
      return registration;
    },
  };
  const env: any = {
    DATA_BUCKET: {
      async head(key: string) {
        return stored.get(key) ?? null;
      },
      async get(key: string, options: { onlyIf?: { etagMatches?: string } }) {
        gets.push({ key, options });
        const object = stored.get(key);
        if (!object || options.onlyIf?.etagMatches !== object.etag || !object.body) {
          if (!object) return null;
          const { body: _body, ...metadata } = object;
          return metadata;
        }
        return object;
      },
    },
    DELIVERY_DB: {
      withSession(bookmark: string) {
        expect(bookmark).toBe("first-primary");
        return { prepare: () => statement };
      },
    },
  };
  return { env, sourceKey, prefix, derivativeKey, stored, registration, gets };
}

async function expectUnavailable(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ status: 404, message: "Prepared preview unavailable" } satisfies Partial<HTTPException>);
}

describe("Operations prepared artifact serving", () => {
  it("uses the live R2 object's unquoted etag for the conditional body read", async () => {
    const { env, sourceKey, derivativeKey, gets } = await fixture();

    const response = await servePreparedArtifact(env, sourceKey, "preview");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("ETag")).toBe("\"preview-etag\"");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(gets).toEqual([{ key: derivativeKey, options: { onlyIf: { etagMatches: "preview-etag" } } }]);
  });

  it("returns 304 without reading the body when the request ETag matches", async () => {
    const { env, sourceKey, gets } = await fixture("thumb");

    const response = await servePreparedArtifact(env, sourceKey, "thumb", "W/\"preview-etag\"");

    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe("\"preview-etag\"");
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(gets).toEqual([]);
  });

  it("rejects stale source, manifest, and derivative registrations before reading a body", async () => {
    for (const mismatch of ["source", "manifest", "derivative"] as const) {
      const { env, sourceKey, registration, gets } = await fixture();
      if (mismatch === "source") registration.source_etag = "\"stale-source\"";
      if (mismatch === "manifest") registration.manifest_etag = "\"stale-manifest\"";
      if (mismatch === "derivative") registration.derivative_etags_json = JSON.stringify({ preview: "\"stale-preview\"" });

      await expectUnavailable(servePreparedArtifact(env, sourceKey, "preview"));
      expect(gets, mismatch).toEqual([]);
    }
  });

  it("rejects missing body reads even when metadata remains valid", async () => {
    const { env, sourceKey, derivativeKey, stored, gets } = await fixture();
    stored.get(derivativeKey)!.body = undefined;

    await expectUnavailable(servePreparedArtifact(env, sourceKey, "preview"));

    expect(gets).toEqual([{ key: derivativeKey, options: { onlyIf: { etagMatches: "preview-etag" } } }]);
  });

  it("enforces derivative size bounds for previews and thumbnails", async () => {
    for (const [variant, size] of [["preview", 512_001], ["thumb", 100 * 1024 + 1]] as const) {
      const { env, sourceKey, derivativeKey, stored, gets } = await fixture(variant);
      stored.get(derivativeKey)!.size = size;

      await expectUnavailable(servePreparedArtifact(env, sourceKey, variant));
      expect(gets, variant).toEqual([]);
    }
  });
});
