export function nativeExistingImportRecordId(sourceId: string, kind: "organization" | "client", classicId: string): string {
  if (!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId) || !["organization", "client"].includes(kind)
    || !classicId || /\p{C}/u.test(classicId)) throw new Error("invalid-existing-import-identity");
  const value = `pa-import:${sourceId}:${kind}:${classicId}`;
  if (value.length > 191 || new TextEncoder().encode(value).byteLength > 191) throw new Error("qualified-existing-import-identity-too-long");
  return value;
}

export async function nativeExistingImportTranslationsAvailable(database: Pick<D1Database, "prepare">): Promise<boolean> {
  return !!await database.prepare(`SELECT 1 found FROM sqlite_master
    WHERE name='native_directory_existing_import_identity_translations' AND type='table'`).first("found");
}

/** Projection identity only: this translation never supplies native authority.
 * Callers still prove the current active mapping/configuration/source tuple. */
export function nativeExistingImportClassicIdSql(alias: string, available: boolean, fallbackToExternal = true): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("invalid-existing-import-mapping-alias");
  if (!available) return fallbackToExternal ? `${alias}.external_id` : "NULL";
  const translated = `(SELECT translation.classic_record_id
    FROM native_directory_existing_import_identity_translations translation
    JOIN native_directory_existing_import_reviews import_review ON import_review.import_id=translation.import_id
    WHERE translation.native_record_id=${alias}.record_id AND translation.source_id=${alias}.source_id
      AND translation.record_kind=${alias}.resource_type AND translation.public_id=${alias}.project_alpha_public_id
      AND json_extract(import_review.review_json,'$.sourceInstanceId')=${alias}.source_instance_id
      AND json_extract(import_review.review_json,'$.applicationId')=${alias}.application_id
      AND json_extract(import_review.review_json,'$.historyEpoch')=${alias}.history_epoch_id)`;
  return fallbackToExternal ? `COALESCE(${translated},${alias}.external_id)` : translated;
}
