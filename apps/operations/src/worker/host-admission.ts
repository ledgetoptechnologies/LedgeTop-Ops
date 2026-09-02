import type { Env } from "./types";

export function requestHostAllowed(
  requestUrl: string,
  env: Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "OPERATIONS_ORIGINS">,
): boolean {
  if (env.ENVIRONMENT !== "production" && env.ENVIRONMENT !== "staging") return true;
  try {
    const request = new URL(requestUrl);
    const configured = env.OPERATIONS_ORIGINS
      ? env.OPERATIONS_ORIGINS.split(",").map(value => value.trim())
      : [`https://${env.EXPECTED_HOST}`];
    if (!configured.length || configured.length > 4 || configured.some(value => !value)) return false;
    const origins = configured.map(value => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("invalid-origin");
      return url.origin;
    });
    if (new Set(origins).size !== origins.length || !origins.includes(`https://${env.EXPECTED_HOST}`)) return false;
    return origins.includes(request.origin);
  } catch {
    return false;
  }
}
