const GOOGLE_ADS_INT63_MAX = 9_223_372_036_854_775_807n;

/** Validate the non-negative decimal integer range used by the signed Ads feed. */
export function isGoogleAdsInt63(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= GOOGLE_ADS_INT63_MAX;
}

/** Group an integer decimal string without converting it through a lossy Number. */
export function formatGoogleAdsWhole(value: string, locale?: string): string {
  if (!isGoogleAdsInt63(value)) throw new TypeError("Expected a non-negative signed int63 decimal string.");
  return new Intl.NumberFormat(locale).format(BigInt(value));
}

/** Round micros once to the currency's native minor unit and format without Number conversion. */
export function formatGoogleAdsCostMicros(micros: string, currency: string, locale?: string): string {
  if (!isGoogleAdsInt63(micros)) throw new TypeError("Expected a non-negative signed int63 decimal string.");
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  if (digits > 6) throw new RangeError("Currency precision exceeds the micros source precision.");

  const scale = 10n ** BigInt(digits);
  const microsPerMinorUnit = 10n ** BigInt(6 - digits);
  const minorUnits = (BigInt(micros) + microsPerMinorUnit / 2n) / microsPerMinorUnit;
  const whole = minorUnits / scale;
  const fraction = minorUnits % scale;
  const parts = formatter.formatToParts(whole).map(part => {
    if (part.type !== "fraction") return part;
    const fractionFormatter = new Intl.NumberFormat(locale, {
      useGrouping: false,
      maximumFractionDigits: 0,
      minimumIntegerDigits: digits,
    });
    return { ...part, value: fractionFormatter.format(fraction) };
  });
  return parts.map(part => part.value).join("");
}

/** Localize grouping and the decimal separator while retaining every source decimal digit. */
export function formatGoogleAdsConversions(value: string, locale?: string): string {
  const match = /^(0|[1-9][0-9]{0,14})(?:\.([0-9]{1,6}))?$/.exec(value);
  if (!match) throw new TypeError("Expected a Google Ads conversion decimal string.");
  const [, integer, fraction] = match;
  const integerText = new Intl.NumberFormat(locale).format(BigInt(integer!));
  if (fraction === undefined) return integerText;

  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === "decimal")?.value;
  if (!decimal) throw new RangeError("The selected locale has no decimal separator.");
  const fractionText = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0,
    minimumIntegerDigits: fraction.length }).format(BigInt(fraction));
  return `${integerText}${decimal}${fractionText}`;
}
