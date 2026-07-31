import { describe, expect, it } from "vitest";
import { canonicalMultipartEtag } from "../src/worker/multipart-etag";

describe("multipart ETag normalization", () => {
  it("accepts the quoted S3 response and unquoted Workers binding form", () => {
    const etag = "0123456789abcdef0123456789abcdef";
    expect(canonicalMultipartEtag(etag)).toBe(etag);
    expect(canonicalMultipartEtag(`"${etag.toUpperCase()}"`)).toBe(etag);
  });

  it("rejects malformed, weak, nested, and non-MD5 part ETags", () => {
    expect(canonicalMultipartEtag("")).toBeNull();
    expect(canonicalMultipartEtag('"abc"')).toBeNull();
    expect(canonicalMultipartEtag('""0123456789abcdef0123456789abcdef""')).toBeNull();
    expect(canonicalMultipartEtag('W/"0123456789abcdef0123456789abcdef"')).toBeNull();
    expect(canonicalMultipartEtag("g123456789abcdef0123456789abcdef")).toBeNull();
  });
});
