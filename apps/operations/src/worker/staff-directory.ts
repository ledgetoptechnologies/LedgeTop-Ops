// StaffDirectory: a deliberately tiny entrypoint that Ledge Top Logs reaches through its OPS_DIRECTORY
// service binding. It answers two questions and nothing else: which active staff member owns this exact
// username, and is this staff id still active. It returns ids only (no names, emails or permissions) and
// never derives a username from an email address.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";
import { isActiveStaff, resolvePilotUsername } from "./staff-directory-lookup";

export { isActiveStaff, resolvePilotUsername };

function flightLogsEnabled(env: Env): boolean {
  return env.ENVIRONMENT !== "staging"
    || (env as Env & { FLIGHT_LOGS_ENABLED?: string }).FLIGHT_LOGS_ENABLED === "true";
}

export class StaffDirectory extends WorkerEntrypoint<Env> {
  resolvePilotUsername(username: unknown) {
    return flightLogsEnabled(this.env) ? resolvePilotUsername(this.env.OPS_DB, username) : Promise.resolve(null);
  }
  isActiveStaff(staffId: unknown) {
    return flightLogsEnabled(this.env) ? isActiveStaff(this.env.OPS_DB, staffId) : Promise.resolve(false);
  }
}
