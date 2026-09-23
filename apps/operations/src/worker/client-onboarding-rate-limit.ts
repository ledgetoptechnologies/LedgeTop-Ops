const RATE_KEY = /^client-onboarding:(?:ip|invitation):[0-9a-f]{64}$/;
const unavailable = (): never => { throw Error("client_onboarding_rate_limit_unavailable"); };
const cleanupFailed = (): never => { throw Error("client_onboarding_rate_limit_cleanup_failed"); };
function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function changes(result: unknown, maximum: number): number | null {
  if (ownData(result, "success") !== true) return null;
  const count = ownData(ownData(result, "meta"), "changes");
  return typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= maximum ? count : null;
}
export async function consumeClientOnboardingRateLimit(database: D1Database, key: string,
  limit: number, periodSeconds: number): Promise<boolean> {
  if (typeof key !== "string" || (key.length !== 85 && key.length !== 93) || !RATE_KEY.test(key)
    || !Number.isInteger(limit) || limit < 1 || limit > 120 || periodSeconds !== 60) return unavailable();
  try {
    const result: unknown = await database.withSession("first-primary").prepare(`
      INSERT INTO client_onboarding_rate_limits(rate_key,window_bucket,request_count,request_limit)
      VALUES(?,CAST(unixepoch('now')/60 AS INTEGER),1,?)
      ON CONFLICT(rate_key) DO UPDATE SET window_bucket=excluded.window_bucket,
        request_count=CASE WHEN client_onboarding_rate_limits.window_bucket<excluded.window_bucket
          THEN 1 ELSE client_onboarding_rate_limits.request_count+1 END, request_limit=excluded.request_limit
      WHERE client_onboarding_rate_limits.window_bucket<excluded.window_bucket
        OR (client_onboarding_rate_limits.window_bucket=excluded.window_bucket
          AND client_onboarding_rate_limits.request_limit=excluded.request_limit
          AND client_onboarding_rate_limits.request_count<excluded.request_limit)`).bind(key, limit).run();
    const count = changes(result, 1);
    if (count === null) return unavailable();
    return count === 1;
  } catch { return unavailable(); }
}
export async function pruneClientOnboardingRateLimits(database: D1Database): Promise<number> {
  try {
    const result: unknown = await database.withSession("first-primary").prepare(`
      DELETE FROM client_onboarding_rate_limits WHERE rate_key IN (
        SELECT rate_key FROM client_onboarding_rate_limits
        WHERE window_bucket<CAST(unixepoch('now')/60 AS INTEGER)-1440
        ORDER BY window_bucket,rate_key LIMIT 500)`).run();
    const count = changes(result, 500);
    if (count === null) return cleanupFailed();
    return count;
  } catch { return cleanupFailed(); }
}
