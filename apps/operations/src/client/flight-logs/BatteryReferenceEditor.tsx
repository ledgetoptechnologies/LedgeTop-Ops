import { useState } from "react";
import { api, ApiError, sessionScope } from "../api";
import { normalizeBatteryReference } from "../../../../logs/src/battery-reference.mjs";
import { isUncertain, withOperationKey } from "./operation-keys";

/** Keep an uncertain save's input frozen so retrying cannot change its meaning. */
export function BatteryReferenceEditor({ aircraftId, batteryId, referenceName, onSaved }: {
  aircraftId: string; batteryId: string; referenceName?: string | null; onSaved: () => void;
}) {
  const [draft, setDraft] = useState(referenceName ?? "");
  const [pending, setPending] = useState<{ referenceName: string | null; action: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(clear = false) {
    let name: string | null;
    try { name = normalizeBatteryReference(clear ? null : draft); }
    catch { setMessage("Use a reference name of up to 40 characters after the optional Battery prefix."); return; }
    const attempt = pending ?? { referenceName: name, action: `battery-reference:${aircraftId}:${batteryId}:${crypto.randomUUID()}` };
    setPending(attempt); setBusy(true); setMessage("");
    const scope = sessionScope();
    try {
      const result = await withOperationKey(scope, attempt.action, async key => {
        let result: { aircraftId: string; batteryId: string; referenceName: string | null };
        try {
          result = await api<typeof result>(`/api/flight-logs/aircraft/${encodeURIComponent(aircraftId)}/batteries/${encodeURIComponent(batteryId)}/reference`, {
            method: "PUT", headers: { "Idempotency-Key": key }, body: JSON.stringify({ referenceName: attempt.referenceName }),
          });
        } catch (error) {
          if (error instanceof ApiError && error.status === 409 && error.payload.code === "battery_name_taken")
            return { kind: "conflict" as const, message: error.message };
          throw error;
        }
        if (result.aircraftId !== aircraftId || result.batteryId !== batteryId || !(result.referenceName === null || typeof result.referenceName === "string"))
          throw new Error("The save couldn’t be confirmed. Retry to confirm it.");
        return { kind: "saved" as const, value: result };
      });
      setPending(null);
      if (result.kind === "conflict") { setMessage(result.message); return; }
      setDraft(result.value.referenceName ?? ""); setMessage("Battery reference saved."); onSaved();
    } catch (error) {
      if (!isUncertain(scope, attempt.action)) setPending(null);
      setMessage(error instanceof Error ? error.message : "The save couldn’t be confirmed. Retry to confirm it.");
    } finally { setBusy(false); }
  }
  return <div className="flight-battery-editor">
    <label>Battery reference name <input value={draft} maxLength={40} disabled={busy || !!pending}
      placeholder="For example, 1" onChange={event => setDraft(event.currentTarget.value)} /></label>
    <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => void save()}>{pending ? "Retry save" : "Save name"}</button>
    <button type="button" className="button-ghost button-small" disabled={busy || !!pending || !referenceName} onClick={() => void save(true)}>Clear name</button>
    {pending && !busy && <small>Confirm the earlier save before changing the name.</small>}
    {message && <small role="status">{message}</small>}
  </div>;
}
