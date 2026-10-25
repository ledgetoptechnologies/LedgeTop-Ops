import type { ReactNode } from "react";
import type { PortalServiceQuestion } from "./portal-api";

/** Shared by the per-account request wizard and the one-step request form. */
export function questionIsAnswered(question: PortalServiceQuestion, value: unknown): boolean {
  if (!question.required) return true;
  if (question.type === "boolean") return typeof value === "boolean";
  if (question.type === "multi_select") return Array.isArray(value) && value.length > 0;
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

export function ServiceQuestionField({
  serviceId,
  question,
  value,
  onChange,
}: {
  serviceId: string;
  question: PortalServiceQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `service-${serviceId}-${question.id}`;
  const helpId = question.helpText ? `${id}-help` : undefined;
  const shared = { id, required: question.required, "aria-describedby": helpId };
  let control: ReactNode;
  if (question.type === "text") {
    control = <input {...shared} value={typeof value === "string" ? value : ""} maxLength={question.maxLength} onChange={(event) => onChange(event.target.value)} />;
  } else if (question.type === "number") {
    control = <input {...shared} type="number" value={typeof value === "number" ? value : ""} min={question.minimum ?? undefined} max={question.maximum ?? undefined} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.valueAsNumber)} />;
  } else if (question.type === "boolean") {
    control = <select {...shared} value={typeof value === "boolean" ? String(value) : ""} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value === "true")}><option value="">Select an answer</option><option value="true">Yes</option><option value="false">No</option></select>;
  } else if (question.type === "select") {
    control = <select {...shared} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}><option value="">Select an option</option>{question.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  } else {
    const selected = Array.isArray(value) ? value as string[] : [];
    control = <div className="portal-service-options" id={id} aria-describedby={helpId}>{question.options.map(option => <label key={option.value} className="portal-check-option"><input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter(item => item !== option.value))} /> <span>{option.label}</span></label>)}</div>;
  }
  return <div className="portal-service-question"><label htmlFor={question.type === "multi_select" ? undefined : id}>{question.label}{question.required ? <span aria-hidden="true"> *</span> : <span> (optional)</span>}{control}</label>{question.helpText && <small id={helpId}>{question.helpText}</small>}</div>;
}
