'use strict';

// Inactive integration boundary. There is no mounted route or configured
// storage owner. A caller-supplied verifier, receipt or boolean cannot open it.
// Do not replace this gate until a separately reviewed storage-owner service
// establishes actual immutable source custody and durable receiver lineage.
function issueAtomicGrant() {
  throw Object.assign(new Error('storage owner authority unavailable'), {code:'REFERENCE_STORAGE_OWNER_UNAVAILABLE'});
}
module.exports=Object.freeze({issueAtomicGrant});
