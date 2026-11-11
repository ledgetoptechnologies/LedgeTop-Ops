import { EPT_SLICE_CAPABILITY } from './ept-slice-capability.mjs';

// Isolated synchronous protocol: caller supplies the current iframe identity,
// verified build marker and adapter. No message is itself authorization.
export function createEptSliceHandshake({ enabled = false, onUnavailable = () => {} } = {}) {
  let active = null, closed = false, faulted = false;
  function clear() {
    const old = active; active = null;
    if (!old) return true;
    try { if (old.adapter.clear() !== true) { faulted = true; return false; } return true; }
    catch { faulted = true; return false; }
  }
  function connect({ frame, adapter } = {}) {
    if (!clear() || closed || faulted || enabled !== true || !frame
      || !adapter || adapter.capability !== EPT_SLICE_CAPABILITY
      || typeof adapter.set !== 'function' || typeof adapter.clear !== 'function') return false;
    try { if (frame.Potree?.ltdsSliceCapability !== EPT_SLICE_CAPABILITY || frame.__ltdsEptSliceAdapter !== adapter) return false; } catch { return false; }
    active = { frame, adapter }; return true;
  }
  function unavailable(reason) {
    if (!active) return false;
    const cleared = clear();
    try { onUnavailable({ reason, cleared }); } catch { /* Parent notification must not restore authority. */ }
    return false;
  }
  function set(frame, settings) {
    if (!active) return false;
    if (frame !== active.frame || closed || faulted) return unavailable('frame-unavailable');
    try { if (frame.Potree?.ltdsSliceCapability !== EPT_SLICE_CAPABILITY || frame.__ltdsEptSliceAdapter !== active.adapter || active.adapter.capability !== EPT_SLICE_CAPABILITY) return unavailable('frame-unavailable'); }
    catch { return unavailable('frame-unavailable'); }
    try { if (active.adapter.set(settings) !== true) return unavailable('clip-update-failed'); return true; }
    catch { return unavailable('clip-update-failed'); }
  }
  function interrupt(frame) {
    if (!active || frame !== active.frame || closed) return false;
    unavailable('clip-ownership-lost');
    return true;
  }
  return { connect, set, clear, interrupt, dispose() { const result = clear(); closed = true; return result; },
    get connected() { return Boolean(active) && !closed; } };
}
