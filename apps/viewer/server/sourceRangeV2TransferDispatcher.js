'use strict';

// Candidate adapter from the durable reference dispatcher to the source-range
// broker. It persists the exact grant before POST and never remints while an
// outbox row exists for that reservation.
const fail = code => { throw Object.assign(new Error(code), { code }); };

function createSourceRangeV2TransferDispatcher({ runtime, outbox, journal } = {}) {
  if (typeof runtime?.mintGrant !== 'function' || typeof outbox?.find !== 'function'
      || typeof outbox?.prepare !== 'function' || typeof outbox?.sendOnce !== 'function'
      || typeof journal?.read !== 'function') fail('source_range_dispatch_configuration_invalid');

  return {
    async dispatchOnce({ claim, provider, job, expected, manifest, signal } = {}) {
      if (!claim || claim.kind !== 'dispatch' || !job || job.phase !== 'awaiting_transfer'
          || job.transferGrantAcknowledgement || job.transferRequest?.protocol !== 'source-range-v2'
          || !manifest || manifest.sha256 !== job.manifestSha256 || !provider || !expected) fail('source_range_dispatch_binding_invalid');
      journal.read(claim);
      const transfer = job.transferRequest;
      let row = outbox.find(claim.attemptId, transfer.reservationId, transfer.generation);
      if (!row) {
        const grant = await runtime.mintGrant({ ...job, submission: { manifest } });
        journal.read(claim);
        row = outbox.prepare(claim, { job, reservation: transfer, manifestSha256: manifest.sha256, grant });
      }
      journal.read(claim);
      if (row.state === 'acknowledged') return row;
      if (row.state !== 'prepared') fail('reference_transfer_outbox_reconciliation_required');
      return outbox.sendOnce(claim, row.outbox_id, { provider, expectedBinding: expected, signal });
    },
  };
}

module.exports = { createSourceRangeV2TransferDispatcher };
