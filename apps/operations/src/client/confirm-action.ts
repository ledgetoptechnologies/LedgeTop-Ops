import "./confirm-action.css";

let active = false;

/** In-page confirmation only: callers retain their already-reviewed operation snapshot. */
export function confirmAction(message: string): Promise<boolean> {
  // Never queue confirmations: a repeated click must not dispatch a second operation.
  if (active) return Promise.resolve(false);
  active = true;
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "ops-confirm-action";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "ops-confirm-title");
    dialog.setAttribute("aria-describedby", "ops-confirm-description");
    const title = document.createElement("h2");
    title.id = "ops-confirm-title"; title.textContent = "Confirm action";
    const description = document.createElement("p");
    description.id = "ops-confirm-description"; description.textContent = message;
    const actions = document.createElement("div");
    actions.className = "ops-confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "button-ghost"; cancel.textContent = "Cancel";
    const confirm = document.createElement("button");
    confirm.type = "button"; confirm.className = "button-orange"; confirm.textContent = "Confirm";
    actions.appendChild(cancel); actions.appendChild(confirm);
    dialog.appendChild(title); dialog.appendChild(description); dialog.appendChild(actions);
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true; cancel.disabled = true; confirm.disabled = true;
      observer.disconnect();
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("popstate", leave);
      if (dialog.open) dialog.close();
      dialog.remove();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      resolve(accepted);
      // Keep the claim through the caller's continuation and React's busy-state update.
      queueMicrotask(() => { active = false; });
    };
    const leave = () => finish(false);
    // If the initiating view unmounts, its now-stale mutation must not proceed.
    const observer = new MutationObserver(() => {
      if (trigger && !trigger.isConnected || !dialog.isConnected) finish(false);
    });
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    dialog.addEventListener("close", () => finish(false));
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      // Explicit wrap complements showModal's inert background, including reverse Tab.
      if (event.shiftKey && document.activeElement === cancel) { event.preventDefault(); confirm.focus(); }
      else if (!event.shiftKey && document.activeElement === confirm) { event.preventDefault(); cancel.focus(); }
    });
    document.body.appendChild(dialog);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("pagehide", leave);
    window.addEventListener("popstate", leave);
    try { dialog.showModal(); cancel.focus(); }
    catch { finish(false); } // Unsupported/failed dialog is cancellation, never implicit approval.
  });
}
