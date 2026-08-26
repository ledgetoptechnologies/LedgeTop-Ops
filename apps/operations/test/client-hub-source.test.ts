import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isAlphaPublicId, readClientHubSourcePublicId, resolveClientHubSourceRoot, sourcePublicIdExpression } from "../src/worker/client-hub-source";

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

describe("explicit Alpha source public IDs", () => {
  const publicId = "00000000000000000000000000000042";
  it("preserves the native 32-hex representation and never guesses from internal IDs", () => {
    expect(isAlphaPublicId(publicId)).toBe(true);
    expect(readClientHubSourcePublicId(JSON.stringify({ id: 42, public_id: publicId })))
      .toEqual({ pa_public_id: publicId, mapping_status: "mapped" });
    for (const value of [42, "42", "A".repeat(32), ` ${publicId}`, "00000000-0000-0000-0000-000000000042", {}, []]) {
      expect(readClientHubSourcePublicId(JSON.stringify({ public_id: value })))
        .toEqual({ pa_public_id: null, mapping_status: "invalid" });
    }
    for (const payload of ["{}", '{"public_id":null}', '{"id":"42"}'])
      expect(readClientHubSourcePublicId(payload)).toEqual({ pa_public_id: null, mapping_status: "missing" });
    for (const payload of ["{bad", "null", "[]", '"text"'])
      expect(readClientHubSourcePublicId(payload)).toEqual({ pa_public_id: null, mapping_status: "invalid" });
  });

  it("resolves only unique source mappings, including inactive collisions, without changing source records", async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default { fetch(){return new Response('ok')} }", d1Databases: { OPS_DB: "source-contract" } });
    const db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await db.exec("CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT,active INTEGER,payload_json TEXT); CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT,active INTEGER,payload_json TEXT);");
    await db.exec(readFileSync(new URL("../migrations/0032_client_hub_directory.sql", import.meta.url), "utf8")
      .replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " "));
    const plan = await db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM pa_organizations source
      WHERE ${sourcePublicIdExpression("source") }=?`).bind(publicId).all<{ detail: string }>();
    expect(plan.results.some(row => row.detail.includes("idx_pa_organizations_client_hub_public_id"))).toBe(true);
    await db.prepare("INSERT INTO pa_organizations VALUES('42','Business',1,?)").bind(JSON.stringify({ id: 42, public_id: publicId })).run();
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "42"))
      .toEqual({ id: "42", display_name: "Business", organization_id: null, active: 1, pa_public_id: publicId, mapping_status: "mapped" });
    await db.prepare("INSERT INTO pa_organizations VALUES('99','Inactive collision',0,?)").bind(JSON.stringify({ id: 99, public_id: publicId })).run();
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "42"))
      .toMatchObject({ pa_public_id: null, mapping_status: "ambiguous" });
    await db.prepare("INSERT INTO pa_clients VALUES('42','Contact','99',1,'{}'),('missing','Missing',NULL,0,'{}'),('invalid','Invalid',NULL,1,'broken-json')").run();
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "standalone_client", "42"))
      .toMatchObject({ organization_id: "99", pa_public_id: null, mapping_status: "missing" });
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "standalone_client", "missing"))
      .toMatchObject({ active: 0, pa_public_id: null, mapping_status: "missing" });
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "standalone_client", "invalid"))
      .toMatchObject({ pa_public_id: null, mapping_status: "invalid" });
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "unknown")).toBeNull();
    expect(await db.prepare("SELECT payload_json FROM pa_clients WHERE id='invalid'").first("payload_json")).toBe("broken-json");
  }, 30_000);
});
