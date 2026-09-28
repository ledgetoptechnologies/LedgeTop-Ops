import { describe, expect, it } from "vitest";
import {
  parseWebsiteMonthlyReportClientPublishedV1,
  parseWebsiteMonthlyReportStaffDraftV1,
  websiteMonthlyReportPeriodsOverlap,
} from "../../../packages/shared/src/website-monthly-report";

const period = {
  calendarMonth: "2026-03", timezone: "America/Chicago",
  startInclusive: "2026-03-01T00:00:00-06:00", endExclusive: "2026-04-01T00:00:00-05:00",
};
const metric = {
  metricId: "visits.total", value: null, unit: "visits", sourceId: "analytics:property-1",
  sourceRevision: "snapshot:2026-04-02", collectedAt: "2026-04-02T12:00:00Z",
};
const published = {
  protocolVersion: 1, reportId: "report:monthly-2026-03", websiteId: "website:customer-site",
  websiteSourceRevision: "website:17", reportSourceRevision: "report:4", period, metrics: [metric],
  narrative: "Traffic data was unavailable for part of the month.", state: "published",
  publishedRevision: 4, publishedAt: "2026-04-03T12:00:00Z", withdrawnAt: null,
};
const draft = {
  protocolVersion: 1, reportId: "report:monthly-2026-03", websiteId: "website:customer-site",
  websiteSourceRevision: "website:17", reportSourceRevision: "draft:3", period, metrics: [metric], narrative: "Review pending.",
  state: "in_review", revision: 3, preparedByStaffId: "staff:preparer", reviewedByStaffId: "staff:reviewer",
  visibility: { organizationalUnitId: "organization:customer", audienceVersion: 2 }, supersedesReportId: null,
  createdAt: "2026-04-02T10:00:00Z", updatedAt: "2026-04-02T11:00:00Z",
};

