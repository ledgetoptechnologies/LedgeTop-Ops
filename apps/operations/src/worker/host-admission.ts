import type { Env } from "./types";

export function requestHostAllowed(
  requestUrl: string,
  env: Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST">,
): boolean {
  if (env.ENVIRONMENT !== "production" && env.ENVIRONMENT !== "staging") return true;
  try {
    return new URL(requestUrl).host === env.EXPECTED_HOST;
  } catch {
    return false;
  }
}
