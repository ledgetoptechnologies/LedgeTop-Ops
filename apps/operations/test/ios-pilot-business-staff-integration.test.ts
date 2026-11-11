import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStaffLoginFixture, staffLoginClaims } from './helpers/staff-login-fixture';
import type { Env } from '../src/worker/types';

const f = vi.hoisted(() => ({ roots: vi.fn() }));
vi.mock('../src/worker/client-hub-directory', () => ({ listClientHubRoots: f.roots }));
vi.mock('../src/worker/client-hub', () => ({ resolveClientHubDetailContext: vi.fn(), verifyClientHubDetailContext: vi.fn() }));
vi.mock('../src/worker/client-hub-business-projects', () => ({ listClientHubBusinessProjects: vi.fn() }));
vi.mock('../src/worker/client-hub-project-policy', () => ({ readClientHubBusinessProjectPolicy: vi.fn() }));
import { pilotSessionFromAccessClaims } from '../src/worker/ios-pilot-session';
import { readPilotBusinessRoots } from '../src/worker/ios-pilot-business-reads';

let fixture: Awaited<ReturnType<typeof createStaffLoginFixture>>;
let env: Env;
beforeAll(async () => {
  fixture = await createStaffLoginFixture();
  env = { OPS_DB: fixture.db, TEAM_DOMAIN: fixture.issuer, ENVIRONMENT: 'staging' } as Env;
});
afterAll(async () => fixture?.runtime.dispose());

it('uses the real staff binding and refuses a disabled staff session before reading the directory', async () => {
  const session = await pilotSessionFromAccessClaims(env, staffLoginClaims(fixture.owner.email, fixture.owner.subject));
  f.roots.mockResolvedValue({ clients: [], nextCursor: null });
  await expect(readPilotBusinessRoots(env, session)).resolves.toEqual({ schemaVersion: 1, roots: [], nextCursor: null });
  f.roots.mockClear();
  await fixture.db.prepare("UPDATE staff_users SET status='disabled' WHERE id=?").bind(fixture.owner.id).run();
  await expect(readPilotBusinessRoots(env, session)).rejects.toThrow();
  expect(f.roots).not.toHaveBeenCalled();
  await fixture.db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(fixture.owner.id).run();
  f.roots.mockImplementationOnce(async () => {
    await fixture.db.prepare("UPDATE staff_users SET status='disabled' WHERE id=?").bind(fixture.owner.id).run();
    return { clients: [], nextCursor: null };
  });
  await expect(readPilotBusinessRoots(env, session)).rejects.toThrow();
}, 30_000);
