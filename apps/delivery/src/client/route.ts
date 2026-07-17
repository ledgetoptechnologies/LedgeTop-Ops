export function parseDeliveryRoute(pathname: string, hash: string): { publicId: string; secret: string } {
  const segments = pathname.split("/").filter(Boolean);
  const publicId = segments.length === 2 && segments[0] === "s" ? segments[1] || "" : "";
  if (!publicId) return { publicId: "", secret: "" };
  let fragment = "";
  if (hash.startsWith("#") && hash.length > 1) {
    try { fragment = decodeURIComponent(hash.slice(1)); } catch { fragment = ""; }
  }
  return { publicId, secret: fragment || (publicId.length > 30 ? publicId : "") };
}
