import type { Env } from "./types";

function exactOrigin(value: string, label: string, requireHttps: boolean): string {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
      throw new Error();
    if (requireHttps && url.protocol !== "https:") throw new Error();
    return url.origin;
  } catch {
    throw new Error(`${label} must be an exact${requireHttps ? " HTTPS" : ""} origin`);
  }
}

export function publicShareOrigin(env: Pick<Env, "PUBLIC_SHARE_ORIGIN" | "ENVIRONMENT">): string {
  return exactOrigin(
    env.PUBLIC_SHARE_ORIGIN,
    "PUBLIC_SHARE_ORIGIN",
    env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging",
  );
}
