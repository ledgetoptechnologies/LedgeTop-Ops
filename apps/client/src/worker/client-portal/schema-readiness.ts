import type { Env } from "../types";
import { d1TablesPresent } from "../schema-readiness";

/** The notification inbox is an additive capability introduced by 0115. */
export async function clientPortalNotificationsAvailable(env: Env): Promise<boolean> {
  return d1TablesPresent(env.DELIVERY_DB, ["client_portal_notifications"]);
}
