const RETURN_ORIGIN = "https://access-return.invalid";

/** Keep post-logout navigation on this site. URL parsing strips tabs/newlines
 * and treats backslashes as slashes, so a leading-slash regex alone is unsafe. */
export function safeAccessReturnPath(value: unknown): string {
  if (typeof value !== "string" || !/^\/(?![/\\])/.test(value)
    || /[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  try {
    const url = new URL(value, RETURN_ORIGIN);
    // Dot-segment normalization can produce //host from /..//host. The
    // serialized path will be parsed again by location.replace, so fence it too.
    return url.origin === RETURN_ORIGIN && !url.pathname.startsWith("//")
      ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}
