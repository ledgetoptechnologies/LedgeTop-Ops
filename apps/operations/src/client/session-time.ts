export function readSessionTiming(value: unknown, expectedUserId: string) {
  if (!value || typeof value !== "object") throw new Error("Invalid session status");
  const data = value as Record<string, unknown>;
  if (data.userId !== expectedUserId || typeof data.serverTime !== "string"
    || !(data.expiresAt === null || typeof data.expiresAt === "string"))
    throw new Error("Invalid session status");
  const serverTime = Date.parse(data.serverTime);
  const expiresAt = data.expiresAt === null ? null : Date.parse(data.expiresAt);
  if (!Number.isFinite(serverTime) || expiresAt !== null && !Number.isFinite(expiresAt))
    throw new Error("Invalid session status");
  return { serverTime, expiresAt };
}

export { formatSessionRemaining } from "@ltds/ui";
