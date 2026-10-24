/** "2d 4h 13m", "4h 13m", "13m", or "Less than a minute": the time left on a sign-in, without seconds. */
export function formatSessionRemaining(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return milliseconds > 0 ? "Less than a minute" : "0m";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return [days ? `${days}d` : "", days || hours ? `${hours}h` : "", `${rest}m`].filter(Boolean).join(" ");
}

/** "Fri, Oct 24, 3:30 PM" in the viewer's own time zone. */
export function formatSessionExpiry(epochMilliseconds: number, locale?: string | string[]): string {
  return new Date(epochMilliseconds).toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
