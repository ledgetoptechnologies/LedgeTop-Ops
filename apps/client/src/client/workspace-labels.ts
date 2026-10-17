import { projectAlphaSourceName } from "@ltds/shared";

export interface LabelledWorkspace { readonly id: string; readonly displayName: string; readonly sourceId?: string }

const KNOWN_BUSINESS_SOURCES = new Set(["project-alpha:primary", "project-alpha:secondary"]);

/** Client-facing business name for a known source; never echoes a raw or unknown source ID. */
function knownBusinessLabel(sourceId: string | undefined): string | null {
  return sourceId && KNOWN_BUSINESS_SOURCES.has(sourceId) ? projectAlphaSourceName(sourceId) : null;
}

/**
 * Display labels for the workspace switcher, keyed by workspace id.
 * Unique names show alone; duplicate names add the known business label,
 * otherwise (or when that still collides) a neutral ordinal. Display only.
 */
export function workspaceSwitcherLabels(workspaces: readonly LabelledWorkspace[]): Map<string, string> {
  const byName = new Map<string, LabelledWorkspace[]>();
  for (const workspace of workspaces) {
    const group = byName.get(workspace.displayName);
    if (group) group.push(workspace); else byName.set(workspace.displayName, [workspace]);
  }
  const labels = new Map<string, string>();
  for (const [name, group] of byName) {
    if (group.length === 1) { labels.set(group[0]!.id, name); continue; }
    const baseLabels = group.map(workspace => {
      const business = knownBusinessLabel(workspace.sourceId);
      return business ? `${name} — ${business}` : name;
    });
    const totals = new Map<string, number>();
    for (const base of baseLabels) totals.set(base, (totals.get(base) ?? 0) + 1);
    const seen = new Map<string, number>();
    group.forEach((workspace, index) => {
      const base = baseLabels[index]!;
      if (totals.get(base) === 1) { labels.set(workspace.id, base); return; }
      const ordinal = (seen.get(base) ?? 0) + 1;
      seen.set(base, ordinal);
      labels.set(workspace.id, `${base} (${ordinal})`);
    });
  }
  return labels;
}
