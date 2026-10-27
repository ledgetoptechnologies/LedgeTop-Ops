import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { constants, createHash, generateKeyPairSync, randomUUID, sign as signBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { buildOwnerApprovalReceipt, canonicalJson, initializeNativeStaffBootstrapApprovalRegistry,
  issueNativeStaffBootstrapApproval, protectedSign, readNativeStaffBootstrapApprovalRegistry,
  verifyNativeStaffBootstrapOwnerApprovalReceipt } from "../../../scripts/native-staff-bootstrap-owner-approval.mjs";
import { runNativeStaffBootstrapApprovedExecutor } from "../../../scripts/native-staff-bootstrap-approved-executor.mjs";
import { readNativeStaffBootstrapSnapshot } from "../../../scripts/native-staff-bootstrap-d1.mjs";

const shared = vi.hoisted(() => ({ config: null as any }));
vi.mock("../../../scripts/native-staff-bootstrap-approved-executor-config.mjs", () => ({
  loadPinnedNativeStaffBootstrapExecutorConfig: () => shared.config,
}));
// Test-only trust root: pins the checked-in manifest bytes independently while
// leaving the distribution checker and all file/hash verification real.
vi.mock("../../../scripts/native-staff-bootstrap-owner-approval-distribution-pin-value.mjs", () => ({
  PINNED_OWNER_APPROVAL_DISTRIBUTION_SHA256: "a9222381dab3bb71c6e58aec9f283706be84e3c66e7557806c6a28c127fca45c",
}));

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const EXPECTED_MIGRATION_NAMES_HASH = "e9ca08f7e051a7581da54ba585b740d0cbf033c91f69470649750ae2fdabd8a7";
const dbId = "9aeec655-69dd-466c-b1a4-b134d081a746";
let runtime: Miniflare, db: D1Database, tempRoot: string, accessToken: string, accessJwk: JsonWebKey;
let config: any, receipt: any, artifact: any, mutationBatches = 0, sessionReads = 0;
let sessionStaffId = "synthetic-owner";

function protectSyntheticKey(pkcs8: Buffer, entropy: string, target: string) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$protectedDataAssembly=Join-Path $PSHOME 'System.Security.Cryptography.ProtectedData.dll'",
    "Add-Type -Path $protectedDataAssembly",
    "$inputText=[Console]::In.ReadToEnd()",
    "$request=ConvertFrom-Json -InputObject $inputText -AsHashtable",
    "$key=[Convert]::FromBase64String([string]$request.keyBase64)",
    "$entropyBytes=[Text.Encoding]::UTF8.GetBytes([string]$request.entropy)",
    "$protected=[Security.Cryptography.ProtectedData]::Protect($key,$entropyBytes,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))",
    "[Array]::Clear($key,0,$key.Length)",
    "[Array]::Clear($entropyBytes,0,$entropyBytes.Length)",
  ].join("; ");
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: JSON.stringify({ keyBase64: pkcs8.toString("base64"), entropy }), encoding: "utf8", windowsHide: true,
    timeout: 20_000, maxBuffer: 16 * 1024, stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(result.stdout.trim()))
    throw new Error("native_bootstrap_test_dpapi_fixture_unavailable");
  writeFileSync(target, Buffer.from(result.stdout.trim(), "base64"), { flag: "wx", mode: 0o600 });
}

async function addPerson(id: string, email: string, displayName: string, subject: string) {
  await db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')")
    .bind(id, email, displayName, subject).run();
  return { id, email, displayName, subject };
}

