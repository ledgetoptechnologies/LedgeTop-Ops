const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3,9})Z$/u;

/** Validate a UTC RFC3339 timestamp while retaining the provider's precision.
 * JavaScript Date stores milliseconds, so compare only its exact millisecond
 * projection and separately report whether sub-millisecond digits were lost. */
export function parseProviderUtcTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const fraction = match[2], milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const millisecondProjection = `${match[1]}.${fraction.slice(0, 3)}Z`;
  if (new Date(milliseconds).toISOString() !== millisecondProjection) return null;
  return Object.freeze({ milliseconds, hasSubMillisecond: fraction.length > 3 && /[1-9]/u.test(fraction.slice(3)) });
}

export function isProviderUtcTimestamp(value) {
  return parseProviderUtcTimestamp(value) !== null;
}

/** Return the earliest millisecond-precision instant not earlier than the
 * requested retention duration after the provider's exact timestamp. */
export function minimumRetainedUntil(value, hours = 48) {
  const parsed = parseProviderUtcTimestamp(value);
  if (!parsed || !Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 365) throw Error('Invalid retention timestamp or duration');
  return new Date(parsed.milliseconds + hours * 60 * 60 * 1000 + (parsed.hasSubMillisecond ? 1 : 0)).toISOString();
}
