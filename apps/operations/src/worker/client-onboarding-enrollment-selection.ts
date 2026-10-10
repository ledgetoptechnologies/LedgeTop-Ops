const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SOURCES = 16;

/**
 * Validates the only caller-owned portion of a future onboarding enrollment.
 * It returns a new canonical list; destination identity remains server-owned.
 */
export function parseClientOnboardingEnrollmentSourceIds(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (typeof length !== "number" || !Number.isInteger(length) || length > MAX_SOURCES) return null;
    const canonical: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      const sourceId: unknown = descriptor.value;
      if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) return null;
      canonical.push(sourceId);
    }
    canonical.sort();
    return new Set(canonical).size === canonical.length ? Object.freeze(canonical) : null;
  } catch { return null; }
}
