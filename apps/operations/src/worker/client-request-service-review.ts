export interface ClientRequestServiceReviewRow {
  service_public_id: string;
  service_source_version: string;
  service_snapshot_json: string;
  answers_json: string;
}

export interface ClientRequestServiceReview {
  publicId: string;
  sourceVersion: string;
  name: string;
  summary: string | null;
  category: string;
  geometryRequirement: "none" | "optional" | "required" | null;
  answers: Array<{
    questionId: string;
    label: string;
    displayValue: string;
  }>;
  integrity: "verified" | "invalid";
}

type JsonObject = Record<string, unknown>;

function plainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, maximum: number, multiline = false): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  return normalized && normalized.length <= maximum && !controls.test(normalized) ? normalized : null;
}

function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function optionsFor(question: JsonObject): Array<{ value: string; label: string }> | null {
  if (!Array.isArray(question.options) || question.options.length > 100) return null;
  const options: Array<{ value: string; label: string }> = [];
  for (const raw of question.options) {
    if (!plainObject(raw)) return null;
    const value = safeText(raw.value, 100);
    const label = safeText(raw.label, 160);
    if (!value || !label) return null;
    options.push({ value, label });
  }
  return options;
}

function displayAnswer(question: JsonObject, answer: unknown): string | null {
  if (question.type === "text") return safeText(answer, 5_000, true);
  if (question.type === "number")
    return typeof answer === "number" && Number.isFinite(answer) ? String(answer) : null;
  if (question.type === "boolean")
    return typeof answer === "boolean" ? (answer ? "Yes" : "No") : null;
  if (question.type !== "select" && question.type !== "multi_select") return null;
  const options = optionsFor(question);
  if (!options) return null;
  const labels = new Map(options.map(option => [option.value, option.label]));
  if (question.type === "select")
    return typeof answer === "string" ? labels.get(answer) ?? null : null;
  if (!Array.isArray(answer) || answer.length > 20) return null;
  const selected = answer.map(value => typeof value === "string" ? labels.get(value) : null);
  return selected.every((label): label is string => Boolean(label)) ? selected.join(", ") : null;
}

function invalidReview(row: ClientRequestServiceReviewRow): ClientRequestServiceReview {
  return {
    publicId: safeText(row.service_public_id, 128) ?? "unavailable",
    sourceVersion: safeText(row.service_source_version, 128) ?? "unavailable",
    name: "Service snapshot unavailable",
    summary: "The immutable submitted service details could not be verified. Review the request audit record before proceeding.",
    category: "Recorded service",
    geometryRequirement: null,
    answers: [],
    integrity: "invalid",
  };
}

/**
 * Converts the immutable request snapshot into the only fields Operations may
 * display. Extra snapshot keys (including pricing or internal PA metadata) are
 * deliberately ignored instead of being forwarded to the browser.
 */
export function clientRequestServiceReview(
  row: ClientRequestServiceReviewRow,
): ClientRequestServiceReview {
  const snapshot = parseJsonObject(row.service_snapshot_json);
  const submittedAnswers = parseJsonObject(row.answers_json);
  if (!snapshot || !submittedAnswers) return invalidReview(row);

  const publicId = safeText(snapshot.publicId, 128);
  const sourceVersion = safeText(snapshot.sourceVersion, 128);
  const name = safeText(snapshot.name, 160);
  const category = safeText(snapshot.category, 100);
  const summary = snapshot.summary === null ? null : safeText(snapshot.summary, 1_000, true);
  const geometryRequirement = snapshot.geometryRequirement;
  if (
    !publicId || publicId !== row.service_public_id ||
    !sourceVersion || sourceVersion !== row.service_source_version ||
    !name || !category ||
    (snapshot.summary !== null && !summary) ||
    (geometryRequirement !== "none" && geometryRequirement !== "optional" && geometryRequirement !== "required") ||
    !Array.isArray(snapshot.questions) || snapshot.questions.length > 10
  ) return invalidReview(row);

  const answers: ClientRequestServiceReview["answers"] = [];
  for (const rawQuestion of snapshot.questions) {
    if (!plainObject(rawQuestion)) return invalidReview(row);
    const questionId = safeText(rawQuestion.id, 64);
    const label = safeText(rawQuestion.label, 160);
    if (!questionId || !label) return invalidReview(row);
    const submitted = submittedAnswers[questionId];
    if (submitted === undefined || submitted === null || submitted === "" || (Array.isArray(submitted) && submitted.length === 0)) continue;
    const displayValue = displayAnswer(rawQuestion, submitted);
    if (!displayValue) return invalidReview(row);
    answers.push({ questionId, label, displayValue });
  }

  return {
    publicId,
    sourceVersion,
    name,
    summary,
    category,
    geometryRequirement,
    answers,
    integrity: "verified",
  };
}
