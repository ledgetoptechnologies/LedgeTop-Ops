'use strict';

// The coordinator extension is opt-in; callers must positively identify v1
// before using it and must persist the capability before sending a request.
const { boundedJson } = require('./nodeOdmProvider');
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validCapability(value) {
  return typeof value === 'string' && CAPABILITY.test(value)
    && Buffer.from(value, 'base64url').length === 32
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function supportsReservations(info) {
  const value = info?.ledgetopReservations;
  return value?.version === 1 && value.capabilityEncoding === 'base64url-32'
    && value.retention === 'indefinite' && value.runningCancellation === 'requires_inspection'
    && Number.isSafeInteger(value.remaining) && value.remaining >= 0;
}

async function action(provider, operation, uuid, capability, { signal = null } = {}) {
  if (!['reserve', 'cancel'].includes(operation) || !UUID.test(uuid) || !validCapability(capability)) {
    throw Object.assign(new Error('Invalid reservation request'), { code: 'invalid_reservation_request' });
  }
  const response = await provider.request(`/task/ledgetop/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-LedgeTop-Capability': capability },
    body: new URLSearchParams({ uuid }),
  }, {}, { signal });
  const result = await boundedJson(response);
  const expected = operation === 'reserve' ? 'reserved' : 'cancelled';
  if (!result || (result.state !== expected && !(operation === 'reserve' && result.state === 'cancelled'))) {
    throw Object.assign(new Error('Coordinator reservation outcome is unresolved'), { code: 'reservation_outcome_unresolved' });
  }
  return { state: result.state };
}

module.exports = { validCapability, supportsReservations, action };
