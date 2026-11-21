// SHA-256 of the ordered D1 schema inventory after the reviewed migrations
// through 0243 and the two provisional destination/target fixtures. The
// affected schema is identical at 0218, the local migrated-D1 test baseline.
const REVIEWED_SCHEMA_SHA256 = "b6be16ff958e4a23048f107b4aa5a4c7d41b25d7c296d463bf381b565b525873";
// Provisional mail fixture layered after the destination/target fixtures. This
// is not an allocated migration or evidence of an installed staging schema.
const REVIEWED_MAIL_SCHEMA_SHA256 = "4579b255a43bb5ddfa6e4fa49212b1cdb003c72541b15a90da1acb925eebd746";
const schemaInventory = `SELECT json_group_array(json_array(type,name,tbl_name,sql)) inventory FROM (
  SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE (type IN ('table','index','trigger') AND tbl_name IN (
    'client_onboarding_invitations','client_onboarding_issuance_commands','client_onboarding_handoffs',
    'client_onboarding_decisions','client_onboarding_target_proofs'))
  OR (type='view' AND name='client_onboarding_live_issuances')
  ORDER BY type COLLATE BINARY,name COLLATE BINARY
)`;
const destinationSchemaInventory = `SELECT json_group_array(json_array(type,name,tbl_name,sql)) inventory FROM (
  SELECT 'column' type,name,'client_onboarding_issuance_commands' tbl_name,
    json_array(upper(type),"notnull",dflt_value,pk) sql
  FROM pragma_table_info('client_onboarding_issuance_commands') WHERE name='destination_intent_json'
  UNION ALL
  SELECT 'column',name,'client_onboarding_decisions',json_array(upper(type),"notnull",dflt_value,pk)
  FROM pragma_table_info('client_onboarding_decisions') WHERE name='destination_issuance_sha256'
  UNION ALL
  SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE type='trigger' AND (
    (tbl_name='client_onboarding_issuance_commands' AND name='client_onboarding_destination_intent_exact')
    OR (tbl_name='client_onboarding_decisions' AND name='client_onboarding_destination_approval_exact'))
  ORDER BY type COLLATE BINARY,name COLLATE BINARY
)`;
const mailSchemaInventory = `SELECT json_group_array(json_array(type,name,tbl_name,sql)) inventory FROM (
  SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE (type IN ('table','index','trigger') AND tbl_name IN (
    'client_onboarding_invitations','client_onboarding_issuance_commands','client_onboarding_handoffs',
    'client_onboarding_decisions','client_onboarding_target_proofs','client_onboarding_reveal_consumptions',
    'client_onboarding_reveal_audit','client_onboarding_invite_mail_outbox'))
  OR (type='view' AND name='client_onboarding_live_issuances')
  ORDER BY type COLLATE BINARY,name COLLATE BINARY
)`;

/** Pin the installed protocol, then compare the same inventory inside the
 * write batch. An invalid JSON argument deliberately aborts a changed batch. */
async function issuanceSchemaFence(db: Pick<D1Database, "prepare">, query: string,
  expectedSha256: string): Promise<D1PreparedStatement> {
  const inventory = await db.prepare(query).first<string>("inventory");
  if (typeof inventory !== "string" || inventory.length > 65_536) throw Error("client_onboarding_target_schema_unavailable");
  const canonical = JSON.stringify((JSON.parse(inventory) as [string, string, string, string | null][])
    .map(([type, name, table, sql]) => [type, name, table, sql?.replaceAll("\r\n", "\n") ?? null]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  if (Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") !== expectedSha256)
    throw Error("client_onboarding_target_schema_unavailable");
  return db.prepare(`SELECT json(CASE WHEN (${query})=? THEN 'true' ELSE '' END) schema_fence`).bind(inventory);
}

export function targetIssuanceSchemaFence(db: Pick<D1Database, "prepare">): Promise<D1PreparedStatement> {
  return issuanceSchemaFence(db, schemaInventory, REVIEWED_SCHEMA_SHA256);
}

/** Ordinary destination invitations depend on their own columns and guards. */
export function destinationIssuanceSchemaFence(db: Pick<D1Database, "prepare">): Promise<D1PreparedStatement> {
  return issuanceSchemaFence(db, destinationSchemaInventory,
    "9ac1831914cc6857ddd41df7fff9cd2de4d8a52f0ddd69fb23fab9d18af7f77d");
}

/** Email path only: guard both reveal tables and every outbox object as well. */
export function mailIssuanceSchemaFence(db: Pick<D1Database, "prepare">): Promise<D1PreparedStatement> {
  return issuanceSchemaFence(db, mailSchemaInventory, REVIEWED_MAIL_SCHEMA_SHA256);
}
