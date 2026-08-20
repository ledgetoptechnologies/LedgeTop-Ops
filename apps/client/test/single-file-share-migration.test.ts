import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import migration from "../migrations/0148_single_file_delivery_shares.sql?raw";

describe("single-file delivery-share migration",()=>{
  it("applies after the existing prefix index and enforces independent active folder and exact-object uniqueness",()=>{
    const db=new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE shares(
      id TEXT PRIMARY KEY,
      r2_prefix TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_shares_one_active_prefix ON shares(r2_prefix)
      WHERE revoked_at IS NULL AND r2_prefix IS NOT NULL;`);
    db.exec(migration);
    const columns=db.prepare("PRAGMA table_info(shares)").all() as Array<{name:string}>;
    expect(columns.map(column=>column.name)).toContain("r2_object_key");
    const indexes=db.prepare("PRAGMA index_list(shares)").all() as Array<{name:string}>;
    expect(indexes.map(index=>index.name)).toEqual(expect.arrayContaining(["idx_shares_one_active_prefix","idx_shares_one_active_object","idx_shares_object_history"]));

    const insert=db.prepare("INSERT INTO shares(id,r2_prefix,r2_object_key,revoked_at) VALUES(?,?,?,?)");
    insert.run("folder-one","Jobs/Clients/Acme/",null,null);
    expect(()=>insert.run("folder-two","Jobs/Clients/Acme/",null,null)).toThrow();
    insert.run("file-one","Jobs/Clients/Acme/","Jobs/Clients/Acme/Video 1.mov",null);
    insert.run("file-two","Jobs/Clients/Acme/","Jobs/Clients/Acme/Video 2.mov",null);
    expect(()=>insert.run("file-duplicate","Jobs/Clients/Other/","Jobs/Clients/Acme/Video 2.mov",null)).toThrow();
    insert.run("file-revoked","Jobs/Clients/Other/","Jobs/Clients/Acme/Video 2.mov","2026-08-19T00:00:00Z");
    db.close();
  });
});
