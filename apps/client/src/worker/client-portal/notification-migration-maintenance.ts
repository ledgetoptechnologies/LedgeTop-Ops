/**
 * Explicit, deploy-managed release barrier for the preserving 0201
 * notification-table rebuild. Missing or malformed configuration remains open
 * so normal deployments are unaffected; only the exact string "true" pauses.
 */
export interface NotificationMigrationMaintenanceEnv {
  CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE?: string;
}

export function notificationMigrationMaintenanceActive(env: NotificationMigrationMaintenanceEnv): boolean {
  return env.CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE === "true";
}

export function notificationMigrationMaintenanceResponse(): Response {
  return Response.json({
    error: "Client request notifications are temporarily unavailable for scheduled maintenance.",
    code: "notification_migration_maintenance",
  }, {
    status: 503,
    headers: { "Retry-After": "900", "Cache-Control": "no-store" },
  });
}
