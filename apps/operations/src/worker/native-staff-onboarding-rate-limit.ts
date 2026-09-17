/** Shared primary-database quota, not an isolate-local best-effort counter.
 * Keys are domain-separated keyed digests produced by the trusted HTTP adapter. */
export async function consumeNativeStaffOnboardingRateLimit(
  database: D1Database, key: string, limit: number, periodSeconds: number,
): Promise<boolean> {
  if (!/^(ip|subject):[A-Za-z0-9_-]{43}$/.test(key)
    || !Number.isInteger(limit) || limit < 1 || limit > 120 || periodSeconds !== 60)
    throw new Error("native_staff_onboarding_rate_limit_unavailable");
  try {
    const result = await database.withSession("first-primary").prepare(`
      INSERT INTO native_staff_onboarding_rate_limits
        (rate_key,window_bucket,request_count,request_limit)
      VALUES (?,CAST(unixepoch('now') / 60 AS INTEGER),1,?)
      ON CONFLICT(rate_key) DO UPDATE SET
        window_bucket=excluded.window_bucket,
        request_count=CASE WHEN native_staff_onboarding_rate_limits.window_bucket < excluded.window_bucket
          THEN 1 ELSE native_staff_onboarding_rate_limits.request_count+1 END,
        request_limit=excluded.request_limit
      WHERE native_staff_onboarding_rate_limits.window_bucket < excluded.window_bucket
        OR (native_staff_onboarding_rate_limits.window_bucket=excluded.window_bucket
          AND native_staff_onboarding_rate_limits.request_limit=excluded.request_limit
          AND native_staff_onboarding_rate_limits.request_count < excluded.request_limit)
    `).bind(key, limit).run();
    if (result.success !== true || ![0, 1].includes(result.meta.changes)) throw new Error();
    return result.meta.changes === 1;
  } catch {
    throw new Error("native_staff_onboarding_rate_limit_unavailable");
  }
}

/** Prune only this feature's expired operational counters, never onboarding
 * evidence, staff records, files or retention policies. Current quotas remain. */
export async function pruneNativeStaffOnboardingRateLimits(database: D1Database): Promise<number> {
  const result = await database.withSession("first-primary").prepare(`
    DELETE FROM native_staff_onboarding_rate_limits WHERE rate_key IN (
      SELECT rate_key FROM native_staff_onboarding_rate_limits
      WHERE window_bucket < CAST(unixepoch('now') / 60 AS INTEGER)-1440
      ORDER BY window_bucket,rate_key LIMIT 500
    )
  `).run();
  if (result.success !== true || !Number.isInteger(result.meta.changes)
    || result.meta.changes < 0 || result.meta.changes > 500)
    throw new Error("native_staff_onboarding_rate_limit_cleanup_failed");
  return result.meta.changes;
}
