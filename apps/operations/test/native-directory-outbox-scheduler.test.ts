import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import type {SharedProfilePortalAuthorityBinding} from '../../../packages/shared/src/shared-business-profile';

const observationDispatch = vi.hoisted(() => vi.fn().mockResolvedValue({status:'acknowledged'}));
vi.mock('../src/worker/native-directory-create-observations',()=>({enqueueNativeDirectoryCreateObservations:vi.fn(),dispatchNativeDirectoryCreateObservation:observationDispatch}));
const profileDispatch = vi.hoisted(() => vi.fn());
const relationshipDispatch = vi.hoisted(() => vi.fn());
const continuationDispatch = vi.hoisted(() => vi.fn());
const lifecycleDispatch = vi.hoisted(() => vi.fn());
const materializeClients = vi.hoisted(() => vi.fn());
const profileRecovery = vi.hoisted(() => vi.fn());
const profileRecoverySchema = vi.hoisted(() => vi.fn());
vi.mock('../src/worker/project-alpha-directory-profile-generation-recovery',()=>({
  profileGenerationRecoverySchema:profileRecoverySchema,recoverDirectoryProfileGeneration:profileRecovery,
}));
vi.mock("../src/worker/project-alpha-directory-profile-outbox-dispatcher", () => ({
  dispatchProjectAlphaDirectoryProfileOutboxCommand: profileDispatch,
}));
vi.mock("../src/worker/project-alpha-directory-relationship-outbox-dispatcher", () => ({
  dispatchProjectAlphaDirectoryRelationshipCommand: relationshipDispatch,
}));
vi.mock("../src/worker/project-alpha-directory-client-intent-materializer", () => ({
  materializeResolvedProjectAlphaDirectoryClientIntents: materializeClients,
}));
vi.mock("../src/worker/native-directory-profile-binding-continuation", () => ({
  profileBindingContinuationEnabled: (env: { ENVIRONMENT?: string; NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED?: string }) =>
    env.NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED === "true"
      && ["local", "staging", "production"].includes(env.ENVIRONMENT ?? ""),
  dispatchNativeDirectoryProfileBindingContinuation: continuationDispatch,
}));
vi.mock("../src/worker/project-alpha-directory-lifecycle-outbox-dispatcher", () => ({
  dispatchProjectAlphaDirectoryLifecycleCommand: lifecycleDispatch,
}));

import { drainNativeDirectoryOutboxes } from "../src/worker/native-directory-outbox-scheduler";

let runtime: Miniflare;
let db: D1Database;
const dueAt = 1_000;

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function connections(sourceIds: readonly string[], disabled: readonly string[] = []): string {
  return JSON.stringify({ version: 1, instances: Object.fromEntries(sourceIds.map((sourceId, index) => [sourceId, {
    sourceId, enabled: !disabled.includes(sourceId), baseUrl: `https://pa-${index}.example.test`, apiKey: `secret-${index}`,
    sourceInstanceId: uuid(index * 3 + 1), applicationId: uuid(index * 3 + 2), historyEpoch: uuid(index * 3 + 3),
  }])) });
}

function environment(sourceIds: readonly string[], disabled: readonly string[] = []) {
  return { OPS_DB: db, NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "true",
    PROJECT_ALPHA_API_V2_CONNECTIONS: connections(sourceIds, disabled) };
}

async function command(queue: "profile" | "relationship", commandId: string, sourceId: string,
  state: "pending" | "leased" | "acknowledged" | "terminal" = "pending", eligibleAt = 0): Promise<void> {
  const table = queue === "profile" ? "project_alpha_directory_outbox" : "project_alpha_directory_relationship_outbox";
  await db.prepare(`INSERT INTO ${table}(command_id,source_id,state,next_attempt_at,lease_expires_at,created_at)
    VALUES(?,?,?,?,?,?)`).bind(commandId, sourceId, state, state === "pending" ? eligibleAt : 0,
      state === "leased" ? eligibleAt : null, `2026-09-22T00:00:${commandId.slice(-2)}.000Z`).run();
}

