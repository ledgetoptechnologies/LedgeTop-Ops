import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import migration from "../migrations/0150_delivery_share_history_index.sql?raw";

describe("delivery-share history migration",()=>{
  it("adds an idempotent newest-first keyset index",()=>{
    const db=new DatabaseSync(":memory:");
    db.exec("CREATE TABLE shares(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);");
    db.exec(migration);
    db.exec(migration);
    const columns=db.prepare("PRAGMA index_info(idx_shares_created_history)").all() as Array<{name:string;seqno:number}>;
    expect(columns.sort((left,right)=>left.seqno-right.seqno).map(column=>column.name)).toEqual(["created_at","id"]);
    db.close();
  });
});
