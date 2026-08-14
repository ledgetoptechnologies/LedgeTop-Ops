import { describe, expect, it } from "vitest";
import { clientRequestServiceReview } from "../src/worker/client-request-service-review";

function row(snapshot: Record<string, unknown>, answers: Record<string, unknown>) {
  return {
    service_public_id: "svc-inspection",
    service_source_version: "catalog-9",
    service_snapshot_json: JSON.stringify(snapshot),
    answers_json: JSON.stringify(answers),
  };
}

describe("client request immutable service review", () => {
  it("formats declarative submitted answers without forwarding extra snapshot fields", () => {
    const review = clientRequestServiceReview(row({
      publicId: "svc-inspection",
      sourceVersion: "catalog-9",
      name: "Site Inspection",
      summary: "A client-safe inspection summary.",
      category: "Inspection",
      geometryRequirement: "optional",
      displayOrder: 7,
      unitPrice: "999.00",
      internalNotes: "never expose",
      questions: [
        { id: "urgent", label: "Urgent?", type: "boolean" },
        { id: "height", label: "Maximum height", type: "number" },
        { id: "outputs", label: "Outputs", type: "multi_select", options: [
          { value: "photos", label: "Photos" },
          { value: "report", label: "Written report" },
        ] },
      ],
    }, { urgent: false, height: 120, outputs: ["photos", "report"] }));

    expect(review).toMatchObject({
      integrity: "verified",
      name: "Site Inspection",
      answers: [
        { label: "Urgent?", displayValue: "No" },
        { label: "Maximum height", displayValue: "120" },
        { label: "Outputs", displayValue: "Photos, Written report" },
      ],
    });
    expect(review).not.toHaveProperty("unitPrice");
    expect(JSON.stringify(review)).not.toMatch(/999\.00|never expose/);
  });

  it("fails closed with a generic review entry when immutable identity or answers do not verify", () => {
    const review = clientRequestServiceReview(row({
      publicId: "svc-other",
      sourceVersion: "catalog-9",
      name: "Private source text",
      summary: null,
      category: "Inspection",
      geometryRequirement: "none",
      questions: [],
    }, {}));

    expect(review).toMatchObject({
      integrity: "invalid",
      publicId: "svc-inspection",
      name: "Service snapshot unavailable",
      answers: [],
    });
    expect(JSON.stringify(review)).not.toContain("Private source text");
  });
});
