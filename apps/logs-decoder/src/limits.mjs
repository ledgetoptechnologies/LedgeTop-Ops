// One place for the runner's resource limits. They match Logs' server-side checks (apps/logs/src/worker/decoder-service.mjs)
// and the RAM-only container profile (compose.yaml): all scratch is tmpfs, counted in the container's 1 GiB with Node
// and the parser. These are the PROPOSED budget; the real peak must be measured on the admitted host with real logs.
export const LIMITS = Object.freeze({
  rawBytes: 64 * 1024 * 1024,           // raw log streamed to tmpfs (never held whole in Node)
  parserOutputBytes: 96 * 1024 * 1024,  // parser JSON written to tmpfs, then read once
  trackRows: 100_000,                   // = Logs trackRows
  trackJsonBytes: 32 * 1024 * 1024,     // = Logs trackJsonBytes (expanded)
  trackGzipBytes: 8 * 1024 * 1024,      // = Logs trackGzipBytes
  tmpfsBytes: 192 * 1024 * 1024,        // compose tmpfs size for /work
  leaseSeconds: 300,                    // = Logs LEASE_SECONDS
});
