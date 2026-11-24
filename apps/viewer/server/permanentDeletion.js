'use strict';

// Nothing in the Recycle Bin is permanently deleted until a later change resumes or refuses the purges earlier versions
// left unfinished (after #762). Remove this file and every use of it with that change. Deleting to the bin, restoring and other cleanup are not affected.
const PERMANENT_DELETION_PAUSED = true;
const PAUSED_CODE = 'permanent_deletion_paused';

function permanentDeletionPaused() { return PERMANENT_DELETION_PAUSED; }

// Called before any effect wherever files, records or journals of a purge would change.
function refusePermanentDeletion() {
  if (module.exports.permanentDeletionPaused()) throw Object.assign(new Error('Permanent deletion is paused while a fix is finished. Items stay in the Recycle Bin.'), { code: PAUSED_CODE });
}

module.exports = { PAUSED_CODE, permanentDeletionPaused, refusePermanentDeletion };
