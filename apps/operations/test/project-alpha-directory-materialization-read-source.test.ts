import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { directoryMaterializationReadSource, projectAlphaDirectoryUnsettledReadSource }
  from "../src/worker/project-alpha-directory-materialization-read-source";

let runtime: Miniflare;
let db: D1Database;
beforeAll(async () => {
  runtime = new Miniflare({ modules: true,
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["DB"] });
  db = await runtime.getD1Database("DB");
});
afterAll(async () => runtime.dispose());

describe("Directory immutable materialization read source", () => {
  it("retains the historical source when the recovery view is absent", async () => {
    expect(await directoryMaterializationReadSource(db)).toBe("operations_directory_materializations");
  });
  it("does not mistake a same-named table for the reviewed view", async () => {
    await db.prepare("CREATE TABLE operations_directory_effective_materializations(id TEXT)").run();
    expect(await directoryMaterializationReadSource(db)).toBe("operations_directory_materializations");
    await db.prepare("DROP TABLE operations_directory_effective_materializations").run();
  });
  it("selects the schema-owned recovery view without changing either source", async () => {
    await db.prepare("CREATE VIEW operations_directory_effective_materializations AS SELECT 'sentinel' AS id").run();
    expect(await directoryMaterializationReadSource(db)).toBe("operations_directory_effective_materializations");
    expect(await db.prepare("SELECT id FROM operations_directory_effective_materializations").first("id"))
      .toBe("sentinel");
  });
  it("uses only the fixed schema-owned unsettled view when present", async () => {
    expect(await projectAlphaDirectoryUnsettledReadSource(db)).toBe("project_alpha_directory_outbox");
    await db.prepare("CREATE VIEW project_alpha_directory_unsettled_commands AS SELECT 'sentinel' AS command_id").run();
    expect(await projectAlphaDirectoryUnsettledReadSource(db)).toBe("project_alpha_directory_unsettled_commands");
  });
});
