// QA fixture for #698 (not for merge).
// Builds the two disposable, fully migrated D1 databases in memory and applies
// the seeds. As a CLI it validates the seed and the pinned digests:
//   node qa/sharing-698/fixture-db.mjs            validate (exit 1 on any failure)
//   node qa/sharing-698/fixture-db.mjs --digests  print the SHA-256 digests the README pins
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./d1-sqlite.mjs";

export const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(fixtureDir, "..", "..");
export const PINNED_FILES = ["README.md", "contract.json", "seed-delivery.sql", "seed-ops.sql", "d1-sqlite.mjs",
  "fixture-db.mjs", "fixture-db.d.mts", "ephemeral-access.mjs", "ephemeral-access.d.mts",
  "seed-viewer.sql", "viewer-manifest.json", "viewer-readback.mjs", "viewer-readback.d.mts", "../../apps/operations/test/qa-sharing-698-contract.test.ts"];

function migrations(directory) {
  const absolute = path.join(repoRoot, directory);
  return readdirSync(absolute).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()
    .map(name => ({ name, sql: readFileSync(path.join(absolute, name), "utf8") }));
}

/** Applies every migration (wrangler order: filename) and then the seed. */
export function buildDatabase(kind) {
  const spec = kind === "delivery"
    ? { migrations: "apps/client/migrations", seed: "seed-delivery.sql" }
    : { migrations: "apps/operations/migrations", seed: "seed-ops.sql" };
  const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const applied = migrations(spec.migrations);
  for (const migration of applied) {
    try { sqlite.exec(migration.sql); }
    catch (error) { throw new Error(`${spec.migrations}/${migration.name}: ${error.message}`); }
  }
  const schema = () => sqlite.prepare("SELECT group_concat(type||':'||name||':'||coalesce(sql,''),'|') s FROM (SELECT * FROM sqlite_master ORDER BY type,name)").get().s;
  const before = schema();
  sqlite.exec(readFileSync(path.join(fixtureDir, spec.seed), "utf8"));
  return { sqlite, d1: new SqliteD1(sqlite), migrations: applied.map(item => item.name), seedChangedSchema: schema() !== before };
}

export function buildFixtureDatabases() {
  return { delivery: buildDatabase("delivery"), ops: buildDatabase("ops") };
}

export function sha256File(relative) {
  return createHash("sha256").update(readFileSync(path.join(fixtureDir, relative))).digest("hex");
}

/** Digest of the README with its own pin line blanked, so the README can pin itself. */
export function readmeDigest() {
  const text = readFileSync(path.join(fixtureDir, "README.md"), "utf8").replace(/\r\n/g, "\n")
    .replace(/^(\| `README\.md` \| `)[0-9a-f]{64}(` \|.*)$/m, "$1<self>$2");
  return createHash("sha256").update(text).digest("hex");
}

export function currentDigests() {
  return Object.fromEntries(PINNED_FILES.map(file => [file,
    file === "README.md" ? readmeDigest() : createHash("sha256")
      .update(readFileSync(path.join(fixtureDir, file), "utf8").replace(/\r\n/g, "\n")).digest("hex")]));
}

