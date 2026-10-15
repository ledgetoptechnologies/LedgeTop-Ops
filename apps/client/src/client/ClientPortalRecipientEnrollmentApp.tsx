import { useEffect, useRef, useState } from "react";

type State = "opening" | "ready" | "submitting" | "uncertain" | "submitted" | "retryable" | "unavailable";
type Protocol = "legacy" | "operations-native";
type Target = Readonly<{ clientRecordId: string; displayLabel: string }> &
  (Readonly<{ selectionId: string }> | Readonly<{ targetId: string; targetRevision: number }>);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CSRF = /^\d{1,12}\.[0-9a-f]{64}$/;

class RequestFailure extends Error {
  constructor(readonly uncertain: boolean) { super(uncertain ? "uncertain" : "unavailable"); }
}
async function request(protocol: Protocol, path: string, init: RequestInit = {}): Promise<unknown> {
  const base = protocol === "operations-native" ? "/api/client/operations/recipient-enrollment" : "/api/client/v2/recipient-enrollment";
  const requestHeader = protocol === "operations-native" ? "X-Operations-Enrollment-Request" : "X-Recipient-Enrollment-Request";
  const response = await fetch(`${base}${path}`, { ...init, credentials: "same-origin",
    headers: { [requestHeader]: "1", ...init.headers } });
  if (!response.ok) throw new RequestFailure(response.status >= 500 || response.status === 429);
  try { return await response.json(); } catch { throw new RequestFailure(true); }
}
function ownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const names = Object.keys(value);
  return names.length === keys.length && names.every(name => keys.includes(name)) ? value as Record<string, unknown> : null;
}
function session(value: unknown): string | null {
  const parsed = ownRecord(value, ["csrfToken"]);
  return parsed && typeof parsed.csrfToken === "string" && CSRF.test(parsed.csrfToken) ? parsed.csrfToken : null;
}
function inspected(value: unknown, intentId: string, protocol: Protocol): Target | null {
  const parsed = ownRecord(value, ["intentId", "revision", "state", "target", "expiresAt"]);
  const target = parsed && ownRecord(parsed.target, protocol === "operations-native"
    ? ["clientRecordId", "targetId", "targetRevision", "displayLabel"] : ["clientRecordId", "selectionId", "displayLabel"]);
  if (!parsed || parsed.intentId !== intentId || parsed.revision !== 1 || parsed.state !== "issued"
    || typeof parsed.expiresAt !== "string" || !Number.isFinite(Date.parse(parsed.expiresAt)) || Date.parse(parsed.expiresAt) <= Date.now()
    || !target || typeof target.clientRecordId !== "string" || !target.clientRecordId || target.clientRecordId.length > 200
    || typeof target.displayLabel !== "string" || !target.displayLabel || target.displayLabel.length > 300) return null;
  if (protocol === "operations-native") {
    if (typeof target.targetId !== "string" || !UUID.test(target.targetId) || typeof target.targetRevision !== "number"
      || !Number.isSafeInteger(target.targetRevision) || target.targetRevision < 1) return null;
    return { clientRecordId: target.clientRecordId, targetId: target.targetId,
      targetRevision: target.targetRevision, displayLabel: target.displayLabel };
  }
  if (typeof target.selectionId !== "string" || !UUID.test(target.selectionId)) return null;
  return { clientRecordId: target.clientRecordId, selectionId: target.selectionId, displayLabel: target.displayLabel };
}
function redeemed(value: unknown, intentId: string): boolean {
  const parsed = ownRecord(value, ["intentId", "revision", "state"]);
  return Boolean(parsed && parsed.intentId === intentId && parsed.revision === 2 && parsed.state === "pending");
}