async function recoveryCommand(commandId: string, sourceId: string): Promise<void> {
  await db.prepare(`INSERT INTO project_alpha_directory_relationship_recovery_outbox
    (command_id,source_id,state,next_attempt_at,lease_expires_at,created_at) VALUES(?,?,'pending',0,NULL,?)`)
    .bind(commandId, sourceId, `2026-09-22T00:00:${commandId.slice(-2)}.000Z`).run();
}

async function lifecycleCommand(commandId: string, sourceId: string, mutationId = `mutation-${commandId}`,
  state: "pending" | "terminal" = "pending"): Promise<void> {
  await db.prepare(`INSERT INTO project_alpha_directory_lifecycle_outbox
    (command_id,mutation_id,source_id,state,next_attempt_at,lease_expires_at,created_at) VALUES(?,?,?,?,0,NULL,?)`)
    .bind(commandId, mutationId, sourceId, state, `2026-09-22T00:00:${commandId.slice(-2)}.000Z`).run();
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await db.prepare('CREATE TABLE native_directory_create_observation_jobs(command_id TEXT PRIMARY KEY,source_id TEXT,created_at TEXT)').run();
  await db.prepare('CREATE TABLE native_directory_create_observation_dispatch(command_id TEXT PRIMARY KEY,state TEXT,next_attempt_at INTEGER,lease_expires_at INTEGER)').run();
  for (const table of ["project_alpha_directory_outbox", "project_alpha_directory_relationship_outbox",
    "project_alpha_directory_relationship_recovery_outbox"])
    await db.prepare(`CREATE TABLE ${table}(command_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,state TEXT NOT NULL,
      next_attempt_at INTEGER NOT NULL,lease_expires_at INTEGER,created_at TEXT NOT NULL,command_json TEXT,outcome_json TEXT)`).run();
  await db.prepare('CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,current_version INTEGER)').run();
  await db.prepare('CREATE TABLE operations_directory_intents(intent_id TEXT PRIMARY KEY,record_id TEXT,record_version INTEGER,state TEXT)').run();
  await db.prepare('CREATE TABLE operations_directory_effective_materializations(intent_id TEXT,command_id TEXT)').run();
  await db.prepare('CREATE TABLE project_alpha_directory_profile_recovery_checks(command_id TEXT PRIMARY KEY,source_id TEXT,next_attempt_at INTEGER,checked_at INTEGER,reason TEXT,state TEXT)').run();
  await db.prepare(`CREATE TABLE native_directory_profile_binding_jobs(
    command_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,created_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE native_directory_profile_binding_dispatch(
    command_id TEXT PRIMARY KEY,state TEXT NOT NULL,next_attempt_at INTEGER NOT NULL,lease_expires_at INTEGER)`).run();
  await db.prepare(`CREATE TABLE project_alpha_directory_lifecycle_outbox(
    command_id TEXT PRIMARY KEY,mutation_id TEXT NOT NULL,source_id TEXT NOT NULL,state TEXT NOT NULL,next_attempt_at INTEGER NOT NULL,
    lease_expires_at INTEGER,created_at TEXT NOT NULL)`).run();
});

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM native_directory_create_observation_dispatch'),db.prepare('DELETE FROM native_directory_create_observation_jobs'),
    db.prepare("DELETE FROM project_alpha_directory_outbox"),
    db.prepare("DELETE FROM project_alpha_directory_relationship_outbox"),
    db.prepare("DELETE FROM project_alpha_directory_relationship_recovery_outbox"),
    db.prepare("DELETE FROM native_directory_profile_binding_jobs"),
    db.prepare("DELETE FROM native_directory_profile_binding_dispatch"),
    db.prepare("DELETE FROM project_alpha_directory_lifecycle_outbox"),
    db.prepare('DELETE FROM operations_directory_effective_materializations'),db.prepare('DELETE FROM operations_directory_intents'),
    db.prepare('DELETE FROM operations_directory_records'),db.prepare('DELETE FROM project_alpha_directory_profile_recovery_checks'),
  ]);
  observationDispatch.mockReset().mockResolvedValue({status:'acknowledged'});
  profileDispatch.mockReset().mockResolvedValue({ status: "acknowledged" });
  relationshipDispatch.mockReset().mockResolvedValue({ status: "acknowledged" });
  continuationDispatch.mockReset().mockResolvedValue({ status: "acknowledged" });
  lifecycleDispatch.mockReset().mockResolvedValue({ status: "acknowledged" });
  materializeClients.mockReset().mockResolvedValue({ examined: 0, materialized: 0, blocked: 0 });
  profileRecoverySchema.mockReset().mockResolvedValue(false);
  profileRecovery.mockReset().mockResolvedValue({status:'blocked',reason:'nonexecution_not_proven'});
});

