import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/types';
import type { PilotSession } from '../src/worker/ios-pilot-session';

const f = vi.hoisted(() => ({ resolve: vi.fn(), list: vi.fn(), roots: vi.fn(), policy: vi.fn(), verify: vi.fn(), recheck: vi.fn() }));
vi.mock('../src/worker/client-hub', () => ({ resolveClientHubDetailContext: f.resolve, verifyClientHubDetailContext: f.verify }));
vi.mock('../src/worker/client-hub-business-projects', () => ({ listClientHubBusinessProjects: f.list }));
vi.mock('../src/worker/client-hub-directory', () => ({ listClientHubRoots: f.roots }));
vi.mock('../src/worker/client-hub-project-policy', () => ({ readClientHubBusinessProjectPolicy: f.policy }));
vi.mock('../src/worker/ios-pilot-session', () => ({ recheckPilotSession: f.recheck }));
import { readPilotBusinessProjects, readPilotBusinessRoots } from '../src/worker/ios-pilot-business-reads';

const env = {} as Env;
const session = { principal: { id: 'staff' } } as PilotSession;
const root = { sourceId: 'project-alpha:staging', kind: 'organization' as const, clientHubRootId: 'client-1' };

beforeEach(() => {
  vi.resetAllMocks();
  f.resolve.mockResolvedValue({ contextVersion: 'context' });
  f.list.mockResolvedValue({ items: [{ id: 'project-1', origin: 'pa', name: 'Project', status: 'active',
    manager_name: 'Private', amount: 123 }], page: { available: true, nextCursor: null } });
  f.verify.mockResolvedValue(undefined);
  f.recheck.mockResolvedValue(undefined);
  f.policy.mockResolvedValue({ allowed: true, proof: 'proof' });
  f.roots.mockResolvedValue({ clients: [{ source_id: 'project-alpha:staging', root_namespace: 'business',
    kind: 'organization', public_id: 'client-1', display_name: 'Client', secret: 'private' },
    { source_id: 'delivery:local', root_namespace: 'portal' }], nextCursor: 'next' });
});

describe('mobile exact-root business project read', () => {
  it('uses directory authorization and returns only business root fields', async () => {
    await expect(readPilotBusinessRoots(env, session)).resolves.toEqual({ schemaVersion: 1,
      roots: [{ sourceId: 'project-alpha:staging', rootNamespace: 'business', kind: 'organization', clientHubRootId: 'client-1', name: 'Client' }],
      nextCursor: 'next' });
    expect(f.roots).toHaveBeenCalledWith(env, session.principal, { limit: 20, grouping: 'records', sort: 'name' });
    expect(f.recheck).toHaveBeenCalledTimes(2);
  });

  it('does not return a directory page after staff admission changes', async () => {
    f.recheck.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('session changed'));
    await expect(readPilotBusinessRoots(env, session)).rejects.toThrow('session changed');
  });

  it('retains the cursor when a page contains only filtered namespaces', async () => {
    f.roots.mockResolvedValueOnce({ clients: [{ source_id: 'delivery:local', root_namespace: 'portal' }], nextCursor: 'next' });
    await expect(readPilotBusinessRoots(env, session)).resolves.toEqual({ schemaVersion: 1, roots: [], nextCursor: 'next' });
  });

  it('uses the existing principal and exact business root and returns an allowlist', async () => {
    await expect(readPilotBusinessProjects(env, session, root)).resolves.toEqual({ schemaVersion: 1,
      projects: [{ id: 'project-1', origin: 'pa', name: 'Project', status: 'active', startDate: null, endDate: null }], nextCursor: null });
    expect(f.resolve).toHaveBeenCalledWith(env, session.principal, 'organization', 'client-1', 'project-alpha:staging', 'business');
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.recheck).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid roots and cursors before reading', async () => {
    await expect(readPilotBusinessProjects(env, session, { ...root, sourceId: 'other' })).rejects.toThrow();
    await expect(readPilotBusinessProjects(env, session, root, 'bad cursor')).rejects.toThrow();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it('fails closed if permission or context changes before the response', async () => {
    f.verify.mockRejectedValueOnce(new Error('changed'));
    await expect(readPilotBusinessProjects(env, session, root)).rejects.toThrow('changed');
    f.list.mockResolvedValueOnce({ items: [], page: { available: false, nextCursor: null } });
    await expect(readPilotBusinessProjects(env, session, root)).rejects.toThrow();
  });

  it('does not return results if staff admission changes during the read', async () => {
    f.recheck.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('session changed'));
    await expect(readPilotBusinessProjects(env, session, root)).rejects.toThrow('session changed');
  });

  it('does not return projects when the project policy changes during the read', async () => {
    f.policy.mockResolvedValueOnce({ allowed: true, proof: 'before' }).mockResolvedValueOnce({ allowed: true, proof: 'after' });
    await expect(readPilotBusinessProjects(env, session, root)).rejects.toThrow();
  });

  it('preserves origin to distinguish projects with the same id', async () => {
    f.list.mockResolvedValueOnce({ items: ['pa', 'canonical'].map(origin => ({ id: 'same', origin, name: 'Project', status: null })),
      page: { available: true, nextCursor: null } });
    const result = await readPilotBusinessProjects(env, session, root);
    expect(result.projects.map(project => [project.origin, project.id])).toEqual([['pa', 'same'], ['canonical', 'same']]);
  });
});
