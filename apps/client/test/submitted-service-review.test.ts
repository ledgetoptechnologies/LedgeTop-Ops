import { describe, expect, it } from "vitest";
import { parseSubmittedServiceReview, type SubmittedServiceReviewRow } from "../src/worker/client-portal/submitted-service-review";

const sourceId = "project-alpha:primary";
const row = (overrides: Partial<SubmittedServiceReviewRow> = {}): SubmittedServiceReviewRow => ({
  service_source_id: sourceId,
  service_public_id: "website-care",
  service_source_version: "catalog-7",
  service_snapshot_json: JSON.stringify({ publicId: "website-care", sourceVersion: "catalog-7", name: "Website care",
    summary: "Reviewed updates", category: "Web", displayOrder: 1, geometryRequirement: "none", questions: [
      { id: "request_kind", label: "Request", type: "select", required: true, helpText: null,
        options: [{ value: "content_edit", label: "Content edit" }] },
      { id: "notes", label: "Notes", type: "text", required: true, helpText: null, maxLength: 2000 },
    ] }),
  answers_json: JSON.stringify({ request_kind: "content_edit", notes: "Update the existing copy." }),
  ...overrides,
});

describe("submitted service review", () => {
  it("returns only immutable allowlisted catalog fields and labeled answers", () => {
    expect(parseSubmittedServiceReview(row(), sourceId)).toEqual({ publicId: "website-care", sourceVersion: "catalog-7",
      name: "Website care", summary: "Reviewed updates", category: "Web", geometryRequirement: "none", answers: [
        { questionId: "request_kind", label: "Request", displayValue: "Content edit" },
        { questionId: "notes", label: "Notes", displayValue: "Update the existing copy." },
      ] });
  });
  it.each([
    ["cross-source", row({ service_source_id: "project-alpha:other" })],
    ["row identity mismatch", row({ service_public_id: "other" })],
    ["unknown answer", row({ answers_json: '{"private_price":9000}' })],
    ["private snapshot key", row({ service_snapshot_json: row().service_snapshot_json.replace('"questions"', '"privatePrice":9000,"questions"') })],
    ["private question key", row({ service_snapshot_json: row().service_snapshot_json.replace('"options"', '"providerId":"hidden","options"') })],
    ["coerced required", row({ service_snapshot_json: row().service_snapshot_json.replace('"required":true', '"required":"yes"') })],
    ["coerced text bound", row({ service_snapshot_json: row().service_snapshot_json.replace('"maxLength":2000', '"maxLength":"2000"') })],
    ["oversized raw value", row({ answers_json: JSON.stringify({ notes: "x".repeat(64_001) }) })],
    ["malformed", row({ answers_json: "{" })],
  ])("fails closed for %s", (_name, stored) => expect(parseSubmittedServiceReview(stored, sourceId)).toBeNull());
});
