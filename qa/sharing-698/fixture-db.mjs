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
  "fixture-db.mjs", "fixture-db.d.mts", "ephemeral-access.mjs", "ephemeral-access.d.mts", "../../apps/operations/test/qa-sharing-698-contract.test.ts"];

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
  sqlite.exec(readFileSync(path.join(fixtureDir, spec.seed), "utf8"));
  return { sqlite, d1: new SqliteD1(sqlite), migrations: applied.map(item => item.name) };
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
  const counts = {
    workspaces: one(delivery, "SELECT count(*) n FROM portal_v2_workspaces WHERE id LIKE 'qa698-%'").n,
    sourceReservations: one(delivery, "SELECT count(*) n FROM pa_portal_workspace_sources WHERE workspace_id LIKE 'qa698-%'").n,
    identities: one(delivery, "SELECT count(*) n FROM portal_v2_identities WHERE id LIKE 'qa698-%'").n,
    entitlements: one(delivery, "SELECT count(*) n FROM portal_v2_entitlements WHERE id LIKE 'qa698-%'").n,
    targets: one(delivery, "SELECT count(*) n FROM client_share_folder_targets WHERE id LIKE 'qa698-%'").n,
    delegatedShares: one(delivery, "SELECT count(*) n FROM client_delegated_shares WHERE id LIKE 'qa698-%'").n,
    directGrants: one(delivery, "SELECT count(*) n FROM viewer_direct_client_grants").n,
    staff: one(ops, "SELECT count(*) n FROM staff_users WHERE id LIKE 'qa698-%'").n,
    overrides: one(ops, "SELECT count(*) n FROM staff_permission_overrides WHERE id LIKE 'qa698-%'").n,
  };
  const expected = JSON.parse(readFileSync(path.join(fixtureDir, "contract.json"), "utf8")).seedCounts;
  check(JSON.stringify(counts) === JSON.stringify(expected), `seed counts ${JSON.stringify(counts)} != contract ${JSON.stringify(expected)}`);
  for (const db of [delivery, ops]) {
    const text = db.sqlite.prepare("SELECT group_concat(sql,' ') s FROM sqlite_master").get().s ?? "";
    check(!/qa698/.test(text), "a seed must not change the schema");
  }
  const seeds = ["seed-delivery.sql", "seed-ops.sql"].map(file => readFileSync(path.join(fixtureDir, file), "utf8")).join("\n");
  for (const email of seeds.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [])
    check(email.endsWith("@example.test"), `non-example.test address in seed: ${email}`);
  for (const failure of checkProductPin()) failures.push(failure);
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
