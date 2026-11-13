'use strict';

// A failed lane must stop new admissions immediately, but it cannot close the
// shared database while other lanes are still finishing their owned work.
async function drainWorkerLanes({ lanes, stop, maintenance, close }) {
  let failure = null;
  let failed = false;
  const pending = lanes.map(run => Promise.resolve().then(run).catch(error => {
    if (!failed) { failed = true; failure = error; stop(error); }
    throw error;
  }));
  await Promise.allSettled(pending);
  if (!failed) stop(null);
  // A rejected maintenance promise is not proof that its writers are safe to
  // close underneath. Leave the database open and surface the failure.
  await maintenance();
  close();
  if (failed) throw failure;
}
module.exports = { drainWorkerLanes };
