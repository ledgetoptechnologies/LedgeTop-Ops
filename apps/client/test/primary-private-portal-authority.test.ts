import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { readPortalProjectionSourceProof, reservePrimaryPortalPrivateIngress,
  reservePrimaryPortalSigningKeys, portalProjectionSourceFence } from "../src/worker/project-alpha-portal-authority";

const primary="project-alpha:primary", secret="legacy-primary-secret-at-least-thirty-two-bytes";
const applicationKeys=["A","Upper.Case:Key-1","a".repeat(128)];
describe("private primary portal authority",()=>{
  let runtime:Miniflare,db:D1Database;
  beforeAll(async()=>{
    runtime=new Miniflare({compatibilityDate:"2026-08-06",modules:true,
      script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:"private-authority",MISSING:"missing-schema",
        ...Object.fromEntries(applicationKeys.map((_,index)=>[`APP_${index}`,`app-${index}`]))}});
    db=await runtime.getD1Database("DELIVERY_DB") as D1Database;
    for(const name of ["0162_portal_source_authorities.sql","0231_portal_primary_private_ingress_authority.sql"])
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),"utf8")).map(sql=>db.prepare(sql)));
    await db.prepare("CREATE TABLE sentinel(id TEXT PRIMARY KEY)").run();
  });
  afterAll(async()=>runtime.dispose());
  const env=()=>({DELIVERY_DB:db,PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:"false",PROJECT_ALPHA_PORTAL_APPLICATION_KEY:"ltds_ops"});
  it("retains the existing application-key contract including uppercase, punctuation and boundary lengths",async()=>{
    for(const [index,applicationKey] of applicationKeys.entries()){
      const target=await runtime.getD1Database(`APP_${index}`) as D1Database;
      await target.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0231_portal_primary_private_ingress_authority.sql",import.meta.url),"utf8")).map(sql=>target.prepare(sql)));
      const configured={...env(),DELIVERY_DB:target,PROJECT_ALPHA_PORTAL_APPLICATION_KEY:applicationKey};
      expect(await reservePrimaryPortalPrivateIngress(configured)).toMatchObject({applicationKey,version:1});
      expect(await readPortalProjectionSourceProof(configured,target,primary)).toMatchObject({applicationKey});
    }
  });
  it("read paths cannot enroll; private registration needs no copied secret and pins its application",async()=>{
    expect(await readPortalProjectionSourceProof(env(),db,primary)).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_primary_private_authority").first("n")).toBe(0);
    const proof=await reservePrimaryPortalPrivateIngress(env());
    expect(proof).toEqual({kind:"primary-private-ingress",sourceId:primary,applicationKey:"ltds_ops",version:1});
    expect(await reservePrimaryPortalPrivateIngress(env())).toEqual(proof);
    expect(await readPortalProjectionSourceProof(env(),db,primary)).toEqual(proof);
    expect(await readPortalProjectionSourceProof({...env(),PROJECT_ALPHA_PORTAL_APPLICATION_KEY:"another_app"},db,primary)).toBeNull();
    await expect(reservePrimaryPortalPrivateIngress({...env(),PROJECT_ALPHA_PORTAL_APPLICATION_KEY:"another_app"})).rejects.toThrow("unavailable");
  });
  it("suspension rejects stale fenced writes atomically and cannot fall back to reserved legacy keys",async()=>{
    const proof=await reservePrimaryPortalPrivateIngress(env());
    const legacy={...env(),PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:"true",PROJECT_ALPHA_PORTAL_HMAC_SECRET:secret};
    await reservePrimaryPortalSigningKeys(legacy);
    expect(await readPortalProjectionSourceProof(legacy,db,primary)).not.toBeNull();
    await db.prepare("UPDATE pa_portal_primary_private_authority SET state='suspended',version=version+1").run();
    expect(await readPortalProjectionSourceProof({...env(),PROJECT_ALPHA_PORTAL_HMAC_SECRET:secret},db,primary)).toBeNull();
    await expect(reservePrimaryPortalPrivateIngress(env())).rejects.toThrow("unavailable");
    await expect(db.batch([portalProjectionSourceFence(db,proof),db.prepare("INSERT INTO sentinel VALUES('must-not-commit')")])).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM sentinel").first("n")).toBe(0);
    await expect(db.prepare("UPDATE pa_portal_primary_private_authority SET application_key='changed',version=version+1").run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM pa_portal_primary_private_authority").run()).rejects.toThrow();
    await expect(db.prepare("INSERT OR REPLACE INTO pa_portal_primary_private_authority(source_id,application_key,state,version) VALUES('project-alpha:primary','ltds_ops','active',1)").run()).rejects.toThrow();
    await db.prepare("UPDATE pa_portal_primary_private_authority SET state='active',version=version+1").run();
    const resumed=await reservePrimaryPortalPrivateIngress(env());
    expect(resumed.version).toBe(3);
    await expect(db.batch([portalProjectionSourceFence(db,proof),db.prepare("INSERT INTO sentinel VALUES('stale-after-resume')")])).rejects.toThrow();
    await db.batch([portalProjectionSourceFence(db,resumed),db.prepare("INSERT INTO sentinel VALUES('resumed')")]);
    await db.prepare("UPDATE pa_portal_primary_private_authority SET state='retired',version=version+1").run();
    await expect(reservePrimaryPortalPrivateIngress(env())).rejects.toThrow("unavailable");
    await expect(db.prepare("UPDATE pa_portal_primary_private_authority SET state='active',version=version+1").run()).rejects.toThrow();
  });
  it("missing additive schema fails closed for registration and read",async()=>{
    const missing=await runtime.getD1Database("MISSING") as D1Database;
    expect(await readPortalProjectionSourceProof({...env(),DELIVERY_DB:missing},missing,primary)).toBeNull();
    await expect(reservePrimaryPortalPrivateIngress({...env(),DELIVERY_DB:missing})).rejects.toThrow("unavailable");
  });
});
