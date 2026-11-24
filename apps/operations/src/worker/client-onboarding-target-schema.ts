import { canonicalSqliteSchemaInventory } from "./sqlite-schema-canonical";

/** SHA-256 of the canonical token inventory (sqlite-schema-tokens-v1) after
 * Operations migrations through 0248. Stored comments and formatting do not
 * change these; any other difference does. The earlier stored-text digests and
 * every tuple's old and new digest are recorded, and proven equivalent, by
 * test/client-onboarding-schema-canonical.test.ts and its fixture. The mail
 * inventory is layered on the target inventory; a digest is not evidence of an
 * installed schema. */
export const CLIENT_ONBOARDING_SCHEMA_PINS = Object.freeze({
  target: "767a41b0f73ab6afd5828e78384eb0a0db6bd0ea1e151ed93d75cd268292b8e8",
  destination: "5946bd6e92dad21883e56b8cc854bb6072e271490c26be64aa99f883f8d5f36e",
  mail: "5d5e0cb9b3a25e28bc19a333578be235f169969b8c83664b6a01a7c9ab74a102",
});
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

/** Pin the installed protocol by its canonical tokens, then compare the same
 * exact stored inventory inside the write batch. An invalid JSON argument
 * deliberately aborts a changed batch. */
async function issuanceSchemaFence(db: Pick<D1Database, "prepare">, query: string,
  expectedSha256: string): Promise<D1PreparedStatement> {
  const inventory = await db.prepare(query).first<string>("inventory");
  if (typeof inventory !== "string" || inventory.length > 65_536) throw Error("client_onboarding_target_schema_unavailable");
  let canonical: string;
  try { canonical = canonicalSqliteSchemaInventory(JSON.parse(inventory)); }
  catch { throw Error("client_onboarding_target_schema_unavailable"); }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  if (Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") !== expectedSha256)
    throw Error("client_onboarding_target_schema_unavailable");
  return db.prepare(`SELECT json(CASE WHEN (${query})=? THEN 'true' ELSE '' END) schema_fence`).bind(inventory);
}

export function targetIssuanceSchemaFence(db: Pick<D1Database, "prepare">): Promise<D1PreparedStatement> {
  return issuanceSchemaFence(db, schemaInventory, CLIENT_ONBOARDING_SCHEMA_PINS.target);
}

/** Ordinary destination invitations depend on their own columns and guards. */
export function destinationIssuanceSchemaFence(db: Pick<D1Database, "prepare">): Promise<D1PreparedStatement> {
  return issuanceSchemaFence(db, destinationSchemaInventory, CLIENT_ONBOARDING_SCHEMA_PINS.destination);
}

/** Email path only: guard both reveal tables and every outbox object as well. */
export function mailIssuanceSchemaFence(db: Pick<D1Database, "prepare">): Promise<D1PreparedStatement> {
  return issuanceSchemaFence(db, mailSchemaInventory, CLIENT_ONBOARDING_SCHEMA_PINS.mail);
}
