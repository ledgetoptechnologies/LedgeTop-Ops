/**
 * R2's S3 UploadPart response exposes an HTTP ETag with quotes, while the
 * Workers R2 binding expects the unquoted R2UploadedPart value at completion.
 */
export function canonicalMultipartEtag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  return /^[a-f0-9]{32}$/i.test(unquoted) ? unquoted.toLowerCase() : null;
}
