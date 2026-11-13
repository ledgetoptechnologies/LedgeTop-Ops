// StaffDirectory: a deliberately tiny entrypoint that Ledge Top Logs reaches through its OPS_DIRECTORY
// service binding. It resolves an explicitly eligible pilot username and checks
// current revision-bound device authority. It returns ids/revisions only (no names, emails or roles) and
// never derives a username from an email address.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";
import { getPilotDeviceAuthority, isActiveStaff, resolvePilotUsername } from "./staff-directory-lookup";

export { getPilotDeviceAuthority, isActiveStaff, resolvePilotUsername };

function flightLogsEnabled(env: Env): boolean {
  return env.ENVIRONMENT !== "staging"
    || (env as Env & { FLIGHT_LOGS_ENABLED?: string }).FLIGHT_LOGS_ENABLED === "true";
}

export class StaffDirectory extends WorkerEntrypoint<Env> {
  getPilotDeviceAuthority(staffId: unknown) {
    return flightLogsEnabled(this.env) ? getPilotDeviceAuthority(this.env.OPS_DB, staffId) : Promise.resolve({ eligible: false, revision: null });
  }
  resolvePilotUsername(username: unknown) {
    return flightLogsEnabled(this.env) ? resolvePilotUsername(this.env.OPS_DB, username) : Promise.resolve(null);
  }
  isActiveStaff(staffId: unknown) {
    return flightLogsEnabled(this.env) ? isActiveStaff(this.env.OPS_DB, staffId) : Promise.resolve(false);
  }
}
