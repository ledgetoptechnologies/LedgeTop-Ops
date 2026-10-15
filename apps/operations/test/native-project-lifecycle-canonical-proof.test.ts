import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { nativeProjectLifecycleCanonicalProof } from "../src/worker/native-project-lifecycle-canonical-proof";

let runtime: Miniflare, db: D1Database;
beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["OPS_DB"],
  });
  db = (await runtime.getD1Database("OPS_DB")) as unknown as D1Database;
  await db
    .prepare(
      "CREATE TABLE operations_shared_project_revisions(external_project_id TEXT,version INTEGER)",
    )
    .run();
});
afterAll(async () => runtime.dispose());
it("keeps the legacy query when lifecycle evidence is entirely absent; partial schema denies", async () => {
  expect(await nativeProjectLifecycleCanonicalProof(db, "project")).toBe("0");
  await db
    .prepare("CREATE TABLE native_project_lifecycle_commands(command_id TEXT)")
    .run();
  expect(await nativeProjectLifecycleCanonicalProof(db, "project")).toBeNull();
  await db
    .prepare(
      "ALTER TABLE operations_shared_project_revisions ADD COLUMN lifecycle_settlement_id TEXT",
    )
    .run();
  for (const name of [
    "receipts",
    "refreshes",
    "refresh_receipts",
    "settlements",
    "activations",
  ])
    await db
      .prepare(`CREATE TABLE native_project_lifecycle_${name}(command_id TEXT)`)
      .run();
  // Directly-read tables alone do not establish a complete reviewed schema.
  expect(await nativeProjectLifecycleCanonicalProof(db, "project")).toBeNull();
});
