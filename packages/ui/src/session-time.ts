/** "2d 4h 13m", "4h 13m", "13m", or "Less than a minute": the time left on a sign-in, without seconds. */
export function formatSessionRemaining(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return milliseconds > 0 ? "Less than a minute" : "0m";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return [days ? `${days}d` : "", days || hours ? `${hours}h` : "", `${rest}m`].filter(Boolean).join(" ");
}

/** "Wed, Oct 28, 2026": the calendar day a sign-in ends, in Ledge Top's own time zone (America/Chicago). */
export function formatSessionExpiry(epochMilliseconds: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", year: "numeric" })
    .format(new Date(epochMilliseconds));
}
