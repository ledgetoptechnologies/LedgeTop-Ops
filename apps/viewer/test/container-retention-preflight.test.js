'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { purgeContainerTrash } = require('../server/containerLifecycle');

for (const type of ['project', 'task']) {
  test(`retained ${type} stops container purge before touching any member`, () => {
    const root = { id: 'root', entityId: 'entity', entityType: type, permanentlyDeletedAt: null };
    let memberReads = 0;
    const processing = {
      getTrash: () => root,
      getProject: () => ({ status: 'archived' }),
      getTask: () => ({ status: 'archived', datasetId: 'dataset' }),
      hasRetainedSourceInProject: () => true,
      hasDatasetRetentionHold: () => true,
      listContainerTrashMembers: () => { memberReads++; return []; },
    };
    assert.equal(purgeContainerTrash(processing, {}, root.id, 'test'), null);
    assert.equal(memberReads, 0);
  });
}