async function addOwnerAuthority(owner: { id: string; email: string; displayName: string; subject: string }) {
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
      .bind(owner.id, owner.subject, owner.id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
      .bind(owner.id, owner.email, owner.displayName),
  ]);
  const caps = ["staff.onboarding.create", "staff.onboarding.approve", "staff.admission.disable", "staff.membership.manage",
    "staff.directory_grant.manage", "staff.admin_delegation.manage", "staff.admission.enable", "staff.profile.edit", "staff.profile.read"];
  await db.batch(caps.map(capability => db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`)
    .bind(`${owner.id}:${capability}`, owner.id, capability, owner.id)));
  const ceilings = [
    ...["directory.profile.view", "directory.profile.edit", "directory.identity.link", "directory.enrollment.manage", "directory.portal_access.manage"]
      .map(capability => ["directory", capability] as const),
    ...caps.slice(0, 6).map(capability => ["staff_admin", capability] as const),
  ];
  await db.batch(ceilings.map(([domain, capability]) => db.prepare(`INSERT INTO native_staff_delegation_ceilings
    (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
    VALUES(?,?,?,?, 'allow',1,1,1,1,'global')`).bind(`${owner.id}:ceiling:${domain}:${capability}`,
      `${owner.id}:${domain === "directory" ? "staff.directory_grant.manage" : "staff.admin_delegation.manage"}`, domain, capability)));
}

function accessJwt(access: any, privateKey: any, kid: string, subject = access.owner.accessSubject) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "RS256", kid, typ: "JWT" });
  const claims = b64url({ iss: access.issuer, aud: access.audience, sub: subject,
    type: "app", iat: now - 10, exp: now + 300, jti: randomUUID() });
  const input = `${header}.${claims}`;
  return `${input}.${signBytes("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

async function managementFetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.origin === config.access.issuer && url.pathname === "/cdn-cgi/access/certs")
    return new Response(JSON.stringify({ keys: [{ ...accessJwk, kid: "synthetic-access-key", alg: "RS256", use: "sig" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  if (url.origin === config.access.origin && url.pathname === "/api/session") {
    sessionReads++;
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("cf-access-token")).toBe(accessToken);
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    return new Response(JSON.stringify({ user: { id: sessionStaffId }, csrfToken: "synthetic-csrf-token-with-adequate-length-123" }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.target.accountId}/d1/database/${config.target.databaseId}`;
  if (url.origin !== "https://api.cloudflare.com" || !url.href.startsWith(base)) throw new Error("unexpected_synthetic_fetch_target");
  if (url.pathname === `/client/v4/accounts/${config.target.accountId}/d1/database/${dbId}` && init?.method === "GET")
    return new Response(JSON.stringify({ success: true, result: { uuid: dbId, name: "synthetic-ops-db" } }),
      { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === `/client/v4/accounts/${config.target.accountId}/d1/database/${dbId}/query` && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    if (!Array.isArray(body.batch) || body.batch.length < 1 || body.batch.length > 256) throw new Error("synthetic_batch_invalid");
    if (body.batch.some((statement: any) => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(statement.sql))) mutationBatches++;
    const results = await db.batch(body.batch.map((statement: any) => db.prepare(statement.sql).bind(...statement.params)));
    return new Response(JSON.stringify({ success: true, result: results.map(result => ({ success: result.success === true, results: result.results ?? [] })) }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error("unexpected_synthetic_provider_request");
}

describe.skipIf(process.platform !== "win32")(
  "approved native staff bootstrap executor against synthetic full-schema D1", () => {
    beforeAll(async () => {
      tempRoot = mkdtempSync(path.join(os.tmpdir(), "native-staff-approved-executor-"));
      const signer = generateKeyPairSync("rsa", { modulusLength: 3072 });
      const access = generateKeyPairSync("rsa", { modulusLength: 2048 });
      accessJwk = access.publicKey.export({ format: "jwk" }) as JsonWebKey;
      const signerPem = signer.publicKey.export({ type: "spki", format: "pem" }).toString();
      const entropy = "synthetic-executor-test-entropy-material-long-enough-0123456789";
      const privatePath = path.join(tempRoot, "synthetic-signer.dpapi");
      protectSyntheticKey(signer.privateKey.export({ type: "pkcs8", format: "der" }), entropy, privatePath);
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      config = {
        schemaVersion: 1, kind: "operations-native-staff-bootstrap-trust-config-v1",
        target: { accountId: "846c924bf17bf4f3dd15c97a4c5d1d51", databaseId: dbId },
        source: { commit, migrationNamesSha256: EXPECTED_MIGRATION_NAMES_HASH },
        access: { origin: "https://ops.example.test", issuer: "https://synthetic.cloudflareaccess.com", audience: "S".repeat(32),
          cloudflaredExecutablePath: "C:\\synthetic\\cloudflared.exe", cloudflaredExecutableSha256: "a".repeat(64),
          owner: { staffId: "synthetic-owner", accessSubject: "access|synthetic-owner" } },
        signer: { algorithm: "RSA-PSS-SHA256", keyId: sha(Buffer.from(signerPem.replace(/-----[^-]+-----/gu, "").replace(/\s/gu, ""), "base64")),
          publicKeyPem: signerPem, protectedPrivateKeyPath: privatePath, dpapiEntropy: entropy },
        receiptDirectory: tempRoot,
      };
      shared.config = config;
      accessToken = accessJwt(config.access, access.privateKey, "synthetic-access-key");
      runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
        script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
      db = await runtime.getD1Database("OPS_DB") as D1Database;
      await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
      const migrationDirectory = new URL("../migrations/", import.meta.url);
      for (const name of Array.from((await import("node:fs")).readdirSync(migrationDirectory)).filter((item: string) => /^\d{4}_.+\.sql$/u.test(item)
        && Number(item.slice(0, 4)) <= 225).sort()) {
        const sql = readFileSync(new URL(name, migrationDirectory), "utf8");
        await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
        await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name).run();
      }
      const owner = await addPerson(config.access.owner.staffId, "owner@example.test", "Synthetic Owner", config.access.owner.accessSubject);
      const employee = await addPerson("synthetic-employee", "employee@example.test", "Synthetic Employee", "access|synthetic-employee");
      await addOwnerAuthority(owner);
      const snapshot = await readNativeStaffBootstrapSnapshot(db, [employee.id]);
      const approvalId = randomUUID(), commandId = randomUUID();
      const plan = { kind: "operations-native-staff-bootstrap-install-v1", reviewedSnapshotSha256: snapshot.snapshotSha256,
        approvalId, staffCohort: [employee.id], controlPlaneStaffIds: snapshot.controlPlaneStaffIds,
        rows: [
          { table: "native_staff_admissions", row: { staff_id: employee.id, bound_access_subject: employee.subject, active: 1, admitted_by: owner.id } },
          { table: "native_staff_profiles", row: { staff_id: employee.id, login_email: employee.email, display_name: employee.displayName, version: 1 } },
        ] };
      artifact = { canonicalPlanJson: canonicalJson(plan), bindingEvidenceJson: canonicalJson({ kind: "synthetic-binding-v1", owner: owner.id, employee: employee.id }),
        reviewedSnapshot: snapshot, commandId };
      const rows = JSON.parse(snapshot.snapshotJson).rows;
      const ownerAdmission = rows.native_staff_admissions.find((row: any) => row.staff_id === owner.id);
      const ownerProfile = rows.native_staff_profiles.find((row: any) => row.staff_id === owner.id);
      const packet = { schemaVersion: 1, kind: "operations-current-staff-cohort-review-draft-v1", ownerStaffId: owner.id,
        snapshotSha256: snapshot.snapshotSha256, status: "draft", advisory: true, executionAuthority: false, bootstrapApproval: false,
        installerClaim: false, tables: rows,
        cohort: [
          { staffId: owner.id, email: owner.email, displayName: owner.displayName, accessSubject: owner.subject, status: "active",
            bridgeStatus: "matched", admission: ownerAdmission, profile: ownerProfile, directoryGrantCount: 0, projectGrantCount: 0, managementDelegationCount: 9 },
          { staffId: employee.id, email: employee.email, displayName: employee.displayName, accessSubject: employee.subject, status: "active",
            bridgeStatus: "not_admitted", admission: null, profile: null, directoryGrantCount: 0, projectGrantCount: 0, managementDelegationCount: 0 },
        ] };
      const liveReview = { packet, packetSha256: sha(canonicalJson(packet)) };
      const now = Date.now();
      const accessClaims = { issuer: config.access.issuer, audience: config.access.audience, subject: config.access.owner.accessSubject,
        issuedAt: Math.floor(now / 1000) - 10, expiresAt: Math.floor(now / 1000) + 300, assertionSha256: sha(accessToken) };
      const built = buildOwnerApprovalReceipt({ config, artifact, liveReview, ownerClaims: accessClaims, now, authorizationChallenge: sha("challenge") });
      const signature = signBytes("sha256", Buffer.from(canonicalJson(built.payload)), { key: signer.privateKey,
        padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString("base64");
      receipt = { schemaVersion: 1, kind: "operations-native-staff-bootstrap-owner-approval-v1", algorithm: "RSA-PSS-SHA256",
        keyId: built.keyId, payload: built.payload, signature };
      verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt, { config, expected: {
        approval: { approvalId: built.payload.trustEnvelope.approvalId, approvedOperatorStaffId: owner.id,
          approvedOperatorAccessSubject: owner.subject, issuedByStaffId: owner.id, issuedByAccessSubject: owner.subject,
          issuedAt: built.payload.trustEnvelope.authorizedAt, expiresAt: built.payload.trustEnvelope.expiresAt },
        commandId, canonicalPlanJson: artifact.canonicalPlanJson, bindingEvidenceJson: artifact.bindingEvidenceJson,
        reviewedSnapshot: artifact.reviewedSnapshot,
      } });
      initializeNativeStaffBootstrapApprovalRegistry(config, protectedSign);
      issueNativeStaffBootstrapApproval(config, receipt, protectedSign);
    }, 300_000);

    afterAll(async () => {
      await runtime?.dispose();
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    it("previews, executes the exact one-shot approval and refuses replay", async () => {
      const dependencies = { artifact, receipt, getAccessToken: () => accessToken,
        getBearerToken: () => "synthetic-provider-token-never-logged", fetchImpl: managementFetch };
      const preview = await runNativeStaffBootstrapApprovedExecutor(dependencies);
      expect(preview.mode).toBe("preview");
      expect(preview.snapshotSha256).toBe(artifact.reviewedSnapshot.snapshotSha256);
      expect(mutationBatches).toBe(0);
      const wrongAccess = generateKeyPairSync("rsa", { modulusLength: 2048 });
      accessToken = accessJwt(config.access, wrongAccess.privateKey, "synthetic-access-key", "access|different-owner");
      await expect(runNativeStaffBootstrapApprovedExecutor(dependencies)).rejects.toThrow(/access_token_claims_invalid/u);
      expect(mutationBatches).toBe(0);
      accessToken = accessJwt(config.access, wrongAccess.privateKey, "synthetic-access-key", config.access.owner.accessSubject);
      accessJwk = wrongAccess.publicKey.export({ format: "jwk" }) as JsonWebKey;
      sessionStaffId = "different-owner";
      await expect(runNativeStaffBootstrapApprovedExecutor(dependencies)).rejects.toThrow(/access_session_owner_mismatch/u);
      expect(mutationBatches).toBe(0);
      sessionStaffId = config.access.owner.staffId;
      // A routine JWT refresh for the same pinned owner must remain accepted;
      // it does not pretend the receipt ceremony nonce is a browser session id.
      const freshAccess = generateKeyPairSync("rsa", { modulusLength: 2048 });
      accessJwk = freshAccess.publicKey.export({ format: "jwk" }) as JsonWebKey;
      accessToken = accessJwt(config.access, freshAccess.privateKey, "synthetic-access-key");
      const executed = await runNativeStaffBootstrapApprovedExecutor({ ...dependencies, mode: "execute", preparedSha256: preview.preparedSha256 });
      expect(executed.outcome).toBe("consumed");
      expect(executed.approvalId).toBe(receipt.payload.trustEnvelope.approvalId);
      expect(mutationBatches).toBe(1);
      expect(sessionReads).toBeGreaterThanOrEqual(3);
      expect(readNativeStaffBootstrapApprovalRegistry(config).envelope.payload.entries[0].state).toBe("consumed");
      await expect(runNativeStaffBootstrapApprovedExecutor({ ...dependencies, mode: "execute", preparedSha256: preview.preparedSha256 }))
        .rejects.toThrow(/approval_not_issued/u);
      expect(mutationBatches).toBe(1);
    }, 300_000);
  },
);
