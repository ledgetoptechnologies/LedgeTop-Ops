import { describe, expect, it } from "vitest";
import {
  confidenceBand, confidenceText, decimalMicros, evidenceText, moneyText, percentText, scoreMeaning, scoreNumber,
} from "../../../packages/shared/src/competitor-intel";

describe("competitor intel display rules", () => {
  it("parses exact decimals without float rounding", () => {
    expect(decimalMicros("0.795")).toBe(795_000n);
    expect(decimalMicros("10.00")).toBe(10_000_000n);
    expect(decimalMicros("-1.5")).toBe(-1_500_000n);
    for (const bad of ["", "1.", ".5", "1e3", "0.1234567", "+1", " 1"]) expect(() => decimalMicros(bad)).toThrow();
  });

  it("uses the frozen half-open confidence bands", () => {
    expect(confidenceBand("0.00")).toBe("low");
    expect(confidenceBand("0.499999")).toBe("low");
    expect(confidenceBand("0.50")).toBe("medium");
    expect(confidenceBand("0.795")).toBe("medium");
    expect(confidenceBand("0.799999")).toBe("medium");
    expect(confidenceBand("0.80")).toBe("high");
    expect(confidenceBand("1.00")).toBe("high");
    expect(confidenceBand(null)).toBeNull();
    expect(confidenceText(null)).toBe("Confidence unavailable");
    expect(confidenceText("medium")).toBe("Medium confidence");
  });

  it("describes scores by scale and never invents a value for missing evidence", () => {
    const observed = (value: string, scale: "concern_0_10" | "overlap_0_10" = "concern_0_10") => ({ value, scale, state: "observed" as const, reason: null });
    expect(scoreMeaning(observed("3.99"))).toBe("Low concern");
    expect(scoreMeaning(observed("4.00"))).toBe("Moderate concern");
    expect(scoreMeaning(observed("7"))).toBe("High concern");
    expect(scoreMeaning(observed("7.2", "overlap_0_10"))).toBe("Strong overlap");
    expect(scoreMeaning({ value: null, scale: "concern_0_10", state: "blocked", reason: "bot_challenge" })).toBe("The site blocked the automated check");
    expect(scoreMeaning({ value: null, scale: "concern_0_10", state: "none_found", reason: null })).toBe("None found");
    expect(scoreNumber("7.45")).toBe("7.5");
    expect(scoreNumber("0.04")).toBe("0.0");
    expect(scoreNumber("10.00")).toBe("10.0");
  });

  it("formats probabilities and evidence states", () => {
    expect(percentText({ value: "0.625", state: "observed", reason: null })).toBe("63%");
    expect(percentText({ value: null, state: "not_connected", reason: null })).toBe("Not connected");
    expect(evidenceText("unknown", "too_little_content")).toBe("Not enough page content to assess");
  });

  it("formats micros with integer half-up rounding at the currency minor unit", () => {
    expect(moneyText({ micros: "1234565000", currency: "USD" })).toBe("$1,234.57");
    expect(moneyText({ micros: "1234564999", currency: "USD" })).toBe("$1,234.56");
    expect(moneyText({ micros: "9223372036854775807", currency: "USD" })).toBe("$9,223,372,036,854.78");
    expect(moneyText({ micros: "1500000", currency: "JPY" })).toBe("¥2");
    expect(moneyText({ micros: "-4000", currency: "USD" })).toBe("$0.00");
    expect(moneyText(null)).toBe("—");
    expect(() => moneyText({ micros: "1.5", currency: "USD" })).toThrow();
  });
});
