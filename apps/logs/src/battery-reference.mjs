/** Shared browser/service canonical display reference. The label adds exactly one "Battery " prefix. */
export function normalizeBatteryReference(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError('Use a battery reference name of up to 40 characters.');
  const text = value.normalize('NFKC');
  // Reject control/format characters before whitespace collapsing; spaces and typographic spaces are allowed.
  if (/[\p{Cc}\p{Cf}]/u.test(text)) throw new TypeError('Use a battery reference name without control characters.');
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (!collapsed) return null;
  const reference = collapsed.replace(/^(?:battery\s*)+/i, '').trim();
  if (!reference || reference.length > 40 || reference.toLowerCase().length > 40)
    throw new TypeError('Use a battery reference name of 1 to 40 characters after the optional Battery prefix.');
  return reference;
}
