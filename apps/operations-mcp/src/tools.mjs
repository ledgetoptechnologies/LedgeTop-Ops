import { z } from 'zod';

const text = (max = 191) => z.string().min(1).max(max).refine(v => !/[\p{C}]/u.test(v));
const segment = text().refine(v => v !== '.' && v !== '..' && !/[\\/]/u.test(v));
const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const folderRef = z.string().regex(/^[A-Za-z0-9_-]{2,1400}$/);
const reason = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/);
const operationId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const source = z.string().regex(/^(?:project-alpha:[a-z0-9][a-z0-9_-]{0,63}|delivery:local)$/);
const target = {
  sourceId: source,
  rootNamespace: z.enum(['business', 'portal', 'account', 'review']),
  kind: z.enum(['organizations', 'standalone']).describe('Use route_kind from find_clients: organizations or standalone.'),
  publicId: segment.describe('Namespace-local public_id from find_clients; never substitute pa_public_id.'),
};
const page = { cursor: text(8192).optional(), limit: z.number().int().min(1).max(100).optional() };
const audienceType = z.enum(['organization', 'department', 'client', 'project', 'principal']);
const accessTerms = z.strictObject({ kind: z.enum(['customer', 'collaborator']),
  mode: z.enum(['specific_date', 'project_end', 'until_revoked']), expiresAt: z.string().max(40).nullable() });
const grant = { folderBindingId: opaque, audienceType, audiencePublicId: opaque, reasonCode: reason,
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(), accessTerms: accessTerms.optional() };
const rootPath = a => `/api/client-hub/sources/${[a.sourceId, a.rootNamespace, a.kind, a.publicId].map(encodeURIComponent).join('/')}`;
const query = (path, values) => {
  const params = new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  return `${path}${params.size ? `?${params}` : ''}`;
};
const scalar = max => z.string().max(max).refine(v => !/[\p{C}]/u.test(v));
const clientProfile = z.strictObject({
  name: text(150), email: scalar(255), phone: scalar(50), clientType: z.enum(['unknown', 'business', 'consumer']),
  addressLine1: scalar(255), addressLine2: scalar(255), city: scalar(100), state: scalar(2), postalCode: scalar(20), country: scalar(100),
});

/** Fixed routes only: models cannot supply URLs, headers, credentials, or arbitrary HTTP methods. */
export function buildTools(client, { allowWrites = false } = {}) {
  const tools = [];
  const add = (name, description, shape, execute, { write = false, destructive = false } = {}) => {
    if (write && !allowWrites) return;
    tools.push({ name, description, schema: z.strictObject(shape), execute,
      annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: true, openWorldHint: false } });
  };
  add('get_connection', 'Check the signed-in Operations staff identity and local write setting. Never returns credentials.', {}, () => client.session());
  add('find_clients', 'Search authorized client records. Preserve source_id, root_namespace, route_kind and public_id for subsequent calls. Similar names or email addresses do not prove identity.',
    { q: text(200).optional(), source: source.optional(), kind: z.enum(['organization', 'standalone_client']).optional(), ...page },
    a => client.request(query('/api/client-hub', { ...a, grouping: 'records', sort: 'name' })));
  add('get_client', 'Read an exact source-qualified client record and available capabilities.', target, a => client.request(rootPath(a)));
  add('get_client_access', 'Read the client external-access roster. This does not create or activate portal access.',
    { ...target, ...page, q: text(200).optional(), status: z.enum(['current','all','active','unassigned','pending','suspended','blocked','expired','revoked']).optional() },
    ({ cursor, limit, q, status, ...a }) => client.request(query(`${rootPath(a)}/external-access`, { cursor, limit, q, status })));
  add('list_delivery_folder', 'Browse authorized delivery folders to find folder references; no file bytes are downloaded.',
    { prefix: z.string().max(1400).optional(), cursor: text(8192).optional() },
    a => client.request(query('/api/delivery/folders', a)));
  add('get_existing_public_link', 'Retrieve an already active public link for one authorized delivery folder or file. Use the exact prefix and optional itemRef returned by list_delivery_folder. Does not create, renew, change, or send a link; null means no active share. A returned shareUrl is bearer access: disclose it only to the requesting authorized user. Existing server sharing permissions apply.',
    { prefix: text(1024), itemRef: folderRef.optional() },
    a => client.request(query('/api/delivery/shares/active', a)));
  add('list_delivery_grants', 'Inspect existing grants and folder bindings for an authorized folder. grantId is the logical grant ID; id is a physical record ID.',
    { folderRef }, a => client.request(query('/api/delivery/authenticated-grants', a)));
  add('find_grant_audiences', 'Find current authorized recipients for an existing folder binding. Use returned IDs, never infer them from names.',
    { folderBindingId: opaque, q: text(100).refine(v => v.length >= 2), audienceType: audienceType.optional() },
    a => client.request(query('/api/delivery/authenticated-grants/audiences', a)));
  add('preview_delivery_access', 'Preview access and recipient scope without granting it. A dynamic audience can include future members. Present this scope before creating a grant and retain contextVersion.',
    grant, a => client.request('/api/delivery/authenticated-grants/preview', { method: 'POST', body: a }));
  add('get_client_creation_options', 'Read authorized source and scope choices for creating a client. Feature gates and native staff admission still apply.',
    {}, () => client.request('/api/client-hub/directory/create-options?kind=client'));
  add('create_client', 'Create a client directory record using existing admission and synchronization workflows. Does not enroll a login identity, invite anyone, or grant portal access. Preserve mutationId and exact arguments on uncertain retries; inspect delivery state before reporting remote completion.',
    { mutationId: operationId, sourceIds: z.array(source.refine(v => v.startsWith('project-alpha:'))).min(1).max(16),
      scopes: z.array(z.strictObject({ businessAreaId: text(), divisionId: text().nullable() })).min(1).max(64),
      profile: clientProfile,
      relationship: z.strictObject({ organizationRecordId: segment.nullable(), expectedOrganizationVersion: z.number().int().positive().nullable() })
        .refine(v => (v.organizationRecordId === null) === (v.expectedOrganizationVersion === null)),
    }, async a => {
      const prepared = await client.request('/api/client-hub/directory/create-admissions', {
        method: 'POST', body: { ...a, kind: 'client' }, idempotencyKey: a.mutationId,
      });
      if (prepared?.status !== 'prepared') return { stage: 'admission', result: prepared };
      return { stage: 'create', result: await client.request('/api/client-hub/directory/standalone-clients', {
        method: 'POST', body: a, idempotencyKey: a.mutationId,
      }) };
    }, { write: true });
  add('grant_delivery_access', 'Create exactly the access reviewed with preview_delivery_access. Requires its contextVersion. Keep operationId and the exact payload for retries; use backend state as evidence of completion. May trigger existing delivery notifications.',
    { ...grant, operationId, expectedContextVersion: z.string().regex(/^[a-f0-9]{64}$/) },
    ({ operationId, ...body }) => client.request('/api/delivery/authenticated-grants', { method: 'POST', body, idempotencyKey: operationId }),
    { write: true });
  add('revoke_delivery_access', 'Revoke one logical grantId from list_delivery_grants at its observed version. Keep operationId for retries. This removes access.',
    { grantId: opaque, expectedVersion: z.number().int().positive(), reasonCode: reason, operationId },
    ({ grantId, operationId, ...body }) => client.request(`/api/delivery/authenticated-grants/${encodeURIComponent(grantId)}/revoke`,
      { method: 'POST', body, idempotencyKey: operationId }), { write: true, destructive: true });
  return tools;
}
