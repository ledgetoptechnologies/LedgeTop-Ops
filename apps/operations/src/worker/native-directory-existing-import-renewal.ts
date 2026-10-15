/** Only migration206's immutable, admitted renewals can extend an import's
 * original command review. Ordinary existing-binding reviews retain4h expiry. */
export async function nativeImportRenewalSql(db: D1Database, reviewAlias: string): Promise<string> {
    const available = await db.prepare("SELECT 1 ok FROM sqlite_master WHERE name='native_directory_existing_import_renewals'").first("ok");
    if (!available)
        return "0";
    return `EXISTS(SELECT 1 FROM native_directory_existing_import_renewals renewal
 JOIN native_directory_existing_import_reviews imported ON imported.import_id=renewal.import_id
 JOIN native_directory_existing_import_binding_intents intent ON intent.import_id=imported.import_id
 WHERE imported.import_id=${reviewAlias}.review_id AND intent.review_receipt_id=${reviewAlias}.receipt_id
 AND json_extract(imported.review_json,'$.nativeRecordId')=${reviewAlias}.record_id
 AND imported.source_id=${reviewAlias}.source_id AND imported.record_kind=${reviewAlias}.resource_type
 AND renewal.created_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND renewal.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}
export async function nativeImportCommandRenewed(db: D1Database, reviewId: string, commandId: string): Promise<boolean> {
    const available = await db.prepare("SELECT 1 ok FROM sqlite_master WHERE name='native_directory_existing_import_renewals'").first("ok");
    if (!available)
        return false;
    return !!await db.prepare(`SELECT 1 ok FROM native_directory_existing_import_renewals renewal
  JOIN native_directory_existing_import_binding_intents intent ON intent.import_id=renewal.import_id
  WHERE renewal.import_id=? AND intent.command_id=? AND renewal.created_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND renewal.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(reviewId, commandId).first("ok");
}
