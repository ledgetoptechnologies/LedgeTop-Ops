const NONCE = /^[A-Za-z0-9_-]{32,128}$/;

export type ViewerReauthorization =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; nonce: string; sameTab: boolean };

/**
 * Reads a Viewer reauthorization bounce (/viewer/reauthorize?state=…). The popup path sends
 * only `state`; the explicit current-tab recovery also sends exactly one
 * `recoveryMode=same-tab`. Anything repeated, malformed or in an unknown mode is refused
 * before a workspace grant is requested, so the mode never widens what Ops issues.
 */
export function parseViewerReauthorization(search: string): ViewerReauthorization {
  const params = new URLSearchParams(search);
  if (!params.has("state") && !params.has("recoveryMode")) return { kind: "none" };
  const states = params.getAll("state"), modes = params.getAll("recoveryMode");
  if (states.length !== 1 || !NONCE.test(states[0]!) || modes.length > 1 || (modes.length === 1 && modes[0] !== "same-tab")) return { kind: "invalid" };
  return { kind: "valid", nonce: states[0]!, sameTab: modes.length === 1 };
}

/** The validated Viewer return fragment: the nonce, plus the mode only for the current-tab path. */
export function viewerReauthorizationFragment(value: { nonce: string; sameTab: boolean }): string {
  const fragment = new URLSearchParams({ reauthorize: value.nonce });
  if (value.sameTab) fragment.set("recoveryMode", "same-tab");
  return fragment.toString();
}
