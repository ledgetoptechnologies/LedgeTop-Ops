'use strict';

// CIFS servers can expose 0/0 when inode counts are unavailable. This is not
// evidence of free inodes; admit only with explicit operator opt-in. Preserve
// all independent byte-reserve, concurrency and file-count limits.
const CIFS_MAGIC = 0xfe534d42;
function inodeHeadroom(space, { allowCifsUnknown = false, expectedFiles = 0 } = {}) {
  const total = space?.files, free = space?.ffree;
  const fail = message => { throw Object.assign(new Error(message), { code: 'insufficient_storage' }); };
  if (!Number.isSafeInteger(expectedFiles) || expectedFiles < 0 ||
      !Number.isSafeInteger(total) || !Number.isSafeInteger(free) || total < 0 || free < 0 || free > total) {
    fail('inode headroom is unavailable');
  }
  if (total === 0 && free === 0) {
    if (allowCifsUnknown !== true || space.fsType !== CIFS_MAGIC) fail('inode headroom is unavailable');
    return { inodeCapacity: 'unavailable', inodeReserve: null };
  }
  if (total === 0) fail('inode headroom is unavailable');
  const inodeReserve = Math.min(100000, Math.max(10000, Math.ceil(total * 0.05)));
  if (free - expectedFiles < inodeReserve) fail('insufficient inode headroom');
  return { inodeCapacity: 'measured', inodeReserve };
}

function recheckInodeHeadroom(space, admission, allowCifsUnknown) {
  const current = inodeHeadroom(space, { allowCifsUnknown });
  // An admission based on measured capacity must not silently degrade to an
  // unknown capacity even if the opt-in is enabled.
  if (admission.inodeCapacity === 'measured' && current.inodeCapacity !== 'measured') {
    throw Object.assign(new Error('inode headroom became unavailable'), { code: 'insufficient_storage' });
  }
  if (current.inodeCapacity === 'measured') {
    // Preserve the strongest earlier reserve if the filesystem reports a lower
    // inode total later. The caller carries this result to the next check.
    current.inodeReserve = Math.max(current.inodeReserve, admission.inodeReserve ?? 0);
  }
  if (current.inodeCapacity === 'measured' && space.ffree <= current.inodeReserve) {
    throw Object.assign(new Error('insufficient inode headroom'), { code: 'insufficient_storage' });
  }
  return current;
}
function guardDerivativeStorage(space, admission, allowCifsUnknown) {
  if (!Number.isFinite(space?.available) || !Number.isFinite(space?.reserve) ||
      space.available <= space.reserve + 5 * 1024 ** 3) {
    throw Object.assign(new Error('derivative storage headroom fell below the safety reserve'), {code:'insufficient_storage'});
  }
  return recheckInodeHeadroom(space, admission, allowCifsUnknown);
}
module.exports = { CIFS_MAGIC, inodeHeadroom, recheckInodeHeadroom, guardDerivativeStorage };
