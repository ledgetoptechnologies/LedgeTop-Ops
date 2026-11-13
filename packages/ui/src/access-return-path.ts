const RETURN_ORIGIN = "https://access-return.invalid";

/** Keep post-logout navigation on this site. URL parsing strips tabs/newlines
 * and treats backslashes as slashes, so a leading-slash regex alone is unsafe. */
export function safeAccessReturnPath(value: unknown): string {
  if (typeof value !== "string" || !/^\/(?![/\\])/.test(value)
    || /[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  try {
    const url = new URL(value, RETURN_ORIGIN);
    return url.origin === RETURN_ORIGIN ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}
