export type RecognizedDeploymentEnvironment = "staging" | "production";

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.startsWith("127.") || hostname === "0.0.0.0" || hostname === "[::1]";
}

/** Returns only an exact, configured HTTPS origin for a recognized deployment. */
export function configuredDeploymentOrigin(input: Readonly<{
  environment: string;
  origin: string | undefined;
  expectedHost: string | undefined;
}>): string | null {
  if (input.environment !== "staging" && input.environment !== "production") return null;
  if (!input.origin || !input.expectedHost || input.expectedHost !== input.expectedHost.toLowerCase()) return null;
  try {
    const url = new URL(input.origin);
    if (url.protocol !== "https:" || url.origin !== input.origin || url.pathname !== "/"
      || url.search || url.hash || url.username || url.password || url.port
      || url.hostname !== input.expectedHost
      || url.hostname.endsWith(".")
      || input.environment === "production" && isLocalHostname(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}