afterAll(async () => runtime.dispose());

it('backs off unproven terminal updates fairly without starving another recovery or ordinary work',async()=>{
 const source='project-alpha:staging';profileRecoverySchema.mockResolvedValue(true);
 for(const id of ['recovery-a','recovery-b']){
  await command('profile',id,source,'terminal');
  await db.batch([
   db.prepare("UPDATE project_alpha_directory_outbox SET command_json=?,outcome_json=? WHERE command_id=?").bind('{"operation":"update"}','{"httpStatus":409}',id),
   db.prepare('INSERT INTO operations_directory_records VALUES(?,2)').bind(id),
   db.prepare("INSERT INTO operations_directory_intents VALUES(?,?,2,'materialized')").bind(id,id),
   db.prepare('INSERT INTO operations_directory_effective_materializations VALUES(?,?)').bind(id,id),
  ]);
 }
 await command('profile','ordinary-pending',source);
 expect(await drainNativeDirectoryOutboxes(environment([source]),{now:()=>Date.now(),rotationTime:0,maxCommands:3})).toMatchObject({attempted:3,acknowledged:1,blocked:2});
 expect(profileRecovery.mock.calls.map(c=>c[2]).sort()).toEqual(['recovery-a','recovery-b']);
 expect(profileDispatch).toHaveBeenCalledOnce();
 expect((await db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id LIKE ? ORDER BY command_id').bind('recovery-%').all()).results).toEqual([{state:'terminal'},{state:'terminal'}]);
 const checks=(await db.prepare('SELECT state,reason,next_attempt_at FROM project_alpha_directory_profile_recovery_checks').all<{state:string;reason:string;next_attempt_at:number}>()).results;
 expect(checks).toHaveLength(2);expect(checks.every(c=>c.state==='pending'&&c.reason==='nonexecution_not_proven'&&c.next_attempt_at>Date.now())).toBe(true);
 profileRecovery.mockClear();await drainNativeDirectoryOutboxes(environment([source]),{now:()=>Date.now(),rotationTime:0,maxCommands:3});
 expect(profileRecovery).not.toHaveBeenCalled();
 await db.prepare('UPDATE project_alpha_directory_profile_recovery_checks SET next_attempt_at=0').run();
 profileRecovery.mockResolvedValue({status:'blocked',reason:'depth'});
 await drainNativeDirectoryOutboxes(environment([source]),{now:()=>Date.now(),rotationTime:0,maxCommands:3});
 expect((await db.prepare('SELECT state FROM project_alpha_directory_profile_recovery_checks').all()).results).toEqual([{state:'review_required'},{state:'review_required'}]);
 profileRecovery.mockClear();await drainNativeDirectoryOutboxes(environment([source]),{now:()=>Date.now()+600_000,rotationTime:0,maxCommands:3});
 expect(profileRecovery).not.toHaveBeenCalled();
});

it('pins the exact private portal authority reader before asynchronous scheduler work',async()=>{
  const sourceId='project-alpha:primary';await command('profile','portal-profile',sourceId);
  const reader={readAuthority:vi.fn(async()=>({ok:false as const,code:'denied' as const}))};
  const replacement={readAuthority:vi.fn(async()=>({ok:false as const,code:'unavailable' as const}))};
  const env:ReturnType<typeof environment>&{SHARED_PROFILE_PORTAL_AUTHORITY:SharedProfilePortalAuthorityBinding}={...environment([sourceId]),SHARED_PROFILE_PORTAL_AUTHORITY:reader};
  materializeClients.mockImplementationOnce(async()=>{env.SHARED_PROFILE_PORTAL_AUTHORITY=replacement;return{examined:0,materialized:0,blocked:0};});
  profileDispatch.mockImplementationOnce(async dispatchEnv=>{
    expect(dispatchEnv.SHARED_PROFILE_PORTAL_AUTHORITY).toBe(reader);
    await dispatchEnv.SHARED_PROFILE_PORTAL_AUTHORITY.readAuthority({protocolVersion:1,workspaceId:'workspace',sourceId,
      issuer:'https://access.example.test',subject:'portal-user',principalPublicId:'principal',scopeType:'client',publicId:'client'});
    return{status:'blocked',reason:'authority'};
  });
  expect(await drainNativeDirectoryOutboxes(env,{now:()=>dueAt,rotationTime:0,maxCommands:1})).toMatchObject({attempted:1,blocked:1,acknowledged:0});
  expect(reader.readAuthority).toHaveBeenCalledOnce();expect(replacement.readAuthority).not.toHaveBeenCalled();
});

describe("native Directory scheduled outbox drain", () => {
  it.each([undefined, "false", "true"])("pins and forwards the default-off create recovery flag (%s)", async flag => {
    await command("profile", uuid(1), "project-alpha:staging");
    const env = { ...environment(["project-alpha:staging"]),
      PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: flag };
    materializeClients.mockImplementationOnce(async () => {
      env.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED = "changed-after-await";
      return { examined: 0, materialized: 0, blocked: 0 };
    });
    await drainNativeDirectoryOutboxes(env, { now: () => dueAt });
    expect(profileDispatch).toHaveBeenCalledTimes(1);
    expect(profileDispatch.mock.calls[0]![0].PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED).toBe(flag);
  });

  it("checks in the approved production drain flags but does zero work when explicitly disabled", async () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const entrypoint = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    expect(config).toMatch(/"NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED"\s*:\s*"true"/);
    expect(config).toMatch(/"NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED"\s*:\s*"true"/);
    expect(config.match(/"1-56\/5 \* \* \* \*"/g)).toHaveLength(1);
    expect(entrypoint).toContain("drainNativeDirectoryOutboxes(env, { rotationTime: event.scheduledTime })");
    const disabled = new Proxy({ NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "false" }, { get(target, key) {
      if (key === "NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED") return target.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED;
      throw new Error(`unexpected binding access: ${String(key)}`);
    } });
    await expect(drainNativeDirectoryOutboxes(disabled as never)).resolves.toEqual({ status: "disabled",
      attempted: 0, acknowledged: 0, conflicted: 0, uncertain: 0, blocked: 0, failed: 0, exhausted: false });
    expect(profileDispatch).not.toHaveBeenCalled();
    expect(relationshipDispatch).not.toHaveBeenCalled();
    expect(materializeClients).not.toHaveBeenCalled();
  });

  it("does not reference the lifecycle table unless the staging lifecycle flag is exactly true", async () => {
    const sourceId = "project-alpha:staging";
    await db.prepare("DROP TABLE project_alpha_directory_lifecycle_outbox").run();
    try {
      await command("profile", "profile-without-lifecycle-table", sourceId);
      await expect(drainNativeDirectoryOutboxes({ ...environment([sourceId]), ENVIRONMENT: "staging" },
        { now: () => dueAt, rotationTime: 0 })).resolves.toMatchObject({ attempted: 1, acknowledged: 1 });
      expect(lifecycleDispatch).not.toHaveBeenCalled();
    } finally {
      await db.prepare(`CREATE TABLE project_alpha_directory_lifecycle_outbox(
        command_id TEXT PRIMARY KEY,mutation_id TEXT NOT NULL,source_id TEXT NOT NULL,state TEXT NOT NULL,next_attempt_at INTEGER NOT NULL,
        lease_expires_at INTEGER,created_at TEXT NOT NULL)`).run();
    }
  });

  it("adds the lifecycle lane only under staging dual opt-in and maps the canonical flag", async () => {
    const sourceId = "project-alpha:staging", commandId = uuid(92);
    await lifecycleCommand(commandId, sourceId);
    const enabled = { ...environment([sourceId]), ENVIRONMENT: "staging",
      NATIVE_DIRECTORY_LIFECYCLE_ENABLED: "true" };
    await expect(drainNativeDirectoryOutboxes(enabled, { now: () => dueAt, rotationTime: 0 }))
      .resolves.toMatchObject({ attempted: 1, acknowledged: 1 });
    expect(lifecycleDispatch).toHaveBeenCalledWith(expect.objectContaining({
      ENVIRONMENT: "staging", PROJECT_ALPHA_DIRECTORY_LIFECYCLE_ENABLED: "true",
    }), sourceId, commandId, expect.any(Function));

    lifecycleDispatch.mockClear();
    await db.prepare("UPDATE project_alpha_directory_lifecycle_outbox SET state='pending',next_attempt_at=0").run();
    await drainNativeDirectoryOutboxes({ ...enabled, ENVIRONMENT: "production" }, { now: () => dueAt });
    expect(lifecycleDispatch).not.toHaveBeenCalled();
  });

  it("excludes every destination for a lifecycle mutation with a terminal sibling", async () => {
    const sourceId = "project-alpha:staging", mutationId = uuid(95);
    await lifecycleCommand(uuid(96), sourceId, mutationId);
    await lifecycleCommand(uuid(97), sourceId, mutationId, "terminal");
    await expect(drainNativeDirectoryOutboxes({ ...environment([sourceId]), ENVIRONMENT: "staging",
      NATIVE_DIRECTORY_LIFECYCLE_ENABLED: "true" }, { now: () => dueAt }))
      .resolves.toMatchObject({ attempted: 0, acknowledged: 0 });
    expect(lifecycleDispatch).not.toHaveBeenCalled();
  });

  it("preserves a dispatcher caller abort signal through the scheduler deadline wrapper", async () => {
    const sourceId = "project-alpha:staging", commandId = uuid(93);
    await lifecycleCommand(commandId, sourceId);
    let observedSignal: AbortSignal | undefined;
    const controlledFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined;
      observedSignal?.addEventListener("abort", () => reject(new Error("caller aborted")), { once: true });
    }));
    lifecycleDispatch.mockImplementationOnce(async (_env, _source, _command, send: typeof fetch) => {
      const caller = new AbortController();
      const pending = send("https://directory.example.test/lifecycle", { signal: caller.signal });
      caller.abort();
      await expect(pending).rejects.toThrow("caller aborted");
      return { status: "uncertain", reason: "transport" };
    });
    await expect(drainNativeDirectoryOutboxes({ ...environment([sourceId]), ENVIRONMENT: "staging",
      NATIVE_DIRECTORY_LIFECYCLE_ENABLED: "true" }, { now: () => dueAt, send: controlledFetch as typeof fetch }))
      .resolves.toMatchObject({ attempted: 1, uncertain: 1 });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("enforces the scheduler deadline on a stalled body after immediate response headers", async () => {
    const sourceId = "project-alpha:staging", commandId = uuid(94);
    await lifecycleCommand(commandId, sourceId);
    const controlledFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new Error("body deadline")), { once: true });
        },
      })));
    });
    lifecycleDispatch.mockImplementationOnce(async (_env, _source, _command, send: typeof fetch) => {
      const caller = new AbortController();
      const timer = setTimeout(() => caller.abort(), 10_000);
      try {
        const response = await send("https://directory.example.test/lifecycle", { signal: caller.signal });
        await expect(response.text()).rejects.toThrow("body deadline");
      } finally {
        clearTimeout(timer);
      }
      return { status: "uncertain", reason: "transport" };
    });
    await expect(drainNativeDirectoryOutboxes({ ...environment([sourceId]), ENVIRONMENT: "staging",
      NATIVE_DIRECTORY_LIFECYCLE_ENABLED: "true" }, { now: () => dueAt, maxRuntimeMs: 5,
        send: controlledFetch as typeof fetch }))
      .resolves.toMatchObject({ attempted: 1, uncertain: 1 });
  });

  it("propagates body cancellation and clears the scheduler deadline timer", async () => {
    const sourceId = "project-alpha:staging", commandId = uuid(98);
    await lifecycleCommand(commandId, sourceId);
    const cancelled = vi.fn();
    let observedSignal: AbortSignal | undefined;
    const controlledFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
    });
    lifecycleDispatch.mockImplementationOnce(async (_env, _source, _command, send: typeof fetch) => {
      const response = await send("https://directory.example.test/lifecycle");
      await response.body?.cancel("not-needed");
      await new Promise(resolve => setTimeout(resolve, 15));
      return { status: "blocked", reason: "not_due" };
    });
    await expect(drainNativeDirectoryOutboxes({ ...environment([sourceId]), ENVIRONMENT: "staging",
      NATIVE_DIRECTORY_LIFECYCLE_ENABLED: "true" }, { now: () => dueAt, maxRuntimeMs: 5,
        send: controlledFetch as typeof fetch })).resolves.toMatchObject({ attempted: 1, blocked: 1 });
    expect(cancelled).toHaveBeenCalledWith("not-needed");
    expect(observedSignal?.aborted).toBe(false);
  });

  it("selects the continuation lane in production only under explicit dual opt-in", async () => {
    const sourceId = "project-alpha:production", commandId = uuid(91);
    await db.batch([
      db.prepare("INSERT INTO native_directory_profile_binding_jobs(command_id,source_id,created_at) VALUES(?,?,?)")
        .bind(commandId, sourceId, "2026-09-22T00:00:00.000Z"),
      db.prepare("INSERT INTO native_directory_profile_binding_dispatch(command_id,state,next_attempt_at,lease_expires_at) VALUES(?,'pending',0,NULL)")
        .bind(commandId),
    ]);
    const production = { ...environment([sourceId]), ENVIRONMENT: "production",
      NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED: "true" };
    await drainNativeDirectoryOutboxes(production, { now: () => dueAt });
    expect(continuationDispatch).toHaveBeenCalledWith(expect.objectContaining({
      ENVIRONMENT: "production", NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED: "true",
    }), sourceId, commandId, expect.any(Function));

    continuationDispatch.mockClear();
    await db.prepare("UPDATE native_directory_profile_binding_dispatch SET state='pending',next_attempt_at=0").run();
    await drainNativeDirectoryOutboxes({ ...production, NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED: "false" },
      { now: () => dueAt });
    expect(continuationDispatch).not.toHaveBeenCalled();
  });

  it("rejects a malformed disabled sibling before database work or diagnostics", async () => {
    const sourceId = "project-alpha:primary";
    const disabledSource = "project-alpha:disabled";
    const envelope = JSON.parse(connections([sourceId, disabledSource], [disabledSource])) as {
      instances: Record<string, Record<string, unknown>>;
    };
    // The existing resolver validates disabled siblings too. A header-invalid
    // disabled secret must therefore make the scheduler unavailable rather
    // than silently selecting the enabled primary source.
    envelope.instances[disabledSource]!.apiKey = "secret-token\nprivate@example.test";
    const unavailable = new Proxy({
      NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "true",
      PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify(envelope),
    }, { get(target, key) {
      if (key === "OPS_DB") throw new Error("database must not be touched");
      return Reflect.get(target, key);
    } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(drainNativeDirectoryOutboxes(unavailable as never)).resolves.toMatchObject({
        status: "unavailable", attempted: 0,
      });
      expect(profileDispatch).not.toHaveBeenCalled();
      expect(relationshipDispatch).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("drains both queues, recovers expired leases, and skips live leases and terminal rows", async () => {
    const sourceId = "project-alpha:primary";
    await command("profile", "profile-due", sourceId);
    await command("relationship", "relationship-due", sourceId);
    await command("profile", "profile-expired", sourceId, "leased", dueAt - 1);
    await command("relationship", "relationship-live", sourceId, "leased", dueAt + 1);
    await command("profile", "profile-terminal", sourceId, "terminal");
    await command("relationship", "relationship-ack", sourceId, "acknowledged");
    const result = await drainNativeDirectoryOutboxes(environment([sourceId]), { now: () => dueAt, rotationTime: 0 });
    expect(result).toMatchObject({ status: "drained", attempted: 3, acknowledged: 3, failed: 0 });
    expect(profileDispatch.mock.calls.map(call => call[2])).toEqual(["profile-due", "profile-expired"]);
    expect(relationshipDispatch.mock.calls.map(call => call[2])).toEqual(["relationship-due"]);
    expect(materializeClients).toHaveBeenCalledTimes(1);
    expect(materializeClients.mock.calls[0]!.slice(1)).toEqual([[sourceId], 12, dueAt]);
  });

  it("does not query or dispatch recovery commands unless the recovery flag is exactly true", async () => {
    const sourceId = "project-alpha:primary";
    await recoveryCommand("recovery-due", sourceId);
    await expect(drainNativeDirectoryOutboxes(environment([sourceId]), { now: () => dueAt, rotationTime: 0 }))
      .resolves.toMatchObject({ attempted: 0 });
    expect(relationshipDispatch).not.toHaveBeenCalled();

    await expect(drainNativeDirectoryOutboxes({ ...environment([sourceId]),
      PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: "true" },
    { now: () => dueAt, rotationTime: 0 })).resolves.toMatchObject({ attempted: 1, acknowledged: 1 });
    expect(relationshipDispatch).toHaveBeenCalledTimes(1);
    expect(relationshipDispatch.mock.calls[0]![2]).toBe("recovery-due");
    expect(relationshipDispatch.mock.calls[0]![4]).toBe("generation_recovery");
    expect(relationshipDispatch.mock.calls[0]![0].PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED)
      .toBe("true");
  });

  it("rotates fairly across enabled sources and queues while enforcing the work bound", async () => {
    const sources = ["project-alpha:a", "project-alpha:b", "project-alpha:c"];
    const disabledSource = "project-alpha:disabled";
    for (const sourceId of [...sources, disabledSource, "project-alpha:unconfigured"])
      for (const queue of ["profile", "relationship"] as const) {
        const label = sourceId.slice("project-alpha:".length);
        await command(queue, `${label}-${queue}-1`, sourceId);
        await command(queue, `${label}-${queue}-2`, sourceId);
      }
    const order: string[] = [];
    profileDispatch.mockImplementation(async (_env, sourceId, commandId) => {
      order.push(`profile:${sourceId}:${commandId}`); return { status: "acknowledged" };
    });
    relationshipDispatch.mockImplementation(async (_env, sourceId, commandId) => {
      order.push(`relationship:${sourceId}:${commandId}`); return { status: "acknowledged" };
    });
    const selected = environment([...sources, disabledSource], [disabledSource]);
    await expect(drainNativeDirectoryOutboxes(selected, { now: () => dueAt, rotationTime: 0, maxCommands: 4 }))
      .resolves.toMatchObject({ attempted: 4, acknowledged: 4 });
    expect(order).toEqual([
      "profile:project-alpha:a:a-profile-1", "relationship:project-alpha:a:a-relationship-1",
      "profile:project-alpha:b:b-profile-1", "relationship:project-alpha:b:b-relationship-1",
    ]);
    order.length = 0;
    await drainNativeDirectoryOutboxes(selected, { now: () => dueAt, rotationTime: 5 * 60_000, maxCommands: 4 });
    expect(order).toEqual([
      "relationship:project-alpha:b:b-relationship-1", "profile:project-alpha:b:b-profile-1",
      "relationship:project-alpha:c:c-relationship-1", "profile:project-alpha:c:c-profile-1",
    ]);
    expect(order.every(value => !value.includes("disabled") && !value.includes("unconfigured"))).toBe(true);
  });

  it("stops starting commands at the time bound", async () => {
    const sourceId = "project-alpha:primary";
    await command("profile", "profile-one", sourceId);
    await command("profile", "profile-two", sourceId);
    const times = [dueAt, dueAt, dueAt + 101, dueAt + 101];
    const result = await drainNativeDirectoryOutboxes(environment([sourceId]), {
      now: () => times.shift() ?? dueAt + 101, rotationTime: 0, maxCommands: 4, maxRuntimeMs: 100,
    });
    expect(result).toMatchObject({ attempted: 1, acknowledged: 1, exhausted: true });
    expect(profileDispatch).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight send at the deadline without logging its private failure and retries the durable command", async () => {
    const sourceId = "project-alpha:primary";
    await command("profile", "profile-deadline", sourceId);
    let observedSignal: AbortSignal | undefined;
    const controlledFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined;
      observedSignal?.addEventListener("abort", () => reject(new Error("secret-token private@example.test")), { once: true });
    }));
    profileDispatch.mockImplementationOnce(async (_env, _source, _commandId, send: typeof fetch) => {
      try {
        await send("https://directory.example.test/outbox", { method: "POST" });
        return { status: "acknowledged" };
      } catch {
        return { status: "uncertain", reason: "transport" };
      }
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await drainNativeDirectoryOutboxes(environment([sourceId]), {
        now: () => dueAt, rotationTime: 0, maxCommands: 1, maxRuntimeMs: 10, send: controlledFetch as typeof fetch,
      });
      expect(result).toMatchObject({ attempted: 1, uncertain: 1, acknowledged: 0, exhausted: true });
      expect(observedSignal?.aborted).toBe(true);
      expect(await db.prepare("SELECT state FROM project_alpha_directory_outbox WHERE command_id='profile-deadline'").first("state"))
        .toBe("pending");
      await expect(drainNativeDirectoryOutboxes(environment([sourceId]), {
        now: () => dueAt, rotationTime: 0, maxCommands: 1,
      })).resolves.toMatchObject({ attempted: 1, acknowledged: 1 });
      expect(profileDispatch.mock.calls.map(call => call[2])).toEqual(["profile-deadline", "profile-deadline"]);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("retains an outage command for a later retry without logging private failure data", async () => {
    const sourceId = "project-alpha:primary";
    await command("profile", "profile-outage", sourceId);
    profileDispatch.mockRejectedValueOnce(new Error("secret-token private@example.test"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(drainNativeDirectoryOutboxes(environment([sourceId]), { now: () => dueAt, rotationTime: 0 }))
      .resolves.toMatchObject({ attempted: 1, failed: 1, acknowledged: 0 });
    expect(await db.prepare("SELECT state FROM project_alpha_directory_outbox WHERE command_id='profile-outage'").first("state"))
      .toBe("pending");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    profileDispatch.mockResolvedValueOnce({ status: "acknowledged" });
    await expect(drainNativeDirectoryOutboxes(environment([sourceId]), { now: () => dueAt, rotationTime: 0 }))
      .resolves.toMatchObject({ attempted: 1, acknowledged: 1, failed: 0 });
  });
});

it('rotates bounded read-only create observation work ahead of a busy write lane',async()=>{
  const sourceId='project-alpha:primary';await command('profile','queued-write',sourceId);
  await db.batch([
    db.prepare("INSERT INTO native_directory_create_observation_jobs(command_id,source_id,created_at) VALUES('acked-create',?,'2026-01-01T00:00:00Z')").bind(sourceId),
    db.prepare("INSERT INTO native_directory_create_observation_dispatch(command_id,state,next_attempt_at) VALUES('acked-create','pending',0)"),
  ]);
  expect(await drainNativeDirectoryOutboxes(environment([sourceId]),{now:()=>dueAt,rotationTime:300000,maxCommands:1})).toMatchObject({attempted:1,acknowledged:1});
  expect(observationDispatch).toHaveBeenCalledOnce();expect(observationDispatch.mock.calls[0]![1]).toBe(sourceId);
  expect(profileDispatch).not.toHaveBeenCalled();
});

it('admits successive slow but bounded dispatches within the three-minute soft budget',async()=>{
 const sourceId='project-alpha:latency';await command('profile','slow-profile-one',sourceId);await command('profile','slow-profile-two',sourceId);
 let now=dueAt;profileDispatch.mockImplementation(async()=>{now+=70_000;return{status:'acknowledged'};});
 const result=await drainNativeDirectoryOutboxes(environment([sourceId]),{now:()=>now,rotationTime:0});
 expect(result).toMatchObject({status:'drained',attempted:2,acknowledged:2,exhausted:false});expect(profileDispatch).toHaveBeenCalledTimes(2);
});

it('caps an oversized requested budget while allowing only the already-started dispatch to overshoot',async()=>{
 const sourceId='project-alpha:budget-cap';for(let n=1;n<=4;n++)await command('profile',`budget-cap-${n}`,sourceId);
 let now=dueAt;profileDispatch.mockImplementation(async()=>{now+=70_000;return{status:'acknowledged'};});
 const result=await drainNativeDirectoryOutboxes(environment([sourceId]),{now:()=>now,rotationTime:0,maxRuntimeMs:999_999});
 expect(result).toMatchObject({attempted:3,acknowledged:3,exhausted:true});expect(profileDispatch).toHaveBeenCalledTimes(3);
 expect(profileDispatch.mock.calls.map(call=>call[2])).not.toContain('budget-cap-4');expect(now-dueAt).toBe(210_000);
});
