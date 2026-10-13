import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worker = readFileSync(new URL("../apps/client/src/worker/index.ts", import.meta.url), "utf8");

test("native delivery routes precede PA admission without replacing public links", () => {
  const native = worker.indexOf('app.route("/api/client/operations/data", createOperationsNativeDeliveryRouter())');
  const historical = worker.indexOf('app.route("/api/client", createClientPortalRouter(');
  assert.ok(native >= 0 && native < historical);
  assert.match(worker, /export \{ OperationsPortalNativeDeliveryAuthorityIngress \}/);
  assert.match(worker, /app\.get\("\/s\/:publicId"/);
  assert.match(worker, /app\.post\("\/api\/public\/shares\/:routeId\/session"/);
});

test("native delivery production configuration remains off without a new reader binding or audit secret", () => {
  const config = JSON.parse(readFileSync(new URL("../apps/client/wrangler.jsonc", import.meta.url), "utf8"));
  for (const name of ["CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED", "CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED"]) {
    assert.equal(config.vars[name], "false");
  }
  assert.equal(config.vars.CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET, undefined);
  assert.ok(!config.services.some(binding => binding.binding === "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER"));
});

test("native consent is mounted before historical PA admission with independent default-off configuration", () => {
  const start = worker.indexOf('app.all("/api/client/operations/recipient-enrollment/*"');
  const legacyAdmission = worker.indexOf('app.route("/api/client", createClientPortalRouter(');
  assert.ok(start >= 0 && start < legacyAdmission);
  const mount = worker.slice(start, legacyAdmission);
  assert.match(mount, /handleOperationsNativeRecipientEnrollmentHttp\(c\.req\.raw/);
  assert.match(mount, /CLIENT_PORTAL_ENABLED === "true" && c\.env\.CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED === "true"/);
  assert.match(mount, /environment: c\.env\.ENVIRONMENT/);
  assert.match(mount, /origin: c\.env\.CLIENT_PORTAL_ORIGIN \?\? ""/);
  assert.match(mount, /csrfSecret: c\.env\.CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_CSRF_SECRET \?\? ""/);
  assert.match(mount, /binding: c\.env\.OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT/);
  assert.doesNotMatch(mount, /resolveProof|CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE/);
});

test("native consent does not replace the historical recipient enrollment route", () => {
  assert.match(worker, /app\.all\("\/api\/client\/v2\/recipient-enrollment\/\*", c => handleRecipientEnrollmentHttp/);
});

test("native manager controls precede legacy staff admission and require both independent gates", () => {
  const operations = readFileSync(new URL("../apps/operations/src/worker/index.ts", import.meta.url), "utf8");
  const start = operations.indexOf("async function dispatchOperationsNativeRecipientOwner(");
  const legacyAdmission = operations.indexOf('app.use("/api/*", async (c, next) =>');
  assert.ok(start >= 0 && start < legacyAdmission);
  const mount = operations.slice(start, legacyAdmission);
  assert.match(mount, /handleOperationsNativeRecipientOwnerHttp\(c\.req\.raw/);
  assert.match(mount, /CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED === "true"\s*&& c\.env\.CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED === "true"/);
  assert.match(mount, /environment: c\.env\.ENVIRONMENT/);
  assert.match(mount, /expectedHost: c\.env\.EXPECTED_HOST/);
  assert.match(mount, /app\.use\("\/api\/native-client-portal\/operations-recipient-enrollment\/\*", dispatchOperationsNativeRecipientOwner\)/);
});

test("native manager browser page has its own route and preserves the historical tool", () => {
  const main = readFileSync(new URL("../apps/operations/src/client/main.tsx", import.meta.url), "utf8");
  assert.match(main, /window\.location\.pathname === "\/administration\/client-portal\/operations-recipients"/);
  assert.match(main, /operationsRecipientEnrollmentRoute\s*\? <OperationsNativeRecipientEnrollment \/>/);
  assert.match(main, /window\.location\.pathname === "\/administration\/client-portal\/recipients"/);
  assert.match(main, /: recipientEnrollmentRoute\s*\? <ClientPortalRecipientEnrollment \/>/);
});
