import { useRef, type KeyboardEvent, type ReactNode } from "react";

export type ShareMethod = "workspace" | "public";
/** The one order and wording for every Share dialog: files, folders and models. */
export const SHARE_METHODS: readonly { mode: ShareMethod; label: string }[] = [
  { mode: "workspace", label: "Client Workspace" },
  { mode: "public", label: "Public link" },
];
const tabId = (mode: ShareMethod) => `share-method-tab-${mode}`;
const panelId = (mode: ShareMethod) => `share-method-panel-${mode}`;

/** The method a tab key moves to, or null for keys the tabs ignore. Disabled methods are skipped. */
export function nextShareMethod(current: ShareMethod, key: string, enabled: Record<ShareMethod, boolean>): ShareMethod | null {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return null;
  const modes = SHARE_METHODS.map(item => item.mode).filter(mode => enabled[mode]);
  if (!modes.length) return current;
  const index = Math.max(0, modes.indexOf(current));
  const next = key === "Home" ? 0 : key === "End" ? modes.length - 1
    : key === "ArrowRight" ? (index + 1) % modes.length : (index - 1 + modes.length) % modes.length;
  return modes[next]!;
}

export function ShareMethodTabs({ mode, onChange, locked = false, disabledReason = {} }: {
  mode: ShareMethod; onChange: (mode: ShareMethod) => void; locked?: boolean;
  /** A method that cannot be used here, with the reason shown on hover. */
  disabledReason?: Partial<Record<ShareMethod, string>>;
}) {
  const tabs = useRef<Partial<Record<ShareMethod, HTMLButtonElement | null>>>({});
  const enabled = { workspace: !disabledReason.workspace, public: !disabledReason.public };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextShareMethod(mode, event.key, enabled);
    if (!next) return;
    event.preventDefault();
    if (locked) return;
    onChange(next);
    tabs.current[next]?.focus();
  };
  return <div className="share-mode-selector ltds-segmented" role="tablist" aria-label="Sharing method">
    {SHARE_METHODS.map(item => <button key={item.mode} ref={element => { tabs.current[item.mode] = element; }} id={tabId(item.mode)} type="button" role="tab"
      aria-selected={mode === item.mode} aria-controls={panelId(item.mode)} tabIndex={mode === item.mode ? 0 : -1}
      className={mode === item.mode ? "active" : "button-ghost"} disabled={locked || !enabled[item.mode]} title={disabledReason[item.mode]}
      onClick={() => onChange(item.mode)} onKeyDown={onKeyDown}>{item.label}</button>)}
  </div>;
}

/** The body under the tabs. `plain` is for a target that offers only one method, so there are no tabs. */
export function ShareMethodPanel({ mode, plain = false, children }: { mode: ShareMethod; plain?: boolean; children: ReactNode }) {
  return plain ? <section>{children}</section>
    : <section id={panelId(mode)} className="share-mode-panel" role="tabpanel" aria-labelledby={tabId(mode)}>{children}</section>;
}
