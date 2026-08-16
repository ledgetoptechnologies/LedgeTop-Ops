import type { ViewerDisplayUnits } from "@ltds/shared";
import type { Env } from "./types";

export function defaultViewerUnits(_env: Pick<Env, "DEFAULT_UNITS">): "imperial" {
  return "imperial";
}

export async function resolveViewerUnits(
  env: Pick<Env, "OPS_DB" | "DEFAULT_UNITS">,
  staffId: string,
): Promise<ViewerDisplayUnits> {
  try {
    const value = await env.OPS_DB.prepare(
      "SELECT display_units FROM viewer_staff_preferences WHERE staff_id=?",
    ).bind(staffId).first<string>("display_units");
    return value === "metric" ? "metric" : defaultViewerUnits(env);
  } catch (error) {
    if (/no such table: viewer_staff_preferences/i.test(error instanceof Error ? error.message : String(error)))
      return defaultViewerUnits(env);
    throw error;
  }
}
