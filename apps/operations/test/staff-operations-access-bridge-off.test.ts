// The 0244 Operations-access route with the 0225 native bridge switch OFF
// (native_staff_access_reconciliation.enabled=0, as in production): the route's
// actor fence is the 0243 pattern (admission, profile, staff identity) and never
// reads the 0225 switch. Real mounted worker, real Access assertions, real D1
// migration chain (Miniflare), hires from the real Ops onboarding flow.
// Synthetic identities and hosts only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OperationsAccessFixture, origin, type Person } from "./helpers/staff-operations-access-fixture";
import { csrfToken } from "../src/worker/request-security";
import type { StaffPrincipal } from "../src/worker/types";

const keys = vi.hoisted(() => ({ resolver: undefined as unknown }));
vi.mock("../src/worker/access-jwks", () => ({ accessJwksResolver: () => keys.resolver }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

let f: OperationsAccessFixture;
const bridge = () => f.db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first("enabled");
async function roster(who: Person) {
  return f.fetch(new Request(`${origin}/api/team/staff`, { headers: { "Cf-Access-Jwt-Assertion": await f.token(who.email, who.subject) } }));
}
async function nativeSession(who: Person) {
  return f.fetch(new Request(`${origin}/api/native-staff/session`, { headers: { "Cf-Access-Jwt-Assertion": await f.token(who.email, who.subject),
    "X-Native-Staff-Request": "1", "Sec-Fetch-Site": "same-origin", Accept: "application/json" } }));
}

describe("0244 Operations-access route with the 0225 bridge switch off (mounted worker)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    f = await OperationsAccessFixture.create(keys, "b2000000");
    await f.seedOnboarders();
  }, 300_000);
  afterAll(async () => f?.dispose());

  it("GET and POST grant/revoke work for an authorized native actor on an Ops-onboarded hire while the native session is 404", async () => {
    expect(await bridge()).toBe(0);
    const actor = await f.person({ role: "role-admin" }), hire = await f.nativeHire();
    // The Team UI's native session readiness is unavailable in this state.
    expect((await nativeSession(actor)).status).toBe(404);

    const view = await f.view(actor, hire.id);
    expect(view).toMatchObject({ staffId: hire.id, targetEditable: true, targetReason: null, revision: 0 });
    expect(view.permissions.find(entry => entry.permission === "team.view"))
      .toEqual({ permission: "team.view", state: "none", operation: "grant", editable: true, reason: null });

    expect((await roster(hire)).status).toBe(403);
    const granted = await f.change(actor, hire.id, "team.view");
    expect(granted.response.status, await granted.response.clone().text()).toBe(200);
    expect(await granted.response.json()).toEqual({ receipt: { commandId: granted.body.commandId, staffId: hire.id,
      permission: "team.view", operation: "grant", revision: 1, replayed: false } });
    expect((await roster(hire)).status).toBe(200);

    const revoked = await f.change(actor, hire.id, "team.view");
    expect(revoked.body.operation).toBe("revoke");
    expect(revoked.response.status).toBe(200);
    expect(await revoked.response.json()).toMatchObject({ receipt: { operation: "revoke", revision: 2, replayed: false } });
    expect((await f.overrideRow(hire.id, "team.view")).results).toEqual([]);
    expect((await roster(hire)).status).toBe(403);
    expect(await f.db.prepare("SELECT action FROM audit_events WHERE entity_id=? AND actor_id=? ORDER BY id").bind(hire.id, actor.id).all())
      .toMatchObject({ results: [{ action: "staff.operations_access.granted" }, { action: "staff.operations_access.revoked" }] });
    expect(await bridge()).toBe(0);
    // Contrast: the session 404 above is the 0225 switch, not fixture routing.
    await f.db.prepare("UPDATE native_staff_access_reconciliation SET enabled=1 WHERE singleton=1").run();
    try { expect((await nativeSession(actor)).status).not.toBe(404); }
    finally { await f.db.prepare("UPDATE native_staff_access_reconciliation SET enabled=0 WHERE singleton=1").run(); }
  });

  it("a legacy-only administrator without a native admission is refused on GET and POST, with nothing written", async () => {
    expect(await bridge()).toBe(0);
    const legacy = await f.person({ role: "role-admin", native: false }), hire = await f.nativeHire();
    // The same legacy admin still passes the legacy staff fence (0225 off), so the refusal is the 0244 fence.
    expect((await roster(legacy)).status).toBe(200);
    await f.refused(() => f.get(legacy, hire.id), 403, "staff_operations_access_denied");
    const csrf = await csrfToken(f.env(), { accessSubject: legacy.subject } as StaffPrincipal);
    await f.refused(() => f.post(legacy, hire.id, { commandId: crypto.randomUUID(), permission: "team.view", operation: "grant",
      expectedRevision: 0, expectedAdmissionVersion: 1, reason: "Refused" }, { csrf }), 403, "staff_operations_access_denied");
    expect((await f.overrideRow(hire.id, "team.view")).results).toEqual([]);
  });
});
