import { describe, expect, it } from "vitest";
import { formatGoogleAdsConversions, formatGoogleAdsCostMicros, formatGoogleAdsWhole, isGoogleAdsInt63 } from "../src/client/intel-format";

describe("Google Ads exact decimal formatting", () => {
  it("rounds integer micros once at zero-, two-, and three-digit currency precision", () => {
    expect(formatGoogleAdsCostMicros("1499000", "JPY", "en-US")).toBe("¥1");
    expect(formatGoogleAdsCostMicros("1234567", "KWD", "en-US")).toBe("KWD 1.235");
    expect(formatGoogleAdsCostMicros("1234565000", "USD", "en-US")).toBe("$1,234.57");
  });

  it("keeps large minor-unit amounts exact beyond Number's safe integer range", () => {
    expect(formatGoogleAdsCostMicros("9223372036854775807", "KWD", "en-US"))
      .toBe("KWD 9,223,372,036,854.776");
    expect(formatGoogleAdsWhole("9223372036854775807", "en-US")).toBe("9,223,372,036,854,775,807");
  });

  it("groups decimal conversions without losing any of their six fractional digits", () => {
    expect(formatGoogleAdsConversions("1.234567", "en-US")).toBe("1.234567");
    expect(formatGoogleAdsConversions("900719925474099.123456", "en-US"))
      .toBe("900,719,925,474,099.123456");
    expect(formatGoogleAdsConversions("1200", "en-US")).toBe("1,200");
  });

  it("accepts only non-negative signed-int63 decimal values", () => {
    expect(isGoogleAdsInt63("0")).toBe(true);
    expect(isGoogleAdsInt63("9223372036854775807")).toBe(true);
    expect(isGoogleAdsInt63("9223372036854775808")).toBe(false);
    expect(isGoogleAdsInt63("099")).toBe(false);
    expect(isGoogleAdsInt63(12)).toBe(false);
  });
});
