import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import migration from "../migrations/0238_viewer_direct_session_intents.sql?raw";

it("preserves one immutable session deadline per identity and retry key",()=>{
 const db=new DatabaseSync(":memory:");
 try{db.exec("PRAGMA foreign_keys=ON;CREATE TABLE viewer_direct_client_grants(id TEXT PRIMARY KEY);INSERT INTO viewer_direct_client_grants VALUES('grant-one')");
  db.exec(migration);const insert=db.prepare(`INSERT INTO viewer_direct_client_session_intents
   (actor_identity_id,idempotency_key,grant_id,grant_version,request_fingerprint,authorization_expires_at) VALUES(?,?,?,1,?,?)`);
  insert.run("person-one","retry-one","grant-one","fingerprint","2026-10-24T04:00:00Z");
  expect(()=>insert.run("person-one","retry-one","grant-one","different","2026-10-24T05:00:00Z")).toThrow(/UNIQUE/);
  expect(()=>db.prepare("UPDATE viewer_direct_client_session_intents SET authorization_expires_at='2099-01-01'").run()).toThrow(/immutable/);
  expect(()=>insert.run("person-one","retry-two","missing-grant","fingerprint","2026-10-24T04:00:00Z")).toThrow(/FOREIGN KEY/);
  insert.run("person-two","retry-one","grant-one","fingerprint","2026-10-24T04:00:00Z");
  expect(db.prepare("SELECT count(*) count FROM viewer_direct_client_session_intents").get()).toEqual({count:2});
 }finally{db.close();}
});