describe("website monthly report contracts", () => {
  it("keeps nullable unknown metrics and parses separate staff and client shapes", () => {
    expect(parseWebsiteMonthlyReportStaffDraftV1(draft)).toEqual(draft);
    expect(parseWebsiteMonthlyReportClientPublishedV1(published)).toEqual(published);
    expect(parseWebsiteMonthlyReportClientPublishedV1(published)?.metrics[0]?.value).toBeNull();
  });

  it("rejects staff, audit, internal visibility, URL, token, and extra fields from client publications", () => {
    for (const extra of [
      { preparedByStaffId: "staff:preparer" }, { reviewedByStaffId: "staff:reviewer" },
      { visibility: { organizationalUnitId: "organization:customer", audienceVersion: 2 } },
      { auditId: "audit:event" }, { rawUrl: "https://internal.invalid/report" }, { token: "secret" },
    ]) expect(parseWebsiteMonthlyReportClientPublishedV1({ ...published, ...extra })).toBeNull();
  });

  it("accepts exact calendar-month boundaries across DST and rejects wrong month, timezone, or partial periods", () => {
    expect(parseWebsiteMonthlyReportClientPublishedV1(published)).not.toBeNull();
    for (const badPeriod of [
      { ...period, calendarMonth: "2026-04" },
      { ...period, timezone: "Not/A_Timezone" },
      { ...period, startInclusive: "2026-03-02T00:00:00-06:00" },
      { ...period, endExclusive: "2026-03-31T23:59:59-05:00" },
    ]) expect(parseWebsiteMonthlyReportClientPublishedV1({ ...published, period: badPeriod })).toBeNull();
  });

  it("rejects impossible ISO calendar dates instead of accepting Date.parse normalization", () => {
    expect(parseWebsiteMonthlyReportClientPublishedV1({
      ...published, publishedAt: "2026-02-29T12:00:00Z",
    })).toBeNull();
    expect(parseWebsiteMonthlyReportClientPublishedV1({
      ...published, metrics: [{ ...metric, collectedAt: "2026-04-31T12:00:00Z" }],
    })).toBeNull();
    expect(parseWebsiteMonthlyReportStaffDraftV1({
      ...draft, createdAt: "2026-02-29T10:00:00Z",
    })).toBeNull();
  });

  it("requires exact month boundaries without hidden fractional milliseconds", () => {
    expect(parseWebsiteMonthlyReportClientPublishedV1({
      ...published,
      period: { ...period, startInclusive: "2026-03-01T00:00:00.001-06:00" },
    })).toBeNull();
    expect(parseWebsiteMonthlyReportClientPublishedV1({
      ...published,
      period: { ...period, endExclusive: "2026-04-01T00:00:00.999-05:00" },
    })).toBeNull();
  });

  it("requires stable IDs, source revisions, metric provenance, and current immutable publication state", () => {
    const invalid = [
      { ...published, reportId: "monthly report" },
      { ...published, websiteSourceRevision: "" },
      { ...published, metrics: [{ ...metric, sourceRevision: "" }] },
      { ...published, metrics: [{ ...metric, collectedAt: "yesterday" }] },
      { ...published, state: "withdrawn", withdrawnAt: "2026-04-04T12:00:00Z" },
      { ...published, publishedRevision: 0 },
    ];
    for (const value of invalid) expect(parseWebsiteMonthlyReportClientPublishedV1(value)).toBeNull();
  });

  it("rejects duplicate or unbounded metrics, non-finite values, and oversized narrative", () => {
    expect(parseWebsiteMonthlyReportClientPublishedV1({ ...published, metrics: [metric, metric] })).toBeNull();
    expect(parseWebsiteMonthlyReportClientPublishedV1({ ...published, metrics: Array.from({ length: 65 }, (_, index) => ({ ...metric, metricId: `metric.${index}` })) })).toBeNull();
    expect(parseWebsiteMonthlyReportClientPublishedV1({ ...published, metrics: [{ ...metric, value: Number.NaN }] })).toBeNull();
    expect(parseWebsiteMonthlyReportClientPublishedV1({ ...published, narrative: "x".repeat(4001) })).toBeNull();
  });

  it("only evaluates overlap inside one explicit website and timezone scope", () => {
    const april = { ...published, reportId: "report:monthly-2026-04", period: {
      calendarMonth: "2026-04", timezone: "America/Chicago",
      startInclusive: "2026-04-01T00:00:00-05:00", endExclusive: "2026-05-01T00:00:00-05:00",
    } };
    expect(websiteMonthlyReportPeriodsOverlap(published, april)).toBe(false);
    expect(websiteMonthlyReportPeriodsOverlap(published, { websiteId: published.websiteId, period: published.period })).toBe(true);
    expect(websiteMonthlyReportPeriodsOverlap(published, { ...published, websiteId: "website:other" })).toBeNull();
    expect(websiteMonthlyReportPeriodsOverlap(published, { ...published, period: { ...period, timezone: "UTC" } })).toBeNull();
  });

  it("declines overlap evaluation for invalid unchecked period data", () => {
    const invalid = {
      ...published,
      period: { ...period, startInclusive: "not-a-timestamp" },
    } as typeof published;
    expect(websiteMonthlyReportPeriodsOverlap(invalid, published)).toBeNull();
  });

  it("canonicalizes equivalent timezone aliases before overlap comparison", () => {
    const aliased = { ...published, period: { ...period, timezone: "US/Central" } };
    const parsed = parseWebsiteMonthlyReportClientPublishedV1(aliased);
    expect(parsed?.period.timezone).toBe("America/Chicago");
    expect(websiteMonthlyReportPeriodsOverlap(aliased, published)).toBe(true);
  });

  it("returns detached DTOs that cannot be changed through later input mutation", () => {
    const input = structuredClone(published);
    const staffInput = structuredClone(draft);
    const parsed = parseWebsiteMonthlyReportClientPublishedV1(input)!;
    const parsedStaff = parseWebsiteMonthlyReportStaffDraftV1(staffInput)!;
    input.period.calendarMonth = "2027-01";
    input.metrics[0]!.sourceRevision = "changed:later";
    staffInput.visibility.organizationalUnitId = "organization:changed";
    expect(parsed.period.calendarMonth).toBe("2026-03");
    expect(parsed.metrics[0]?.sourceRevision).toBe("snapshot:2026-04-02");
    expect(parsedStaff.visibility.organizationalUnitId).toBe("organization:customer");
    expect(parsed).not.toBe(input);
    expect(parsed.period).not.toBe(input.period);
    expect(parsed.metrics).not.toBe(input.metrics);
    expect(parsedStaff.visibility).not.toBe(staffInput.visibility);
  });

  it("accepts valid leap-year and year-boundary calendar months", () => {
    const leap = { ...published, period: {
      calendarMonth: "2028-02", timezone: "UTC",
      startInclusive: "2028-02-01T00:00:00Z", endExclusive: "2028-03-01T00:00:00Z",
    } };
    const december = { ...published, period: {
      calendarMonth: "2026-12", timezone: "UTC",
      startInclusive: "2026-12-01T00:00:00Z", endExclusive: "2027-01-01T00:00:00Z",
    } };
    expect(parseWebsiteMonthlyReportClientPublishedV1(leap)).not.toBeNull();
    expect(parseWebsiteMonthlyReportClientPublishedV1(december)).not.toBeNull();
  });
});
