/** Minimal, fail-closed projections for the proposed read-only mobile client.
 * Authorization and freshness must be checked by the calling read facade. */
type RecordValue = Record<string, unknown>;

function requiredString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid mobile projection');
  }
  return value;
}

function optionalString(value: unknown, maximum: number): string | null {
  return value == null ? null : requiredString(value, maximum);
}

export function projectPilotBusinessRoot(root: RecordValue) {
  const sourceId = requiredString(root.source_id, 128);
  const rootNamespace = requiredString(root.root_namespace, 32);
  const kind = requiredString(root.kind, 32);
  if (!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId) || rootNamespace !== 'business'
    || (kind !== 'organization' && kind !== 'standalone_client')) throw new Error('Invalid mobile root');
  return { sourceId, rootNamespace, kind, publicId: requiredString(root.public_id, 512),
    name: requiredString(root.display_name, 512) };
}

export function projectPilotBusinessProject(row: RecordValue) {
  const origin = requiredString(row.origin, 32);
  if (origin !== 'pa' && origin !== 'canonical') throw new Error('Invalid mobile project origin');
  return { id: requiredString(row.id, 512), origin, name: requiredString(row.name, 512),
    status: optionalString(row.status, 128), startDate: optionalString(row.start_date, 64),
    endDate: optionalString(row.end_date, 64) };
}
