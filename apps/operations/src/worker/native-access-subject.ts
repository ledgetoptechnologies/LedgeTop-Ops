/** Verified identity subjects are opaque, not resource identifiers. Never
 * normalize them or infer identity from their shape. Admission stores the exact
 * value; this shared bound keeps native login and directory policy consistent. */
export function isNativeAccessSubject(value: unknown): value is string {
  return typeof value === "string" && value.length <= 382 && value.trim().length > 0
    && Array.from(value).length <= 191 && !/\p{C}/u.test(value)
    && new TextEncoder().encode(value).byteLength <= 764;
}
