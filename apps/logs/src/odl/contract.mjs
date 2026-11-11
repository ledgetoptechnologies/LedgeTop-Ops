// Shared by the importer (Node and browser) and the Worker; must stay dependency-free.
export const IMPORT_SCHEMA = 'ltds.logs.odl-import.v1';

// Two logs are the same flight if they have the same file fingerprint, or the same aircraft serial and
// start times within this window (for example a controller copy and a phone copy of one flight). One
// aircraft cannot start two real flights this close together, so later copies are rejected.
export const SAME_FLIGHT_START_WINDOW_SECONDS = 10;
export function sameFlightStart(a, b) {
  const first = Date.parse(a), second = Date.parse(b);
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) <= SAME_FLIGHT_START_WINDOW_SECONDS * 1000;
}
