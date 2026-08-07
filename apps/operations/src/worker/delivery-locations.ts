import { aggregateDeliveryLocations, type DeliveryLocationCollection } from "@ltds/shared";
import { authorizeDeliveryFolderPrefix } from "./delivery";
import type { Env, StaffPrincipal } from "./types";

export const IMAGE_LOCATION_MAP_LIMIT = 500;

export async function listDeliveryFolderLocations(
  env: Env,
  principal: StaffPrincipal,
  prefixValue: string,
): Promise<DeliveryLocationCollection> {
  const prefix = await authorizeDeliveryFolderPrefix(env, principal, prefixValue);
  const rows = await env.DELIVERY_DB.prepare(`/* image-location.operations-list */
    SELECT location.latitude,location.longitude
    FROM image_asset_locations location
    JOIN file_index file ON file.r2_key=location.source_key
      AND trim(file.etag,'"')=location.source_etag AND file.media_kind='image'
    WHERE location.status='ready' AND location.folder_prefix=?
      AND NOT EXISTS (
        SELECT 1 FROM delivery_tombstones tombstone
        WHERE tombstone.restored_at IS NULL AND (
          tombstone.physical_key=location.source_key OR
          (tombstone.tombstone_kind='prefix' AND substr(location.source_key,1,length(tombstone.physical_key))=tombstone.physical_key)
        )
      )
    ORDER BY location.source_key LIMIT ?`)
    .bind(prefix, IMAGE_LOCATION_MAP_LIMIT + 1)
    .all<{ latitude: number; longitude: number }>();
  return aggregateDeliveryLocations(rows.results, IMAGE_LOCATION_MAP_LIMIT);
}
