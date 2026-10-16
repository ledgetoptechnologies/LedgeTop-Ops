import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Dialog } from "./index";

/**
 * Promise-based in-app replacements for window.prompt. Native prompt() is
 * unsupported in embedded and in-app browsers (it throws), and it cannot be
 * styled or labelled. Mount <AppDialogHost /> once per app; requests queue and
 * show one at a time. Cancel, Escape and Close resolve to null.
 */
export type TextRequest = {
  title: string;
  label: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Render a multi-line text area instead of a single-line input. */
  multiline?: boolean;
  /** Return the text exactly as typed (no trimming), e.g. for typed confirmations. */
  exact?: boolean;
  /** Value must be non-empty (default true). */
  required?: boolean;
  /** Return an error message to keep the dialog open, or null to accept. */
  validate?: (value: string) => string | null;
};
export type ChoiceRequest<T extends string> = {
  title: string;
  description?: string;
  choices: ReadonlyArray<{ value: T; label: string; tone?: "primary" | "danger" | "neutral" }>;
  cancelLabel?: string;
};

type Pending =
  | { id: number; kind: "text"; request: TextRequest; resolve: (value: string | null) => void }
  | { id: number; kind: "choice"; request: ChoiceRequest<string>; resolve: (value: string | null) => void };

const queue: Pending[] = [];
const listeners = new Set<() => void>();
let hosts = 0, nextId = 1;
const notify = () => { for (const listener of listeners) listener(); };

type NewPending = Pending extends infer P ? P extends Pending ? Omit<P, "id"> : never : never;
function enqueue(pending: NewPending) { queue.push({ ...pending, id: nextId++ } as Pending); notify(); }

/** Ask for text in an in-app dialog. Resolves to the trimmed (or, with exact, unmodified) text, or null if cancelled. */
export function requestText(request: TextRequest): Promise<string | null> {
  if (!hosts) return Promise.resolve(nativeTextFallback(request));
  return new Promise(resolve => enqueue({ kind: "text", request, resolve }));
}

/** Ask the user to pick one of a few explicit actions. Resolves to the chosen value, or null if cancelled. */
export function requestChoice<T extends string>(request: ChoiceRequest<T>): Promise<T | null> {
  if (!hosts) return Promise.resolve(null);
  return new Promise(resolve => enqueue({ kind: "choice", request, resolve: resolve as (value: string | null) => void }));
}

// Isolated component fixtures may render without a host. Fall back to the
// native prompt where it exists; an unsupported prompt resolves as cancelled.
function nativeTextFallback(request: TextRequest): string | null {
  try {
    const value = typeof window.prompt === "function" ? window.prompt(request.label, request.defaultValue ?? "") : null;
    if (value === null) return null;
    const result = request.exact ? value : value.trim();
    if ((request.required ?? true) && !result.trim()) return null;
    return request.validate?.(result) ? null : result;
  } catch { return null; }
}

export function AppDialogHost() {
  const [current, setCurrent] = useState<Pending | null>(queue[0] ?? null);
  useEffect(() => {
    hosts += 1;
    const update = () => setCurrent(queue[0] ?? null);
    listeners.add(update); update();
    return () => { listeners.delete(update); hosts -= 1; };
  }, []);
  const settle = (value: string | null) => {
    const head = queue.shift();
    head?.resolve(value);
    notify();
  };
  if (!current) return null;
  return current.kind === "text"
    ? <TextDialog key={current.id} request={current.request} onSettle={settle} />
    : <ChoiceDialog key={current.id} request={current.request} onSettle={settle} />;
}

function TextDialog({ request, onSettle }: { request: TextRequest; onSettle: (value: string | null) => void }) {
  const [value, setValue] = useState(request.defaultValue ?? ""), [error, setError] = useState("");
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null), inputId = useId(), errorId = useId();
  useEffect(() => { const field = input.current; if (field) { field.focus(); field.select(); } }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = request.exact ? value : value.trim();
    if ((request.required ?? true) && !result.trim()) { setError(`Enter ${request.label.toLowerCase()}.`); input.current?.focus(); return; }
    const invalid = request.validate?.(result) ?? null;
    if (invalid) { setError(invalid); input.current?.focus(); return; }
    onSettle(result);
  };
  return <Dialog open onClose={() => onSettle(null)} title={request.title} description={request.description} size="sm">
    <form className="ltds-app-dialog-form" onSubmit={submit} noValidate>
      <label className="ltds-field" htmlFor={inputId}>{request.label}
        {request.multiline
          ? <textarea ref={input} id={inputId} value={value} placeholder={request.placeholder} rows={4}
            aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
            onChange={event => { setValue(event.target.value); if (error) setError(""); }} />
          : <input ref={input} id={inputId} value={value} placeholder={request.placeholder} autoComplete="off"
            aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
            onChange={event => { setValue(event.target.value); if (error) setError(""); }} />}
      </label>
      {error && <p id={errorId} className="ltds-app-dialog-error" role="alert">{error}</p>}
      <div className="ltds-app-dialog-actions">
        <button type="button" className="button-ghost" onClick={() => onSettle(null)}>Cancel</button>
        <button type="submit" className="button-orange">{request.confirmLabel ?? "Save"}</button>
      </div>
    </form>
  </Dialog>;
}

function ChoiceDialog({ request, onSettle }: { request: ChoiceRequest<string>; onSettle: (value: string | null) => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return <Dialog open onClose={() => onSettle(null)} title={request.title} description={request.description} size="sm">
    <div className="ltds-app-dialog-actions">
      <button type="button" className="button-ghost" onClick={() => onSettle(null)}>{request.cancelLabel ?? "Cancel"}</button>
      {request.choices.map((choice, index) => <button key={choice.value} ref={index === 0 ? first : undefined} type="button"
        className={choice.tone === "danger" ? "button-danger" : choice.tone === "neutral" ? "button-ghost" : "button-orange"}
        onClick={() => onSettle(choice.value)}>{choice.label}</button>)}
    </div>
  </Dialog>;
}
