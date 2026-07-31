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

export interface DeliverySessionResult {
  publicId: string;
  canonicalPath: string;
}

export async function openDeliveryRoute(
  route: { publicId: string; secret: string; accessCode?: string },
  dependencies: {
    createSession: (route: { publicId: string; secret: string; accessCode?: string }) => Promise<DeliverySessionResult>;
    loadManifest: (publicId: string) => Promise<void>;
  },
): Promise<DeliverySessionResult | null> {
  if (!route.secret) {
    await dependencies.loadManifest(route.publicId);
    return null;
  }

  const session = await dependencies.createSession(route);
  await dependencies.loadManifest(session.publicId);
  return session;
}
