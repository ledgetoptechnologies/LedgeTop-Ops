import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import type { ProjectAlphaConnectorProof } from "./project-alpha-connectors";

type DeliveryDatabase = Pick<D1Database,"prepare"|"batch">;
type PrimaryDeliveryAuthorityState = "active"|"suspended";

export type PrimaryDeliveryAuthorityProof = Readonly<{
  kind:"primary_connector";
  sourceId:typeof PRIMARY_ALPHA_SOURCE_ID;
  mode:"legacy_primary"|"registry";
  connectorRevision:number;
  connectorVersion:number;
}>;

export class PrimaryDeliveryAuthorityError extends Error {
  constructor(readonly code:"changed"|"unavailable") {
    super(code === "changed" ? "Primary delivery authority changed" : "Primary delivery authority is unavailable");
  }
}

function valid(proof:PrimaryDeliveryAuthorityProof):void {
  const legacy=proof.mode==="legacy_primary";
  if(proof.kind!=="primary_connector"||proof.sourceId!==PRIMARY_ALPHA_SOURCE_ID||
    !Number.isSafeInteger(proof.connectorRevision)||!Number.isSafeInteger(proof.connectorVersion)||
    (legacy?(proof.connectorRevision!==0||proof.connectorVersion!==0):(proof.connectorRevision<1||proof.connectorVersion<1)))
    throw new PrimaryDeliveryAuthorityError("changed");
}

export function primaryDeliveryAuthorityProof(connector:ProjectAlphaConnectorProof):PrimaryDeliveryAuthorityProof {
  if(connector.sourceId!==PRIMARY_ALPHA_SOURCE_ID||connector.profile!=="primary_legacy")
    throw new PrimaryDeliveryAuthorityError("changed");
  const proof:PrimaryDeliveryAuthorityProof=Object.freeze({kind:"primary_connector",sourceId:PRIMARY_ALPHA_SOURCE_ID,
    mode:connector.mode,connectorRevision:connector.revision,connectorVersion:connector.version});
  valid(proof);
  return proof;
}

function stateFence(database:DeliveryDatabase,proof:PrimaryDeliveryAuthorityProof,state:PrimaryDeliveryAuthorityState):D1PreparedStatement {
  valid(proof);
  return database.prepare(`INSERT INTO pa_primary_delivery_authority_write_fences(source_id,write_guard)
    VALUES('project-alpha:primary',CASE WHEN EXISTS(SELECT 1 FROM pa_primary_delivery_authority
      WHERE source_id='project-alpha:primary' AND mode=? AND connector_revision=? AND connector_version=? AND state=?) THEN 1 ELSE 0 END)
    ON CONFLICT(source_id) DO UPDATE SET write_guard=excluded.write_guard`)
    .bind(proof.mode,proof.connectorRevision,proof.connectorVersion,state);
}

export function primaryDeliveryAuthorityFence(database:DeliveryDatabase,proof:PrimaryDeliveryAuthorityProof):D1PreparedStatement {
  return stateFence(database,proof,"active");
}

function mapWriteError(error:unknown):never {
  const message=error instanceof Error?error.message:String(error);
  if(/pa_primary_delivery_authority_write_guard|primary-delivery-authority-changed/i.test(message))
    throw new PrimaryDeliveryAuthorityError("changed");
  throw new PrimaryDeliveryAuthorityError("unavailable");
}

/**
 * Advance the Delivery-side mirror only after the same connector proof was
 * verified in OPS_DB. A concurrently staged newer proof can never be replaced
 * by this older request; the following fence then fails closed.
 */
export async function synchronizePrimaryDeliveryAuthority(database:DeliveryDatabase,
  proof:PrimaryDeliveryAuthorityProof):Promise<void> {
  valid(proof);
  try{
    await database.batch([
      database.prepare(`UPDATE pa_primary_delivery_authority SET mode=?,connector_revision=?,connector_version=?,state='active',
        authority_version=authority_version+1,updated_at=datetime('now')
        WHERE source_id='project-alpha:primary' AND connector_version<?`)
        .bind(proof.mode,proof.connectorRevision,proof.connectorVersion,proof.connectorVersion),
      primaryDeliveryAuthorityFence(database,proof),
    ]);
  }catch(error){mapWriteError(error);}
}

/** Delivery-first half of a coordinated connector transition. */
export async function stagePrimaryDeliveryAuthority(database:DeliveryDatabase,proof:PrimaryDeliveryAuthorityProof,
  state:PrimaryDeliveryAuthorityState):Promise<void> {
  valid(proof);
  try{
    await database.batch([
      database.prepare(`UPDATE pa_primary_delivery_authority SET mode=?,connector_revision=?,connector_version=?,state=?,
        authority_version=authority_version+1,updated_at=datetime('now') WHERE source_id='project-alpha:primary'`)
        .bind(proof.mode,proof.connectorRevision,proof.connectorVersion,state),
      stateFence(database,proof,state),
    ]);
  }catch(error){mapWriteError(error);}
}

/** Trusted recovery projects the authoritative current OPS connector state. */
export async function reconcilePrimaryDeliveryAuthority(database:DeliveryDatabase,proof:PrimaryDeliveryAuthorityProof,
  state:PrimaryDeliveryAuthorityState):Promise<void> {
  return stagePrimaryDeliveryAuthority(database,proof,state);
}

export async function primaryDeliveryAuthorityReady(database:D1Database):Promise<boolean> {
  try{
    return await database.prepare(`SELECT count(*) count FROM sqlite_master WHERE type='table'
      AND name IN ('pa_primary_delivery_authority','pa_primary_delivery_authority_write_fences')`).first<number>("count")===2;
  }catch{return false;}
}
