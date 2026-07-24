const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function previewIdentity(sourceKey: string): Promise<string> {
  const normalized = sourceKey.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const leaf = normalized.split("/").pop()?.normalize("NFC") || "";
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(leaf)));
}

export async function artifactDirectory(sourceKey: string): Promise<string> {
  const clean = sourceKey.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const slash = clean.lastIndexOf("/");
  const parent = slash < 0 ? "" : clean.slice(0, slash + 1);
  return `${parent}.previews/${await previewIdentity(clean)}/`;
}

export async function artifactKey(sourceKey: string, variant: "thumb" | "preview" | "poster" | "manifest"): Promise<string> {
  return `${await artifactDirectory(sourceKey)}${variant === "manifest" ? "manifest.json" : `${variant}.webp`}`;
}