const FIXTURE_PATHS = [":(exclude)qa/sharing-698", ":(exclude)apps/operations/test/qa-sharing-698-contract.test.ts"];
function git(...args) { return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function gitSucceeds(...args) { try { execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" }); return true; } catch { return false; } }

/** Binds the fixture to the exact #698 product commit and tree (full 40-hex ids,
 * never a prefix): the ids in contract.json and the README pin table must be the
 * real commit and its real tree, this checkout must descend from that commit, and
 * no product file may differ from it. Returns a list of failures (empty = bound). */
export function checkProductPin() {
  const failures = [];
  const { commit, tree } = JSON.parse(readFileSync(path.join(fixtureDir, "contract.json"), "utf8")).product;
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) failures.push(`contract.json product.commit is not a full 40-hex id: ${commit}`);
  if (!/^[0-9a-f]{40}$/.test(tree ?? "")) failures.push(`contract.json product.tree is not a full 40-hex id: ${tree}`);
  if (failures.length) return failures;
  let resolved = "", resolvedTree = "";
  try {
    resolved = git("rev-parse", "--verify", `${commit}^{commit}`);
    resolvedTree = git("rev-parse", "--verify", `${commit}^{tree}`);
  } catch { failures.push(`product commit ${commit} is not present in this repository`); return failures; }
  if (resolved !== commit) failures.push(`product commit resolves to ${resolved}, not ${commit}`);
  if (resolvedTree !== tree) failures.push(`product commit tree is ${resolvedTree}, not the pinned ${tree}`);
  if (!gitSucceeds("merge-base", "--is-ancestor", commit, "HEAD")) failures.push(`HEAD does not descend from the product commit ${commit}`);
  if (!gitSucceeds("diff", "--quiet", commit, "--", ".", ...FIXTURE_PATHS)) failures.push("a product file differs from the pinned product commit");
  const readme = readFileSync(path.join(fixtureDir, "README.md"), "utf8");
  const commitRow = readme.match(/^\| Product commit \(#698 head\) \| `([^`]+)` \|\s*$/m)?.[1];
  const treeRow = readme.match(/^\| Product tree \| `([^`]+)` \|\s*$/m)?.[1];
  if (commitRow !== commit) failures.push(`README product commit row is ${commitRow}, not ${commit}`);
  if (treeRow !== tree) failures.push(`README product tree row is ${treeRow}, not ${tree}`);
  for (const id of new Set([...readme.matchAll(/\b9931fc34[0-9a-f]*\b/g)].map(match => match[0])))
    if (id !== "9931fc34" && id !== commit) failures.push(`README mentions a different #698 commit id ${id}`);
  return failures;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/g;

/** One UUID per entity, used everywhere. contract.json "entities" is the single
 * registry: its UUIDs must be unique v4 UUIDs; every UUID in the seeds, the rest of
 * the contract and the README must be registered; every registered UUID must be used;
 * each principal's signer input (subject) and each staff member's id and subject must
 * be that entity's UUID; and the seeded rows must bind the same UUIDs. */
export function checkEntityConsistency() {
  const failures = [];
  const contract = JSON.parse(readFileSync(path.join(fixtureDir, "contract.json"), "utf8"));
  const entities = contract.entities ?? {};
  const byUuid = new Map();
  for (const [name, uuid] of Object.entries(entities)) {
    if (!new RegExp(`^${UUID.source}$`).test(uuid)) failures.push(`entity ${name} is not a v4 UUID: ${uuid}`);
    if (byUuid.has(uuid)) failures.push(`entities ${byUuid.get(uuid)} and ${name} share ${uuid}`);
    byUuid.set(uuid, name);
  }
  const { entities: _registry, ...rest } = contract;
  const sources = {
    "seed-delivery.sql": readFileSync(path.join(fixtureDir, "seed-delivery.sql"), "utf8"),
    "seed-ops.sql": readFileSync(path.join(fixtureDir, "seed-ops.sql"), "utf8"),
    "seed-viewer.sql": readFileSync(path.join(fixtureDir, "seed-viewer.sql"), "utf8"),
    "viewer-manifest.json": readFileSync(path.join(fixtureDir, "viewer-manifest.json"), "utf8"),
    "contract.json (outside entities)": JSON.stringify(rest),
    "README.md": readFileSync(path.join(fixtureDir, "README.md"), "utf8"),
  };
  const used = new Set();
  for (const [source, text] of Object.entries(sources))
    for (const uuid of text.match(UUID) ?? []) {
      if (!byUuid.has(uuid)) failures.push(`${source} uses an unregistered UUID ${uuid}`);
      used.add(uuid);
    }
  for (const [name, uuid] of Object.entries(entities)) if (!used.has(uuid)) failures.push(`entity ${name} is registered but never used`);
  for (const [key, principal] of Object.entries(contract.access?.clients ?? {}))
    if (principal.subject !== entities[principal.entity]) failures.push(`signer input ${key}.subject is not entity ${principal.entity}`);
  for (const [key, staff] of Object.entries(contract.access?.staff ?? {}))
    if (staff.id !== entities[staff.entity] || staff.subject !== entities[staff.entity])
      failures.push(`signer input ${key} id/subject are not entity ${staff.entity}`);
  const { delivery, ops } = buildFixtureDatabases();
  for (const [key, principal] of Object.entries(contract.access?.clients ?? {})) {
    const row = delivery.sqlite.prepare("SELECT id,subject,verified_email FROM portal_v2_identities WHERE id=?").get(principal.subject);
    if (!row || row.subject !== principal.subject || row.verified_email !== principal.email) failures.push(`seed identity for ${key} does not match its signer input`);
    const member = delivery.sqlite.prepare("SELECT 1 ok FROM portal_v2_workspace_memberships WHERE workspace_id=? AND identity_id=?").get(principal.workspace, principal.subject);
    if (!member) failures.push(`seed has no membership of ${key} in ${principal.workspace}`);
  }
  for (const [key, staff] of Object.entries(contract.access?.staff ?? {})) {
    const row = ops.sqlite.prepare("SELECT id,access_subject,email FROM staff_users WHERE id=?").get(staff.id);
    if (!row || row.access_subject !== staff.subject || row.email !== staff.email) failures.push(`seed staff row for ${key} does not match its signer input`);
  }
  if (contract.viewer?.project?.id !== entities["viewer.project"] || contract.viewer?.task?.id !== entities["viewer.task"]
    || contract.viewer?.task?.modelId !== entities["viewer.model"] || contract.projectGrant?.viewerProjectId !== entities["viewer.project"])
    failures.push("Viewer project/task/model ids are not the registered entities");
  return failures;
}

function pinnedDigests() {
  const text = readFileSync(path.join(fixtureDir, "README.md"), "utf8");
  const pins = {};
  for (const match of text.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|/gm)) pins[match[1]] = match[2];
  return pins;
}

function validate() {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const { delivery, ops } = buildFixtureDatabases();
  const one = (db, sql, ...values) => db.sqlite.prepare(sql).get(...values);
  for (const [name, db] of [["delivery", delivery], ["ops", ops]]) {
    const violations = db.sqlite.prepare("PRAGMA foreign_key_check").all();
    check(violations.length === 0, `${name}: foreign key violations ${JSON.stringify(violations)}`);
    check(one(db, "PRAGMA integrity_check").integrity_check === "ok", `${name}: integrity_check failed`);
  }
  check(delivery.migrations.length > 0 && ops.migrations.length > 0, "no migrations applied");
  const registry = JSON.stringify(Object.values(JSON.parse(readFileSync(path.join(fixtureDir, "contract.json"), "utf8")).entities));
  const counts = {
    workspaces: one(delivery, "SELECT count(*) n FROM portal_v2_workspaces WHERE id IN (SELECT value FROM json_each(?))", registry).n,
    sourceReservations: one(delivery, "SELECT count(*) n FROM pa_portal_workspace_sources WHERE workspace_id IN (SELECT value FROM json_each(?))", registry).n,
    identities: one(delivery, "SELECT count(*) n FROM portal_v2_identities WHERE id IN (SELECT value FROM json_each(?))", registry).n,
    entitlements: one(delivery, "SELECT count(*) n FROM portal_v2_entitlements WHERE id IN (SELECT value FROM json_each(?))", registry).n,
    targets: one(delivery, "SELECT count(*) n FROM client_share_folder_targets WHERE id IN (SELECT value FROM json_each(?))", registry).n,
    delegatedShares: one(delivery, "SELECT count(*) n FROM client_delegated_shares WHERE id IN (SELECT value FROM json_each(?))", registry).n,
    directGrants: one(delivery, "SELECT count(*) n FROM viewer_direct_client_grants").n,
    staff: one(ops, "SELECT count(*) n FROM staff_users WHERE id IN (SELECT value FROM json_each(?))", registry).n,
    overrides: one(ops, "SELECT count(*) n FROM staff_permission_overrides WHERE id IN (SELECT value FROM json_each(?))", registry).n,
  };
  const expected = JSON.parse(readFileSync(path.join(fixtureDir, "contract.json"), "utf8")).seedCounts;
  check(JSON.stringify(counts) === JSON.stringify(expected), `seed counts ${JSON.stringify(counts)} != contract ${JSON.stringify(expected)}`);
  for (const [name, db] of [["delivery", delivery], ["ops", ops]]) check(!db.seedChangedSchema, `${name}: the seed changed the schema`);
  const seeds = ["seed-delivery.sql", "seed-ops.sql"].map(file => readFileSync(path.join(fixtureDir, file), "utf8")).join("\n");
  for (const email of seeds.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [])
    check(email.endsWith("@example.test"), `non-example.test address in seed: ${email}`);
  for (const failure of checkProductPin()) failures.push(failure);
  for (const failure of checkEntityConsistency()) failures.push(failure);
  const pins = pinnedDigests(), actual = currentDigests();
  for (const file of PINNED_FILES) check(pins[file] === actual[file], `digest mismatch for ${file}: README ${pins[file]} actual ${actual[file]}`);
  console.log(JSON.stringify({ deliveryMigrations: delivery.migrations.length, opsMigrations: ops.migrations.length,
    lastDeliveryMigration: delivery.migrations.at(-1), lastOpsMigration: ops.migrations.at(-1), counts }, null, 1));
  if (failures.length) { for (const failure of failures) console.error(`FAIL ${failure}`); process.exit(1); }
  console.log("fixture seed: OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--digests")) console.log(JSON.stringify(currentDigests(), null, 1));
  else validate();
}
