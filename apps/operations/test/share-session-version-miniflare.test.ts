import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveShareUpdateSecurity } from "../src/worker/delivery";

describe("share credential versions in migrated D1 semantics",()=>{
  let miniflare:Miniflare,db:D1Database;
  beforeAll(async()=>{
    miniflare=new Miniflare({compatibilityDate:"2026-08-06",modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:"share-version-test"}});
    db=await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec("CREATE TABLE shares(id TEXT PRIMARY KEY,share_version INTEGER NOT NULL,expires_at TEXT,image_location_map_enabled INTEGER NOT NULL DEFAULT 0); INSERT INTO shares(id,share_version) VALUES ('share-a',3);");
  });
  afterAll(()=>miniflare.dispose());

  it("keeps live-policy metadata edits on the active browser credential generation",async()=>{
    const plan=resolveShareUpdateSecurity({accessCodeChanged:false,recipientChanged:false,hasRecoverableSecret:true,publicIdChanged:false});
    await db.prepare("UPDATE shares SET expires_at=?,image_location_map_enabled=?,share_version=share_version+? WHERE id=? AND share_version=?")
      .bind("2026-09-01T00:00:00.000Z",1,plan.versionIncrement,"share-a",3).run();
    await expect(db.prepare("SELECT share_version,expires_at,image_location_map_enabled FROM shares WHERE id='share-a'").first())
      .resolves.toEqual({share_version:3,expires_at:"2026-09-01T00:00:00.000Z",image_location_map_enabled:1});
  });

  it("increments the credential generation for an access-code change",async()=>{
    const plan=resolveShareUpdateSecurity({accessCodeChanged:true,recipientChanged:false,hasRecoverableSecret:true,publicIdChanged:false});
    await db.prepare("UPDATE shares SET share_version=share_version+? WHERE id=? AND share_version=?").bind(plan.versionIncrement,"share-a",3).run();
    await expect(db.prepare("SELECT share_version FROM shares WHERE id='share-a'").first()).resolves.toEqual({share_version:4});
  });
});
