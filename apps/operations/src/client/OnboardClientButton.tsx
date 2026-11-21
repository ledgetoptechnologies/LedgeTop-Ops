import { useEffect, useRef, useState } from "react";
import { ClientOnboardingStaff } from "./ClientOnboardingStaff";
import { endpoint, json, validSession } from "./onboarding-staff-api";

export const CLIENT_ONBOARDING_PATH = "/administration/client-onboarding";

/** True only when the onboarding page would open for this person: the same read-only
 * session check that page starts with. A disabled capability, a refusal or a failure hides it. */
export function useClientOnboardingAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void json(`${endpoint}/session`, { method: "GET", signal: controller.signal, headers: { "X-Native-Staff-Request": "1" } })
      .then(value => { if (!controller.signal.aborted) setAvailable(validSession(value)); })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, []);
  return available;
}

/** One obvious way in to onboarding a new client: invite them, then review what they send. */
export function OnboardClientButton({ className = "button button-orange" }: { className?: string }) {
  const available = useClientOnboardingAvailable();
  const [open, setOpen] = useState(false), [mounted, setMounted] = useState(false), [busy, setBusy] = useState(false), [dialogError, setDialogError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null), busyRef = useRef(false);
  const onBusyChange = (value: boolean) => { busyRef.current = value; setBusy(value); };
  useEffect(() => {
    if (!open) return;
    try { if (dialog.current && !dialog.current.open) dialog.current.showModal(); } catch { setOpen(false); setDialogError(true); }
  }, [open]);
  const close = () => {
    if (busyRef.current) return;
    dialog.current?.close(); setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  if (!available) return null;
  return <>
    <button ref={trigger} type="button" className={className} onClick={() => { setDialogError(false); setMounted(true); setOpen(true); }}>Onboard client</button>
    <a className="button button-ghost" href={CLIENT_ONBOARDING_PATH}>Review submissions</a>
    {dialogError && <p role="alert">The dialog couldn't open. <a href={CLIENT_ONBOARDING_PATH}>Open client onboarding</a>.</p>}
    {mounted && <dialog ref={dialog} className="onboarding-dialog" aria-labelledby="onboarding-dialog-title"
      onCancel={event => { event.preventDefault(); close(); }}>
      <header className="onboarding-dialog-header"><h2 id="onboarding-dialog-title">Onboard client</h2>
        <button type="button" className="button-ghost" disabled={busy} onClick={close}>Close</button></header>
      <ClientOnboardingStaff embedded onBusyChange={onBusyChange} />
    </dialog>}
  </>;
}
