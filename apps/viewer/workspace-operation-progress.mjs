// One stage label and percent for a background dataset operation, shared by Background work and the
// upload tray so both show the same thing.
const PHASE_LABELS = {existing_model:'Existing model',validating_source:'Validating recovery source',materializing_recovery:'Creating recovery version'};
const KNOWN_PHASES = new Set(['queued','leased','assembling_upload','copying_photos','extracting','staging','discovering','adopting','registering','inspecting','existing_model','validating_source','materializing_recovery','awaiting_derivatives','succeeded','failed','cancelled']);

export function operationPercent(operation) {
  const value = Number(operation?.progress);
  return Math.max(0, Math.min(100, Math.round((Number.isFinite(value) ? value : 0) * 100)));
}

export function operationPhaseLabel(operation) {
  const raw = String(operation?.phase || operation?.status || 'queued');
  return PHASE_LABELS[raw] || (KNOWN_PHASES.has(raw) ? raw : operation?.status || 'working').replaceAll('_', ' ');
}
