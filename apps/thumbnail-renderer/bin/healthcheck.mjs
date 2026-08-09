import { checkHealth } from "../src/state.mjs";

const stateDir = process.env.LTDSTHUMB_STATE_DIR || "/state";
const staleMs = Number(process.env.LTDSTHUMB_HEALTH_STALE_MS || "300000");
try {
  if (!Number.isSafeInteger(staleMs) || staleMs < 60_000 || !(await checkHealth(stateDir, staleMs))) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
