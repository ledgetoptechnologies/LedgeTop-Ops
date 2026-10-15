import type { ClientSubmittedServiceReview } from "./types";
import { mapServiceCatalogItem, validateServiceAnswers } from "./request-v2";

export interface SubmittedServiceReviewRow { service_source_id: string; service_public_id: string; service_source_version: string; service_snapshot_json: string; answers_json: string }
const SNAPSHOT_KEYS = ["publicId", "sourceVersion", "name", "summary", "category", "displayOrder", "geometryRequirement", "questions"];
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) { const actual = Object.keys(value).sort(); return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key); }
function exactQuestions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 10) return false;
  return value.every(question => {
    if (!plain(question) || typeof question.type !== "string") return false;
    const keys = question.type === "text" ? ["id", "label", "type", "required", "helpText", "maxLength"]
      : question.type === "number" ? ["id", "label", "type", "required", "helpText", "minimum", "maximum"]
      : question.type === "boolean" ? ["id", "label", "type", "required", "helpText"]
      : question.type === "select" || question.type === "multi_select" ? ["id", "label", "type", "required", "helpText", "options"] : [];
    if (!keys.length || !exactKeys(question, keys) || typeof question.required !== "boolean") return false;
    if (question.type === "text" && (!Number.isSafeInteger(question.maxLength) || (question.maxLength as number) < 1 || (question.maxLength as number) > 2_000)) return false;
    if (question.type === "number" && ![question.minimum, question.maximum].every(bound => bound === null || (typeof bound === "number" && Number.isFinite(bound)))) return false;
    return !Array.isArray(question.options) || question.options.every(option => plain(option) && exactKeys(option, ["value", "label"]));
  });
}

export function parseSubmittedServiceReview(row: SubmittedServiceReviewRow, expectedSourceId: string): ClientSubmittedServiceReview | null {
  if (row.service_source_id !== expectedSourceId || row.service_snapshot_json.length > 64_000 || row.answers_json.length > 64_000) return null;
  let snapshot: unknown; let answers: unknown;
  try { snapshot = JSON.parse(row.service_snapshot_json); answers = JSON.parse(row.answers_json); } catch { return null; }
  if (!plain(snapshot) || !exactKeys(snapshot, SNAPSHOT_KEYS) || !exactQuestions(snapshot.questions) || !plain(answers)) return null;
  const item = mapServiceCatalogItem({ public_id: row.service_public_id, source_version: row.service_source_version,
    name: snapshot.name as string, summary: snapshot.summary as string | null, category: snapshot.category as string,
    display_order: snapshot.displayOrder as number, geometry_requirement: snapshot.geometryRequirement as string,
    question_schema_json: JSON.stringify(snapshot.questions) });
  if (!item || snapshot.publicId !== row.service_public_id || snapshot.sourceVersion !== row.service_source_version) return null;
  const normalized = validateServiceAnswers(item.questions, answers);
  if (!normalized || Object.keys(normalized).length !== Object.keys(answers).length) return null;
  const labeledAnswers: ClientSubmittedServiceReview["answers"] = [];
  for (const question of item.questions) {
    const value = normalized[question.id]; if (value === undefined) continue;
    let displayValue: string;
    if (question.type === "boolean") displayValue = value ? "Yes" : "No";
    else if (question.type === "select" || question.type === "multi_select") {
      const labels = new Map(question.options.map(option => [option.value, option.label]));
      const rendered = (Array.isArray(value) ? value : [value]).map(entry => labels.get(String(entry)));
      if (rendered.some(label => label === undefined)) return null;
      displayValue = rendered.join(", ");
    } else displayValue = String(value);
    if (!displayValue || displayValue.length > 5_000) return null;
    labeledAnswers.push({ questionId: question.id, label: question.label, displayValue });
  }
  return { publicId: item.publicId, sourceVersion: item.sourceVersion, name: item.name, summary: item.summary,
    category: item.category, geometryRequirement: item.geometryRequirement, answers: labeledAnswers };
}
