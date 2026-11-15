import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/types';
import type { PilotSession } from '../src/worker/ios-pilot-session';

const calls = vi.hoisted(() => ({ directory: vi.fn(), resolve: vi.fn(), projects: vi.fn(), verify: vi.fn() }));
vi.mock('../src/worker/client-hub-directory', () => ({ listClientHubRoots: calls.directory }));
vi.mock('../src/worker/client-hub', () => ({ resolveClientHubDetailContext: calls.resolve, verifyClientHubDetailContext: calls.verify }));
vi.mock('../src/worker/client-hub-business-projects', () => ({ listClientHubBusinessProjects: calls.projects }));
import { readPilotBusiness, PILOT_BUSINESS_SOURCE } from '../src/worker/ios-pilot-business-reads';

const env = { ENVIRONMENT: 'staging' } as Env;
function session(id = 'staff-a'): PilotSession {
  const email = `${id}@example.test`, subject = `access|${id}`, expiresAt = Math.floor(Date.now() / 1000) + 300;
  return { proof: { kind: 'primary', staffId: id, canonicalEmail: email, canonicalSubject: subject,
    issuer: 'https://synthetic.cloudflareaccess.com', email, subject, expiresAt, bindingId: null, bindingVersion: 0, generation: 0 },
    principal: { id, email, accessSubject: subject, displayName: id, projectAlphaUserId: null },
    admission: { mode: 'legacy' }, expiresAt };
}
const root = { source_id: PILOT_BUSINESS_SOURCE, root_namespace: 'business', kind: 'organization',
  public_id: 'organization-a', display_name: 'Synthetic organization', pa_internal_id: 'private-pa-id', email: 'private@example.test' };
const selection = { kind: 'organization' as const, id: 'organization-a' };
beforeEach(() => {
  vi.clearAllMocks();
  calls.directory.mockResolvedValue({ clients: [root], nextCursor: null });
  calls.resolve.mockResolvedValue({ root, contextVersion: 'context-proof' });
  calls.projects.mockResolvedValue({ items: [{ id: 'project-a', origin: 'pa', name: 'Synthetic project', status: 'active',
    start_date: null, end_date: null, manager_name: 'Private manager', payload_json: 'private' }],
    page: { available: true, nextCursor: null } });
  calls.verify.mockResolvedValue(undefined);
});

describe('narrow pilot business projection and cursor contract (mocked data helpers)', () => {
  it('selects only the pinned source and projects roots without private fields', async () => {
    const result = await readPilotBusiness(env, session(), { cursor: null });
    expect(result).toEqual({ schemaVersion: 1, roots: [{ sourceId: PILOT_BUSINESS_SOURCE, rootNamespace: 'business',
      kind: 'organization', clientHubRootId: 'organization-a', name: 'Synthetic organization' }], nextCursor: null });
    expect(calls.directory).toHaveBeenCalledWith(env, expect.any(Object), { source: PILOT_BUSINESS_SOURCE,
      grouping: 'records', sort: 'name', limit: 20 });
    expect(JSON.stringify(result)).not.toMatch(/private|email|pa_internal/);
  });
  it('keeps a next page after filtering an authorized non-business directory page', async () => {
    const actor = session();
    calls.directory.mockResolvedValueOnce({ clients: [{ ...root, root_namespace: 'portal' }], nextCursor: 'opaque-helper-cursor' });
    const first = await readPilotBusiness(env, actor, { cursor: null });
    expect(first).toMatchObject({ roots: [] });
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{1,4096}$/);
    await readPilotBusiness(env, actor, { cursor: first.nextCursor });
    expect(calls.directory.mock.calls.at(-1)?.[2]).toMatchObject({ cursor: 'opaque-helper-cursor' });
  });
  it('rejects a cursor reused for another actor, collection, root or namespace', async () => {
    const actor = session();
    calls.projects.mockResolvedValue({ items: [], page: { available: true, nextCursor: 'project-helper-cursor' } });
    const first = await readPilotBusiness(env, actor, { cursor: null, selection });
    expect(first.nextCursor).not.toBeNull();
    const count = calls.resolve.mock.calls.length;
    for (const options of [{ cursor: first.nextCursor }, { cursor: first.nextCursor, selection: { ...selection, id: 'other-root' } }])
      await expect(readPilotBusiness(env, actor, options)).rejects.toMatchObject({ status: 400 });
    await expect(readPilotBusiness(env, session('staff-b'), { cursor: first.nextCursor, selection })).rejects.toMatchObject({ status: 400 });
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    for (const patch of [{ namespace: 'portal' }, { source: 'project-alpha:other' }]) {
      const forged = Buffer.from(JSON.stringify({ ...cursor, ...patch })).toString('base64url');
      await expect(readPilotBusiness(env, actor, { cursor: forged, selection })).rejects.toMatchObject({ status: 400 });
    }
    expect(calls.resolve).toHaveBeenCalledTimes(count);
  });
  it('projects only approved project fields and rechecks the exact root context after hydration', async () => {
    const actor = session();
    expect(await readPilotBusiness(env, actor, { cursor: null, selection })).toEqual({ schemaVersion: 1,
      projects: [{ id: 'project-a', origin: 'pa', name: 'Synthetic project', status: 'active', startDate: null, endDate: null }], nextCursor: null });
    expect(calls.resolve).toHaveBeenCalledWith(env, actor.principal, 'organization', 'organization-a', PILOT_BUSINESS_SOURCE, 'business');
    expect(calls.verify).toHaveBeenCalledWith(env, actor.principal, expect.objectContaining({ contextVersion: 'context-proof' }));
  });
  it('does not turn permission, source, context or malformed-data failures into empty successful pages', async () => {
    calls.resolve.mockResolvedValueOnce({ root: { ...root, source_id: 'project-alpha:other' } });
    await expect(readPilotBusiness(env, session(), { cursor: null, selection })).rejects.toMatchObject({ status: 503 });
    calls.projects.mockResolvedValueOnce({ items: [], page: { available: false, nextCursor: null } });
    await expect(readPilotBusiness(env, session(), { cursor: null, selection })).rejects.toMatchObject({ status: 503 });
    calls.verify.mockRejectedValueOnce(Error('context changed'));
    await expect(readPilotBusiness(env, session(), { cursor: null, selection })).rejects.toThrow('context changed');
    calls.directory.mockResolvedValueOnce({ clients: [{ ...root, display_name: '' }], nextCursor: null });
    await expect(readPilotBusiness(env, session(), { cursor: null })).rejects.toMatchObject({ status: 503 });
  });
  it('bounds page size and rejects an oversized or noncanonical encoded cursor', async () => {
    calls.directory.mockResolvedValueOnce({ clients: Array(21).fill(root), nextCursor: null });
    await expect(readPilotBusiness(env, session(), { cursor: null })).rejects.toMatchObject({ status: 503 });
    for (const cursor of ['x'.repeat(4097), 'not+base64', 'e30', 'e30='])
      await expect(readPilotBusiness(env, session(), { cursor })).rejects.toMatchObject({ status: 400 });
  });
});
