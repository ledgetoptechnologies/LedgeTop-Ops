import { sha256Hex } from "./security";

export function normalizedSourceFilename(sourceKey: string): string {
  const normalizedPath = sourceKey.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  return (normalizedPath.split("/").pop() || normalizedPath).normalize("NFC");
}

export async function preparedKey(sourceKey: string, variant: "thumb" | "preview" | "poster"): Promise<string> {
  const normalizedPath = sourceKey.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const directory = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : "";
  return `${directory ? `${directory}/` : ""}_ltds/previews/${await sha256Hex(normalizedSourceFilename(sourceKey))}/${variant}.webp`;
}
