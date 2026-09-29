/**
 * Provisional data-shape validation only; currently unused by runtime routes.
 * A valid DTO is not proof of resource/recipient authority, provenance ownership,
 * a current publication revision, or a fresh withdrawal check. Those require
 * independently authorized runtime reads and durable publication controls.
 */
export interface WebsiteMonthlyReportPeriodV1 {
  calendarMonth: string;
  timezone: string;
  startInclusive: string;
  endExclusive: string;
}

export interface WebsiteMonthlyReportMetricV1 {
  metricId: string;
  value: number | string | boolean | null;
  unit: string | null;
  sourceId: string;
  sourceRevision: string;
  collectedAt: string;
}

export interface WebsiteMonthlyReportStaffDraftV1 {
  protocolVersion: 1;
  reportId: string;
  websiteId: string;
  websiteSourceRevision: string;
  reportSourceRevision: string;
  period: WebsiteMonthlyReportPeriodV1;
  metrics: WebsiteMonthlyReportMetricV1[];
  narrative: string;
  state: "draft" | "in_review";
  revision: number;
  preparedByStaffId: string;
  reviewedByStaffId: string | null;
  visibility: { organizationalUnitId: string; audienceVersion: number };
  supersedesReportId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Client-safe publication. Withdrawn publications are not valid client DTOs. */
export interface WebsiteMonthlyReportClientPublishedV1 {
  protocolVersion: 1;
  reportId: string;
  websiteId: string;
  websiteSourceRevision: string;
  reportSourceRevision: string;
  period: WebsiteMonthlyReportPeriodV1;
  metrics: WebsiteMonthlyReportMetricV1[];
  narrative: string;
  state: "published";
  publishedRevision: number;
  publishedAt: string;
  withdrawnAt: null;
}

const STABLE_ID = /^[a-z][a-z0-9_]{1,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const METRIC_ID = /^[a-z][a-z0-9_.-]{0,95}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function bounded(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0), offsetMinute = Number(match[11] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  return Number.isFinite(Date.parse(value));
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && STABLE_ID.test(value);
}

function revision(value: unknown): value is string {
  return typeof value === "string" && REVISION.test(value);
}

function canonicalTimezone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function localParts(value: string, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(value));
    const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
    const result = { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second"), millisecond: new Date(value).getUTCMilliseconds() };
    return Object.values(result).every(Number.isInteger) ? result : null;
  } catch {
    return null;
  }
}

function parsePeriod(value: unknown): WebsiteMonthlyReportPeriodV1 | null {
  if (!exactObject(value, ["calendarMonth", "timezone", "startInclusive", "endExclusive"])) return null;
  const { calendarMonth, timezone, startInclusive, endExclusive } = value;
  if (typeof calendarMonth !== "string" || !MONTH.test(calendarMonth) || !bounded(timezone, 100)
    || !timestamp(startInclusive) || !timestamp(endExclusive) || Date.parse(startInclusive) >= Date.parse(endExclusive)) return null;
  const canonical = canonicalTimezone(timezone);
  if (!canonical) return null;
  const match = MONTH.exec(calendarMonth)!;
  const year = Number(match[1]), month = Number(match[2]);
  const nextMonth = month === 12 ? 1 : month + 1, nextYear = month === 12 ? year + 1 : year;
  const start = localParts(startInclusive, canonical), end = localParts(endExclusive, canonical);
  if (!start || !end || start.year !== year || start.month !== month || start.day !== 1 || start.hour || start.minute || start.second || start.millisecond
    || end.year !== nextYear || end.month !== nextMonth || end.day !== 1 || end.hour || end.minute || end.second || end.millisecond) return null;
  return { calendarMonth, timezone: canonical, startInclusive, endExclusive };
}

function parseMetrics(value: unknown): WebsiteMonthlyReportMetricV1[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const ids = new Set<string>();
  const output: WebsiteMonthlyReportMetricV1[] = [];
  for (const item of value) {
    if (!exactObject(item, ["metricId", "value", "unit", "sourceId", "sourceRevision", "collectedAt"])) return null;
    const metricId = item.metricId;
    if (typeof metricId !== "string" || !METRIC_ID.test(metricId) || ids.has(metricId)
      || item.unit !== null && !bounded(item.unit, 40) || !stableId(item.sourceId)
      || !revision(item.sourceRevision) || !timestamp(item.collectedAt)) return null;
    const metricValue = item.value;
    if (metricValue !== null && typeof metricValue !== "boolean"
      && (typeof metricValue === "number" ? !Number.isFinite(metricValue)
        : typeof metricValue !== "string" || !bounded(metricValue, 500, true))) return null;
    ids.add(metricId);
    output.push({ metricId, value: metricValue as number | string | boolean | null, unit: item.unit as string | null,
      sourceId: item.sourceId as string, sourceRevision: item.sourceRevision as string, collectedAt: item.collectedAt as string });
  }
  return output;
}

export function parseWebsiteMonthlyReportStaffDraftV1(value: unknown): WebsiteMonthlyReportStaffDraftV1 | null {
  const keys = ["protocolVersion", "reportId", "websiteId", "websiteSourceRevision", "reportSourceRevision", "period", "metrics",
    "narrative", "state", "revision", "preparedByStaffId", "reviewedByStaffId", "visibility", "supersedesReportId", "createdAt", "updatedAt"];
  if (!exactObject(value, keys) || value.protocolVersion !== 1 || !stableId(value.reportId) || !stableId(value.websiteId)
    || !revision(value.websiteSourceRevision) || !revision(value.reportSourceRevision) || !bounded(value.narrative, 4000, true)
    || !["draft", "in_review"].includes(value.state as string) || !positiveInteger(value.revision)
    || !stableId(value.preparedByStaffId) || value.reviewedByStaffId !== null && !stableId(value.reviewedByStaffId)
    || value.supersedesReportId !== null && (!stableId(value.supersedesReportId) || value.supersedesReportId === value.reportId)
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || Date.parse(value.createdAt) > Date.parse(value.updatedAt)
    || !exactObject(value.visibility, ["organizationalUnitId", "audienceVersion"])
    || !stableId(value.visibility.organizationalUnitId) || !positiveInteger(value.visibility.audienceVersion)) return null;
  const period = parsePeriod(value.period), metrics = parseMetrics(value.metrics);
  if (!period || !metrics) return null;
  return {
    protocolVersion: 1, reportId: value.reportId as string, websiteId: value.websiteId as string,
    websiteSourceRevision: value.websiteSourceRevision as string, reportSourceRevision: value.reportSourceRevision as string,
    period, metrics, narrative: value.narrative as string, state: value.state as "draft" | "in_review", revision: value.revision as number,
    preparedByStaffId: value.preparedByStaffId as string, reviewedByStaffId: value.reviewedByStaffId as string | null,
    visibility: { organizationalUnitId: value.visibility.organizationalUnitId as string, audienceVersion: value.visibility.audienceVersion as number },
    supersedesReportId: value.supersedesReportId as string | null, createdAt: value.createdAt as string, updatedAt: value.updatedAt as string,
  };
}

export function parseWebsiteMonthlyReportClientPublishedV1(value: unknown): WebsiteMonthlyReportClientPublishedV1 | null {
  const keys = ["protocolVersion", "reportId", "websiteId", "websiteSourceRevision", "reportSourceRevision", "period", "metrics",
    "narrative", "state", "publishedRevision", "publishedAt", "withdrawnAt"];
  if (!exactObject(value, keys) || value.protocolVersion !== 1 || !stableId(value.reportId) || !stableId(value.websiteId)
    || !revision(value.websiteSourceRevision) || !revision(value.reportSourceRevision) || !bounded(value.narrative, 4000, true)
    || value.state !== "published" || !positiveInteger(value.publishedRevision) || !timestamp(value.publishedAt)
    || value.withdrawnAt !== null) return null;
  const period = parsePeriod(value.period), metrics = parseMetrics(value.metrics);
  if (!period || !metrics) return null;
  return {
    protocolVersion: 1, reportId: value.reportId as string, websiteId: value.websiteId as string,
    websiteSourceRevision: value.websiteSourceRevision as string, reportSourceRevision: value.reportSourceRevision as string,
    period, metrics, narrative: value.narrative as string, state: "published", publishedRevision: value.publishedRevision as number,
    publishedAt: value.publishedAt as string, withdrawnAt: null,
  };
}

/** Returns null when the caller has not supplied one exact website/timezone scope. */
export function websiteMonthlyReportPeriodsOverlap(
  left: Pick<WebsiteMonthlyReportClientPublishedV1, "websiteId" | "period">,
  right: Pick<WebsiteMonthlyReportClientPublishedV1, "websiteId" | "period">,
): boolean | null {
  if (!stableId(left.websiteId) || !stableId(right.websiteId)) return null;
  const leftPeriod = parsePeriod(left.period), rightPeriod = parsePeriod(right.period);
  if (!leftPeriod || !rightPeriod || left.websiteId !== right.websiteId || leftPeriod.timezone !== rightPeriod.timezone) return null;
  return Date.parse(leftPeriod.startInclusive) < Date.parse(rightPeriod.endExclusive)
    && Date.parse(rightPeriod.startInclusive) < Date.parse(leftPeriod.endExclusive);
}
