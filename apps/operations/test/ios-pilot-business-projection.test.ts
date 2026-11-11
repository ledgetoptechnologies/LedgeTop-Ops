import { describe, expect, it } from 'vitest';
import { projectPilotBusinessProject, projectPilotBusinessRoot } from '../src/worker/ios-pilot-business-projection';

describe('read-only mobile business projections', () => {
  it('returns only the source-qualified root and display name', () => {
    expect(projectPilotBusinessRoot({ source_id: 'project-alpha:staging', root_namespace: 'business',
      kind: 'organization', public_id: 'root-1', display_name: 'Example', email: 'private@example.invalid' }))
      .toEqual({ sourceId: 'project-alpha:staging', rootNamespace: 'business', kind: 'organization',
        publicId: 'root-1', name: 'Example' });
  });

  it('rejects review, portal and malformed roots', () => {
    const root = { source_id: 'project-alpha:staging', root_namespace: 'business', kind: 'organization',
      public_id: 'root-1', display_name: 'Example' };
    for (const change of [{ root_namespace: 'review' }, { root_namespace: 'portal' },
      { source_id: 'other' }, { source_id: 'project-alpha:' }, { kind: 'contact' }, { public_id: 'bad\nvalue' }]) {
      expect(() => projectPilotBusinessRoot({ ...root, ...change })).toThrow();
    }
  });

  it('omits manager, contacts and financial fields from projects', () => {
    expect(projectPilotBusinessProject({ id: 'project-1', origin: 'canonical', name: 'Example project',
      status: 'active', start_date: null, end_date: '2026-11-15', manager_name: 'Private', budget: 100 }))
      .toEqual({ id: 'project-1', origin: 'canonical', name: 'Example project', status: 'active',
        startDate: null, endDate: '2026-11-15' });
  });

  it('preserves a missing project status as null', () => {
    expect(projectPilotBusinessProject({ id: 'project-1', origin: 'pa', name: 'Example', status: null }).status).toBeNull();
  });

  it('fails closed on missing, malformed, or unrecognized project fields', () => {
    const row = { id: 'project-1', origin: 'pa', name: 'Example', status: 'active' };
    for (const change of [{ origin: 'other' }, { id: '' }, { name: null }, { status: 'bad\nvalue' }]) {
      expect(() => projectPilotBusinessProject({ ...row, ...change })).toThrow();
    }
  });
});
