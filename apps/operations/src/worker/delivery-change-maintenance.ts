import { processAuthenticatedDeliveryChangeNotifications } from "./authenticated-delivery-change-notifications";
import { publishAuthenticatedDeliveryChangeBells } from "./authenticated-delivery-bell";
import { projectAuthenticatedDeliveryChanges } from "./delivery-change-projector";
import type { Env } from "./types";

/** Recover a bounded set of accepted targets before dispatching ready batches.
 * This stays inside the existing notification cron's awaited maintenance work.
 * Recovery is default-off; with its gate absent, the existing sender is unchanged.
 */
export async function maintainAuthenticatedDeliveryChanges(env: Env): Promise<number> {
  try {
    const result = await projectAuthenticatedDeliveryChanges(env);
    if (result.claimed || result.failed) {
      console.log(JSON.stringify({ event: "delivery_change.recovery.tick", ...result }));
    }
  } catch {
    // D1/recipient errors can contain private keys and identity coordinates.
    // Keep the outer scheduler's error log safe as well as this local log.
    console.error(JSON.stringify({ event: "delivery_change.recovery.error" }));
    throw new Error("Delivery change recovery failed");
  }
  // Bell publication is intentionally before mail dispatch: SMTP readiness or
  // provider failure must not decide whether the exact recipient sees history.
  try {
    await publishAuthenticatedDeliveryChangeBells(env);
  } catch {
    console.error(JSON.stringify({ event: "delivery_change.bell.error" }));
    throw new Error("Delivery change bell publication failed");
  }
  return processAuthenticatedDeliveryChangeNotifications(env);
}
