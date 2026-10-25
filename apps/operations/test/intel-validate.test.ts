import { describe, expect, it } from "vitest";
import { sampleStaffTenant } from "../../../packages/shared/test-fixtures/competitor-intel-sample";
import { isTenantView } from "../src/client/intel-validate";

const clone = () => structuredClone(sampleStaffTenant) as unknown as Record<string, any>;

describe("Intel competitor view validation", () => {
  it("accepts the shared sample view", () => {
    expect(isTenantView(sampleStaffTenant)).toBe(true);
  });

  it.each([
    ["an empty baseline", (view: Record<string, any>) => { view.competitors[0].baseline = {}; }],
    ["a baseline without a threat state", (view: Record<string, any>) => { view.competitors[0].baseline = { ...view.competitors[0].baseline, threat: {} }; }],
    ["a missing homepage status", (view: Record<string, any>) => { delete view.competitors[0].homepageStatus; }],
    ["a competitor with only a key and name", (view: Record<string, any>) => { view.competitors = [{ subjectKey: "comp:x", name: "x", operationId: "op", payloadSha256: "ab" }]; }],
    ["an empty significance", (view: Record<string, any>) => { view.changes[0].significance = {}; }],
    ["an unknown significance", (view: Record<string, any>) => { view.changes[0].significance = { value: "huge", confidence: null }; }],
    ["a change without an impact score", (view: Record<string, any>) => { delete view.changes[0].impact; }],
    ["a malformed intent", (view: Record<string, any>) => { view.intents = [{ kind: "run_scan" }]; }],
    ["a malformed self-assessment", (view: Record<string, any>) => { view.selfAssessment = { scores: {} }; }],
    ["malformed ads totals", (view: Record<string, any>) => { if (view.ownAds) view.ownAds.totals = {}; else view.ownAds = { totals: {} }; }],
  ])("refuses %s", (_name, mutate) => {
    const view = clone();
    mutate(view);
    expect(isTenantView(view)).toBe(false);
  });
});
