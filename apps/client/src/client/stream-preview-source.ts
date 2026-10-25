/** Retain the server-issued signed path while enabling the visible Cloudflare player. */
export function streamPreviewSource(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflarestream.com") || !url.pathname.endsWith("/iframe")) return value;
    url.searchParams.set("controls", "true");
    url.searchParams.set("autoplay", "true");
    url.searchParams.set("muted", "true");
    return url.href;
  } catch { return value; }
}