export function ClientPortalRecipientEnrollmentApp({ intentId, opaqueToken, protocol = "legacy" }: {
  intentId: string; opaqueToken: string; protocol?: Protocol;
}) {
  const [state, setState] = useState<State>(intentId && opaqueToken ? "opening" : "unavailable");
  const [target, setTarget] = useState<Target | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const csrf = useRef("");
  const operationId = useRef("");
  const opening = useRef<Promise<void> | null>(null);
  const submitting = useRef(false);

  const open = () => {
    if (!intentId || !opaqueToken || opening.current) return opening.current ?? Promise.resolve();
    setState("opening");
    const work = (async () => {
      try {
        const token = session(await request(protocol, "/session"));
        if (!token) throw new RequestFailure(true);
        csrf.current = token;
        const reviewed = inspected(await request(protocol, "/inspect", { method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
          body: JSON.stringify({ intentId, opaqueToken }) }), intentId, protocol);
        if (!reviewed) throw new RequestFailure(false);
        setTarget(reviewed);
        setState("ready");
      } catch (error) {
        setState(error instanceof RequestFailure && !error.uncertain ? "unavailable" : "retryable");
      }
    })().finally(() => { opening.current = null; });
    opening.current = work;
    return work;
  };
  useEffect(() => { if (intentId && opaqueToken) void open(); }, [intentId, opaqueToken, protocol]);

  const confirm = async (refreshSession = false) => {
    if (!target || !acknowledged || submitting.current || !csrf.current) return;
    if (!operationId.current) operationId.current = crypto.randomUUID();
    submitting.current = true;
    setState("submitting");
    try {
      if (refreshSession) {
        const renewed = session(await request(protocol, "/session"));
        if (!renewed) throw new RequestFailure(true);
        csrf.current = renewed;
      }
      const result = await request(protocol, "/redeem", { method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.current },
        body: JSON.stringify({ intentId, opaqueToken, operationId: operationId.current, acknowledged: true,
          acknowledgedTarget: "targetId" in target
            ? { targetId: target.targetId, targetRevision: target.targetRevision, clientRecordId: target.clientRecordId }
            : { clientRecordId: target.clientRecordId, selectionId: target.selectionId } }) });
      setState(redeemed(result, intentId) ? "submitted" : "unavailable");
    } catch (error) {
      setState(error instanceof RequestFailure && error.uncertain ? "uncertain" : "unavailable");
    } finally { submitting.current = false; }
  };

  if (state === "opening") return <main className="portal-loading-shell" aria-busy="true" aria-label="Opening portal account confirmation" />;
  if (state === "submitted") return <main className="client-profile-onboarding"><div className="client-profile-onboarding-card">
    <p className="client-profile-onboarding-eyebrow">Ledge Top Client Portal</p><h1>Confirmation submitted</h1>
    <p>Your portal account request is waiting for administrator review. This confirmation does not activate access by itself.</p>
  </div></main>;
  if (state === "retryable") return <main className="client-profile-onboarding"><div className="client-profile-onboarding-card">
    <h1>Temporarily unavailable</h1><p>Please keep this page open and try again. The secure link remains only in this tab.</p>
    <button type="button" className="button-orange" onClick={() => void open()}>Try again</button>
  </div></main>;
  if (state === "unavailable") return <main className="client-profile-onboarding"><div className="client-profile-onboarding-card">
    <h1>Portal confirmation unavailable</h1><p>This secure link may be invalid or expired. Ask the administrator who sent it to create a new confirmation link.</p>
  </div></main>;
  if (state === "uncertain") return <main className="client-profile-onboarding"><div className="client-profile-onboarding-card">
    <h1>Confirmation status uncertain</h1><p role="alert">We could not verify whether the confirmation reached the administrator.</p>
    <button type="button" className="button-orange" onClick={() => void confirm(true)}>Retry same confirmation</button>
  </div></main>;
  return <main className="client-profile-onboarding"><div className="client-profile-onboarding-card">
    <header><p className="client-profile-onboarding-eyebrow">Ledge Top Client Portal</p><h1>Confirm portal account</h1>
      <p>Review the account below. Confirming sends a request to the administrator; it does not activate access automatically.</p></header>
    <form className="client-profile-onboarding-form" onSubmit={event => { event.preventDefault(); void confirm(); }}>
      <fieldset className="client-profile-onboarding-type"><legend>Selected client account</legend>
        <p><strong>{target?.displayLabel}</strong></p>
        <div><label><input type="checkbox" checked={acknowledged} disabled={state === "submitting"}
          onChange={event => setAcknowledged(event.currentTarget.checked)} />
          I confirm this is the client account I intend to connect to my signed-in portal identity.</label></div>
      </fieldset>
      <button type="submit" className="button-orange" disabled={!acknowledged || state === "submitting"}>
        {state === "submitting" ? "Submitting confirmation…" : "Submit for administrator review"}
      </button>
    </form>
  </div></main>;
}
