import { useEffect, useRef, useState } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";

type Definition = { serviceId: string; providerId: string; sourceId: string; sourceServiceId: string; displayName: string };
type Enrollment = { serviceId: string; state: "active" | "revoked"; revision: number };
type State = { customerRecordId: string; definitions: Definition[]; enrollments: Enrollment[] };
const base = "/api/client-hub/service-management";
export function currentOpsServiceState(state: State | null, customerRecordId: string) {
  return state?.customerRecordId === customerRecordId ? state : null;
}
type LoadTicket = Readonly<{ customerRecordId: string; generation: number }>;
export function createOpsServiceLoadGuard() {
  let generation = 0, customerRecordId = "";
  return {
    begin(nextCustomerRecordId: string): LoadTicket { customerRecordId = nextCustomerRecordId; return { customerRecordId, generation: ++generation }; },
    current(ticket: LoadTicket) { return ticket.customerRecordId === customerRecordId && ticket.generation === generation; },
    invalidate(ticket: LoadTicket) { if (this.current(ticket)) generation += 1; },
  };
}

export function OpsServiceManagement({ customerRecordId }: { customerRecordId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<{ customerRecordId: string; message: string } | null>(null), [busy, setBusy] = useState(false);
  const [definition, setDefinition] = useState({ serviceId: "", providerId: "", sourceId: "", sourceServiceId: "", displayName: "" });
  const loadGuard = useRef<ReturnType<typeof createOpsServiceLoadGuard> | null>(null);
  if (!loadGuard.current) loadGuard.current = createOpsServiceLoadGuard();
  const load = async (ticket: LoadTicket) => {
    try {
      const loaded = await api<Omit<State, "customerRecordId">>(`${base}/clients/${encodeURIComponent(ticket.customerRecordId)}`);
      if (loadGuard.current?.current(ticket)) setState({ customerRecordId: ticket.customerRecordId, ...loaded });
    } catch (value) {
      if (!loadGuard.current?.current(ticket)) return;
      setState(null);
      if (!(value instanceof ApiError) || value.status !== 404 && value.status !== 403)
        setError({ customerRecordId: ticket.customerRecordId, message: "Service management is unavailable." });
    }
  };
  useEffect(() => {
    const ticket = loadGuard.current!.begin(customerRecordId);
    setState(null); setError(null); setBusy(false);
    setDefinition({ serviceId: "", providerId: "", sourceId: "", sourceServiceId: "", displayName: "" });
    void load(ticket);
    return () => loadGuard.current?.invalidate(ticket);
  }, [customerRecordId]);
  const visibleState = currentOpsServiceState(state, customerRecordId);
  const visibleError = error?.customerRecordId === customerRecordId ? error.message : "";
  if (!visibleState && !visibleError) return null;
  const mutate = async (definition: Definition, desiredState: "active" | "revoked") => {
    if (visibleState?.customerRecordId !== customerRecordId) return;
    const ticket = loadGuard.current!.begin(customerRecordId);
    const current = visibleState.enrollments.find(row => row.serviceId === definition.serviceId);
    setBusy(true); setError(null);
    try {
      const mutationId = crypto.randomUUID();
      await api(`${base}/clients/${encodeURIComponent(customerRecordId)}/enrollments`, { method: "POST",
        headers: { "Idempotency-Key": mutationId }, body: JSON.stringify({ mutationId, idempotencyKey: mutationId,
          customerRecordId, serviceId: definition.serviceId, desiredState, expectedRevision: current?.revision ?? 0 }) });
      await load(ticket);
    } catch { if (loadGuard.current?.current(ticket)) setError({ customerRecordId, message: "The service enrollment was not changed." }); }
    finally { if (loadGuard.current?.current(ticket)) setBusy(false); }
  };
  const createDefinition = async () => {
    if (visibleState?.customerRecordId !== customerRecordId) return;
    const ticket = loadGuard.current!.begin(customerRecordId);
    setBusy(true); setError(null);
    try {
      const mutationId = crypto.randomUUID(), idempotencyKey = crypto.randomUUID();
      await api(`${base}/definitions`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ ...definition, mutationId, idempotencyKey }) });
      if (loadGuard.current?.current(ticket))
        setDefinition({ serviceId: "", providerId: "", sourceId: "", sourceServiceId: "", displayName: "" });
      await load(ticket);
    } catch { if (loadGuard.current?.current(ticket)) setError({ customerRecordId, message: "The service definition was not created." }); }
    finally { if (loadGuard.current?.current(ticket)) setBusy(false); }
  };
  return <Card title="Operations services"><p>Explicit Operations-owned service assignments. Portal, content, and financial access are unchanged.</p>
    {visibleError && <p role="alert">{visibleError}</p>}
    {visibleState && (visibleState.definitions.length ? <ul>{visibleState.definitions.map(definition => {
      const enrollment = visibleState.enrollments.find(row => row.serviceId === definition.serviceId), active = enrollment?.state === "active";
      return <li key={definition.serviceId}><strong>{definition.displayName}</strong> <small>{definition.providerId} / {definition.sourceId}</small>
        <button disabled={busy} onClick={() => void mutate(definition, active ? "revoked" : "active")}>{active ? "Revoke" : "Enroll"}</button></li>;
    })}</ul> : <p>No audited service definitions are available.</p>)}
    <details><summary>Create audited service definition</summary>
      {(["serviceId", "providerId", "sourceId", "sourceServiceId", "displayName"] as const).map(field =>
        <label key={field}>{field}<input value={definition[field]} onChange={event => setDefinition({ ...definition, [field]: event.target.value })} /></label>)}
      <button disabled={busy || Object.values(definition).some(value => !value.trim())} onClick={() => void createDefinition()}>Create definition</button>
    </details>
  </Card>;
}
