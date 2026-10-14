import { readFileSync, readdirSync } from "node:fs";
import { reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
import { Miniflare } from "miniflare";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { StaffPrincipal } from "../src/worker/types";

const auth = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({
  authenticateNativeStaffWithAdmissionVersion: auth.current,
}));
const policy = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/worker/client-hub-project-policy", () => ({
  readClientHubBusinessProjectPolicy: policy.read,
}));
import {
  prepareClientHubNativeProject,
  readClientHubNativeProjectCapability,
  submitClientHubNativeProject,
} from "../src/worker/client-hub-native-project-management";
import { listClientHubBusinessProjects } from "../src/worker/client-hub-business-projects";
import { canonicalBusinessProjectPredicate } from "../src/worker/client-hub-canonical-projects";
import { nativeProjectLifecycleCanonicalProof } from "../src/worker/native-project-lifecycle-canonical-proof";
import { resolveTrustedNativeFinancialMapping } from "../src/worker/project-alpha-financial-mapping";
import { readConfiguredProjectAlphaProjectInventory } from "../src/worker/project-alpha-project-inventory-api-v2";
import { persistProjectAlphaProjectInventoryPage } from "../src/worker/project-alpha-v2-sync";
import { prepareProjectAlphaProjectV2Acceptance } from "../src/worker/project-alpha-project-v2-preparation";
import {
  planProjectAlphaProjectV2Command,
  type ProjectAlphaProjectV2CommandProducerAction,
} from "../src/worker/project-alpha-project-v2-command-producer";
import { dispatchProjectAlphaProjectV2PendingCommand } from "../src/worker/project-alpha-project-v2-pending-dispatcher";
import { settleProjectAlphaProjectV2Read } from "../src/worker/project-alpha-project-read-settlement-adapter";
import { activateProjectAlphaProjectV2Canonical } from "../src/worker/project-alpha-project-canonical-activation-adapter";

let runtime: Miniflare;
let db: D1Database;
const commandId = "10000000-0000-4000-8000-000000000001";
const externalId = "10000000-0000-4000-8000-000000000002";
const hash = "a".repeat(43);
const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpochId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  orgId = "20000000-0000-4000-8000-000000000001";
const orgPublic = "c".repeat(32),
  projectPublic = "d".repeat(32),
  projection = "e".repeat(64);
const acquiredOrgRecordId = "acquired-organization-record",
  acquiredOrgExternalId = "project-alpha/acquired-organization";
const acquiredOrgPublic = "7".repeat(32),
  acquiredOrgProjection = "3".repeat(64);
const clientId = "20000000-0000-4000-8000-000000000002",
  clientPublic = "a".repeat(32),
  clientProjection = "b".repeat(64);
const staff = {
  id: "staff-native",
  email: "staff-native@example.test",
  accessSubject: "access|staff-native",
  projectAlphaUserId: null,
} as StaffPrincipal;
const context = {
  root: {
    source_id: "project-alpha:primary",
    root_namespace: "business",
    kind: "organization",
    public_id: orgId,
    pa_internal_id: orgId,
    pa_public_id: orgPublic,
    mapping_status: "mapped",
    display_name: "Organization",
    sort_name: "Organization",
    status: "active",
    portal_status: "not_provisioned",
    workspace_id: null,
    legacy_account_id: null,
    account_count: 0,
    project_count: 0,
    request_count: 0,
    contact_count: 0,
    meaningful_activity_at: null,
    source_version: null,
    indexed_at: "",
    scan_generation: 0,
  },
  canonicalRoot: {
    sourceId: "project-alpha:primary",
    rootNamespace: "business",
    kind: "organization",
    publicId: orgId,
  },
  access: { directory: true, requests: true, delivery: true, viewer: true },
  contextVersion: "x".repeat(43),
} as ClientHubCollectionContext;
const standaloneContext = {
  ...context,
  root: {
    ...context.root,
    kind: "standalone_client",
    public_id: clientId,
    pa_internal_id: clientId,
    pa_public_id: clientPublic,
    display_name: "Standalone client",
    sort_name: "Standalone client",
  },
  canonicalRoot: {
    ...context.canonicalRoot,
    kind: "standalone_client",
    publicId: clientId,
  },
  contextVersion: "y".repeat(43),
} as ClientHubCollectionContext;
const acquiredOrganizationContext = {
  ...context,
  root: {
    ...context.root,
    public_id: acquiredOrgRecordId,
    pa_internal_id: acquiredOrgRecordId,
    pa_public_id: acquiredOrgPublic,
    display_name: "Acquired organization",
    sort_name: "Acquired organization",
  },
  canonicalRoot: { ...context.canonicalRoot, publicId: acquiredOrgRecordId },
  contextVersion: "z".repeat(43),
} as ClientHubCollectionContext;
const env = () => ({
  OPS_DB: db,
  PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({
    version: 1,
    instances: {
      "project-alpha:primary": {
        sourceId: "project-alpha:primary",
        enabled: true,
        baseUrl: "https://one.example.test",
        apiKey: "secret",
        sourceInstanceId,
        applicationId,
        historyEpoch: historyEpochId,
      },
    },
  }),
});
function preparationInsertFailureDatabase(error: Error): D1Database {
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: Parameters<D1PreparedStatement["bind"]>) =>
            wrapStatement(target.bind(...values));
        if (property === "run")
          return async () => {
            throw error;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const session = db.withSession("first-primary");
  const wrappedSession = new Proxy(session, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          sql.includes("INSERT INTO client_hub_native_project_preparations(")
            ? wrapStatement(target.prepare(sql))
            : target.prepare(sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === "withSession") return () => wrappedSession;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function revokeAfterGenerationReadDatabase(): D1Database {
  const session = db.withSession("first-primary");
  let revoked = false;
  const wrappedSession = new Proxy(session, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (
          !sql.startsWith(
            "SELECT generation FROM native_project_grant_generations",
          )
        )
          return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            if (statementProperty === "bind")
              return (...values: Parameters<D1PreparedStatement["bind"]>) => {
                const bound = statementTarget.bind(...values);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty) {
                    if (boundProperty === "first")
                      return async (
                        ...args: Parameters<D1PreparedStatement["first"]>
                      ) => {
                        const result = await boundTarget.first(...args);
                        if (!revoked) {
                          revoked = true;
                          await db
                            .prepare(
                              "UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'",
                            )
                            .run();
                        }
                        return result;
                      };
                    const value = Reflect.get(boundTarget, boundProperty);
                    return typeof value === "function"
                      ? value.bind(boundTarget)
                      : value;
                  },
                });
              };
            const value = Reflect.get(statementTarget, statementProperty);
            return typeof value === "function"
              ? value.bind(statementTarget)
              : value;
          },
        });
      };
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === "withSession") return () => wrappedSession;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function activationSchemaDatabase(
  mode: "lookup-error" | "missing-fence",
): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        if (
          mode === "lookup-error" &&
          sql.includes(
            "FROM client_hub_native_project_preparations WHERE command_id",
          )
        )
          throw new Error("synthetic native preparation lookup failure");
        const statement = target.prepare(sql);
        if (
          mode !== "missing-fence" ||
          !sql.includes("SELECT name FROM sqlite_master")
        )
          return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            if (statementProperty === "all")
              return async () =>
                ({
                  success: true,
                  results: [{ name: "client_hub_native_project_preparations" }],
                  meta: {},
                }) as D1Result<{ name: string }>;
            const value = Reflect.get(statementTarget, statementProperty);
            return typeof value === "function"
              ? value.bind(statementTarget)
              : value;
          },
        });
      };
    },
  }) as D1Database;
}
const inventoryReaders = () => ({
  inventory: vi.fn(async () => ({
    status: "observed" as const,
    httpStatus: 200 as const,
    response: {
      apiVersion: "2" as const,
      sourceInstanceId,
      applicationId,
      historyEpoch: historyEpochId,
      requestId: crypto.randomUUID(),
      authorizationGeneration: "7",
      projects: [],
      nextCursor: null,
    },
  })),
  bindingStatus: vi.fn(),
  project: vi.fn(),
});
function projectAlphaTransport(
  external: string,
  name: string,
  failPost = false,
  publicOverride?: string,
  hashOverride?: string,
) {
  let posts = 0;
  const responsePublic =
    publicOverride ??
    (external.startsWith("ops/")
      ? "5".repeat(32)
      : external.startsWith("60000000")
        ? "6".repeat(32)
        : external.startsWith("70000000")
          ? "8".repeat(32)
          : external.startsWith("71000000")
            ? "f".repeat(32)
            : external.startsWith("75000000")
              ? "4".repeat(32)
              : projectPublic);
  const responseProjection =
    hashOverride ??
    (external.startsWith("ops/")
      ? "8".repeat(64)
      : external.startsWith("60000000")
        ? "7".repeat(64)
        : external.startsWith("70000000")
          ? "9".repeat(64)
          : external.startsWith("71000000")
            ? "1".repeat(64)
            : external.startsWith("75000000")
              ? "5".repeat(64)
              : projection);
  const send = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      method =
        input instanceof Request ? input.method : (init?.method ?? "GET");
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Request-ID": "50000000-0000-4000-8000-000000000008",
    };
    if (url.pathname === "/api/v2/capabilities")
      return new Response(
        JSON.stringify({
          apiVersion: "2",
          sourceInstanceId,
          applicationId,
          historyEpoch: historyEpochId,
          requestId: headers["X-Request-ID"],
          grantedCapabilities: [
            "api.capabilities.read",
            "projects.create",
            "projects.v2.read",
          ].map((value) => ({ name: value })),
          implementedEndpoints: [
            {
              method: "GET",
              path: "/api/v2/capabilities",
              requiredCapability: "api.capabilities.read",
            },
            {
              method: "POST",
              path: "/api/v2/projects/commands",
              requiredCapability: "projects.create",
              requiresSourceInstanceId: true,
              requiresApplicationId: true,
              requiresHistoryEpoch: true,
            },
            {
              method: "GET",
              path: "/api/v2/projects/{publicId}",
              requiredCapability: "projects.v2.read",
              requiresSourceInstanceId: true,
              requiresApplicationId: true,
              requiresHistoryEpoch: true,
            },
          ],
        }),
        { headers },
      );
    if (method === "POST") {
      posts++;
      if (failPost) throw new Error("synthetic lost response");
      return new Response(
        JSON.stringify({
          apiVersion: "2",
          sourceInstanceId,
          applicationId,
          historyEpoch: historyEpochId,
          requestId: headers["X-Request-ID"],
          replayed: true,
          result: {
            resource: {
              type: "project",
              id: external,
              publicId: responsePublic,
              revision: "1",
              projectionSha256: responseProjection,
            },
            authorizationGeneration: "8",
            presentation: { portalPublished: false, publicLinkEnabled: false },
          },
        }),
        { status: 201, headers },
      );
    }
    if (url.pathname === `/api/v2/projects/${responsePublic}`)
      return new Response(
        JSON.stringify({
          apiVersion: "2",
          sourceInstanceId,
          applicationId,
          historyEpoch: historyEpochId,
          requestId: headers["X-Request-ID"],
          replayed: false,
          accepted: true,
          resource: {
            type: "project",
            id: responsePublic,
            revision: "1",
            projectionSha256: responseProjection,
          },
          data: {
            name,
            description: null,
            status: "active",
            archived: false,
            overdueWarning: true,
            completedAt: null,
            archivedAt: null,
            estimatedStart: null,
            estimatedEnd: "2026-01-01",
            clientPublicId: null,
            organizationPublicId: orgPublic,
          },
        }),
        { headers },
      );
    throw new Error(`unexpected ${method} ${url.pathname}`);
  });
  return {
    send,
    get posts() {
      return posts;
    },
  };
}
async function createLegacyMappedProject(
  external: string,
  publicOverride?: string,
  hashOverride?: string,
) {
  const commandId = crypto.randomUUID(),
    transport = projectAlphaTransport(
      external,
      "Imported legacy project",
      false,
      publicOverride,
      hashOverride,
    );
  const actor = {
    staffId: staff.id,
    accessSubject: staff.accessSubject,
    email: staff.email,
    admissionVersion: 1,
    profileVersion: 1,
    scopes: [],
  };
  const prepared = await prepareProjectAlphaProjectV2Acceptance(
    env() as never,
    {
      operation: "create",
      sourceId: "project-alpha:primary",
      expectedApplicationId: applicationId,
      externalProjectId: external,
      organizationRecordId: orgId,
      clientRecordId: null,
      actor,
    },
    inventoryReaders() as never,
  );
  if (
    prepared.status !== "prepared" ||
    prepared.preparation.operation !== "create"
  )
    throw new Error(`legacy prepare ${JSON.stringify(prepared)}`);
  const value = prepared.preparation;
  const action: Extract<
    ProjectAlphaProjectV2CommandProducerAction,
    { operation: "create" }
  > = {
    sourceId: value.sourceId,
    actor: { ...actor, verifiedUntil: "2999-01-01T00:00:00.000Z" },
    operation: "create",
    local: value.local,
    directory: value.directory,
    command: {
      commandId,
      externalId: external,
      expectedAuthorizationGeneration: value.expectedAuthorizationGeneration,
      project: {
        name: "Imported legacy project",
        description: null,
        estimatedStart: null,
        estimatedEnd: "2026-01-01",
      },
      organization: value.organization,
      client: value.client,
    },
  };
  const environment = env() as never;
  const planned = await planProjectAlphaProjectV2Command(environment, action);
  if (planned.status !== "queued")
    throw new Error(`legacy plan ${JSON.stringify(planned)}`);
  const dispatched = await dispatchProjectAlphaProjectV2PendingCommand(
    environment,
    "project-alpha:primary",
    commandId,
    transport.send,
  );
  if (dispatched.status !== "acknowledged")
    throw new Error(`legacy dispatch ${JSON.stringify(dispatched)}`);
  const settled = await settleProjectAlphaProjectV2Read(
    { OPS_DB: db },
    dispatched.receiptId,
    {
      baseUrl: "https://one.example.test",
      apiKey: "secret",
      expectedSourceInstanceId: sourceInstanceId,
      expectedApplicationId: applicationId,
      expectedHistoryEpoch: historyEpochId,
    },
    transport.send,
  );
  if (settled.status !== "settled")
    throw new Error(`legacy settlement ${JSON.stringify(settled)}`);
  const activated = await activateProjectAlphaProjectV2Canonical(
    { OPS_DB: db },
    settled.settlementId,
  );
  if (activated.status !== "activated")
    throw new Error(`legacy activation ${JSON.stringify(activated)}`);
}
function standaloneTransport(
  external: string,
  name: string,
  failPost = false,
  publicChar = "0",
) {
  let posts = 0;
  const responsePublic = publicChar.repeat(32),
    responseProjection = "6".repeat(64);
  const send = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method =
        input instanceof Request ? input.method : (init?.method ?? "GET"),
      requestId = crypto.randomUUID();
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Request-ID": requestId,
    };
    if (url.pathname === "/api/v2/capabilities")
      return new Response(
        JSON.stringify({
          apiVersion: "2",
          sourceInstanceId,
          applicationId,
          historyEpoch: historyEpochId,
          requestId,
          grantedCapabilities: [
            "api.capabilities.read",
            "projects.create",
            "projects.v2.read",
          ].map((name) => ({ name })),
          implementedEndpoints: [
            {
              method: "GET",
              path: "/api/v2/capabilities",
              requiredCapability: "api.capabilities.read",
            },
            {
              method: "POST",
              path: "/api/v2/projects/commands",
              requiredCapability: "projects.create",
              requiresSourceInstanceId: true,
              requiresApplicationId: true,
              requiresHistoryEpoch: true,
            },
            {
              method: "GET",
              path: "/api/v2/projects/{publicId}",
              requiredCapability: "projects.v2.read",
              requiresSourceInstanceId: true,
              requiresApplicationId: true,
              requiresHistoryEpoch: true,
            },
          ],
        }),
        { headers },
      );
    if (method === "POST") {
      posts++;
      if (failPost) throw new Error("synthetic standalone lost response");
      return new Response(
        JSON.stringify({
          apiVersion: "2",
          sourceInstanceId,
          applicationId,
          historyEpoch: historyEpochId,
          requestId,
          replayed: posts > 1,
          result: {
            resource: {
              type: "project",
              id: external,
              publicId: responsePublic,
              revision: "1",
              projectionSha256: responseProjection,
            },
            authorizationGeneration: "8",
            presentation: { portalPublished: false, publicLinkEnabled: false },
          },
        }),
        { status: 201, headers },
      );
    }
    if (url.pathname === `/api/v2/projects/${responsePublic}`)
      return new Response(
        JSON.stringify({
          apiVersion: "2",
          sourceInstanceId,
          applicationId,
          historyEpoch: historyEpochId,
          requestId,
          replayed: false,
          accepted: true,
          resource: {
            type: "project",
            id: responsePublic,
            revision: "1",
            projectionSha256: responseProjection,
          },
          data: {
            name,
            description: null,
            status: "active",
            archived: false,
            overdueWarning: true,
            completedAt: null,
            archivedAt: null,
            estimatedStart: null,
            estimatedEnd: "2026-01-01",
            clientPublicId: clientPublic,
            organizationPublicId: null,
          },
        }),
        { headers },
      );
    throw new Error(`unexpected ${method} ${url.pathname}`);
  });
  return {
    send,
    get posts() {
      return posts;
    },
  };
}

async function insert(id = commandId, external = externalId) {
  const generation = await db
    .prepare(
      "SELECT generation FROM native_project_grant_generations WHERE staff_id=?",
    )
    .bind(staff.id)
    .first<number>("generation");
  const frozen = JSON.stringify({
    sourceId: "project-alpha:primary",
    expectedApplicationId: applicationId,
    operation: "create",
    scopes: [],
    local: { expectedLocalVersion: 0, expectedLocalProjectionSha256: null },
    directory: { organizationRecordId: orgId, clientRecordId: null },
    command: {
      commandId: id,
      externalId: external,
      expectedAuthorizationGeneration: String(generation),
      project: {
        name: "Fixture",
        description: null,
        estimatedStart: null,
        estimatedEnd: "2026-01-01",
      },
      organization: {
        externalId: orgId,
        expectedPublicId: orgPublic,
        expectedRevision: "3",
        expectedProjectionSha256: projection,
      },
      client: null,
    },
  });
  return db
    .prepare(
      `INSERT INTO client_hub_native_project_preparations(
    command_id,external_project_id,request_json,request_sha256,context_source_id,context_root_namespace,context_root_kind,
    context_root_public_id,context_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,
    actor_profile_version,authority_generation,source_instance_id,application_id,history_epoch_id)
    VALUES(?,?,?,?,'project-alpha:primary','business','organization',?,'context',?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      external,
      frozen,
      hash,
      orgId,
      staff.id,
      staff.accessSubject,
      staff.email,
      1,
      1,
      generation,
      sourceInstanceId,
      applicationId,
      historyEpochId,
    )
    .run();
}

async function activateAcquiredOrganization() {
  const id = (part: string) => `e${part}000000-0000-4000-8000-000000000001`,
    requestHash = "4".repeat(64);
  const reviewId = id("1"),
    acquisitionCommand = id("2"),
    acquiredReceiptId = id("3"),
    claimId = id("4"),
    activationId = id("9");
  await db.batch([
    db
      .prepare(
        `INSERT INTO project_alpha_existing_directory_binding_review_evidence(
      receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,
      external_id,project_alpha_public_id,project_alpha_revision,review_id,reviewed_binding_evidence_sha256,
      reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewed_at,reviewed_local_record_version)
      VALUES(?,?,?,?,?,?,?,'organization',?,?,'4',?, ?,?,?,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1)`,
      )
      .bind(
        reviewId,
        requestHash,
        acquiredOrgRecordId,
        "project-alpha:primary",
        sourceInstanceId,
        applicationId,
        historyEpochId,
        acquiredOrgExternalId,
        acquiredOrgPublic,
        id("6"),
        "2".repeat(64),
        staff.id,
        staff.accessSubject,
      ),
    db
      .prepare(
        `INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(
      command_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,
      external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id)
      VALUES(?,?,?,?,?,?,?,'organization',?,?,'4',?)`,
      )
      .bind(
        acquisitionCommand,
        requestHash,
        acquiredOrgRecordId,
        "project-alpha:primary",
        sourceInstanceId,
        applicationId,
        historyEpochId,
        acquiredOrgExternalId,
        acquiredOrgPublic,
        reviewId,
      ),
  ]);
  await db.batch(
    (
      [
        [1, "pending", "7"],
        [2, "acknowledged", "8"],
      ] as const
    ).map(([version, state, part]) =>
      db
        .prepare(
          `INSERT INTO project_alpha_existing_directory_binding_acquisition_events(command_id,state_version,transition_id,request_sha256,state,occurred_at)
      VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        )
        .bind(acquisitionCommand, version, id(part), requestHash, state),
    ),
  );
  await db.batch([
    db
      .prepare(
        `INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(
      command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
      project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256,
      expected_authorization_generation,result_authorization_generation)
      VALUES(?,?,?,?,'organization',?,?,'4','https://one.example.test',?,0,?,'6','7')`,
      )
      .bind(
        acquisitionCommand,
        sourceInstanceId,
        applicationId,
        historyEpochId,
        acquiredOrgExternalId,
        acquiredOrgPublic,
        id("a"),
        "5".repeat(64),
      ),
    db
      .prepare(
        `INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(
      receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,acquisition_evidence_sha256,
      profile_evidence_sha256,binding_status_evidence_sha256)
      VALUES(?,?,?,?,?,?,?,?,'organization',?,?,'4',?,?,?)`,
      )
      .bind(
        acquiredReceiptId,
        requestHash,
        acquisitionCommand,
        acquiredOrgRecordId,
        "project-alpha:primary",
        sourceInstanceId,
        applicationId,
        historyEpochId,
        acquiredOrgExternalId,
        acquiredOrgPublic,
        "5".repeat(64),
        "6".repeat(64),
        acquiredOrgProjection,
      ),
  ]);
  await db.batch([
    db
      .prepare(
        `INSERT INTO project_alpha_acquired_canonical_mappings(receipt_id,record_id,source_id,source_instance_id,
      application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
      VALUES(?,?,?,?,?,?,'organization',?,?)`,
      )
      .bind(
        acquiredReceiptId,
        acquiredOrgRecordId,
        "project-alpha:primary",
        sourceInstanceId,
        applicationId,
        historyEpochId,
        acquiredOrgExternalId,
        acquiredOrgPublic,
      ),
    db
      .prepare(
        `INSERT INTO project_alpha_acquired_native_owner_claims(claim_id,receipt_id,native_owner_epoch_id,record_id,
      source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
      expected_local_record_version,actor_id,request_sha256) VALUES(?,?,?,?,?,?,?,?,'organization',?,?,1,?,?)`,
      )
      .bind(
        claimId,
        acquiredReceiptId,
        id("5"),
        acquiredOrgRecordId,
        "project-alpha:primary",
        sourceInstanceId,
        applicationId,
        historyEpochId,
        acquiredOrgExternalId,
        acquiredOrgPublic,
        staff.id,
        requestHash,
      ),
    db
      .prepare(
        "INSERT INTO project_alpha_acquired_mapping_activation(receipt_id) VALUES(?)",
      )
      .bind(acquiredReceiptId),
  ]);
  const generation = await db
    .prepare(
      "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?",
    )
    .bind(staff.id)
    .first<number>("generation");
  await db
    .prepare(
      `INSERT INTO project_alpha_existing_directory_binding_activation_receipts(
    activation_id,review_receipt_id,idempotency_key,acquired_receipt_id,native_owner_claim_id,record_id,source_id,
    source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
    project_alpha_revision,local_record_version,request_sha256,acquisition_evidence_sha256,profile_evidence_sha256,
    binding_status_evidence_sha256,activated_by_staff_id,directory_grant_generation,
    expected_authorization_generation,result_authorization_generation)
    VALUES(?,?,?,?,?,?,'project-alpha:primary',?,?,?,'organization',?,?,'4',1,?,?,?,?,?,?,'6','7')`,
    )
    .bind(
      activationId,
      reviewId,
      activationId,
      acquiredReceiptId,
      claimId,
      acquiredOrgRecordId,
      sourceInstanceId,
      applicationId,
      historyEpochId,
      acquiredOrgExternalId,
      acquiredOrgPublic,
      requestHash,
      "5".repeat(64),
      "6".repeat(64),
      acquiredOrgProjection,
      staff.id,
      generation,
    )
    .run();
}

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: ["OPS_DB"],
  });
  db = (await runtime.getD1Database("OPS_DB")) as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  // Validate every reviewed source byte, then apply the full physical 0204 chain.
  // The helper deliberately returns the historical 0199 release prefix only.
  reviewedOperationsMigrationNames(directory);
  const names = readdirSync(directory)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n))
    .sort();
  expect(names).toHaveLength(204);
  expect(names.at(-1)).toBe("0204_native_project_archive_restore.sql");
  for (const name of names) {
    const migration = readFileSync(new URL(name, directory), "utf8");
    const statements = splitD1MigrationStatements(migration);
    if (name === "0081_operations_directory_relationships.sql") {
      for (const sql of statements) {
        if (
          sql.startsWith(
            "CREATE TRIGGER operations_directory_client_organizations_insert_guard",
          )
        )
          await db
            .prepare(
              "INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version) VALUES(?,NULL,1)",
            )
            .bind(clientId)
            .run();
        await db.prepare(sql).run();
      }
    } else await db.batch(statements.map((sql) => db.prepare(sql)));
    if (name === "0033_projection_sources.sql")
      await db.batch([
        db
          .prepare(
            `INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
        VALUES('project-alpha:primary','organization',?,?)`,
          )
          .bind(orgId, orgId),
        db
          .prepare(
            `INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id)
        VALUES(?,'Organization',1,?,'sync','project-alpha:primary')`,
          )
          .bind(orgId, JSON.stringify({ public_id: orgPublic })),
      ]);
    if (name === "0055_operations_directory_authority.sql")
      await db.batch([
        db
          .prepare(
            `INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)`,
          )
          .bind(orgId),
        db
          .prepare(
            `INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json)
        VALUES(?,1,'fixture-org-revision',?)`,
          )
          .bind(orgId, JSON.stringify({ name: "Organization" })),
        db
          .prepare(
            `INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)`,
          )
          .bind(clientId),
        db
          .prepare(
            `INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json)
        VALUES(?,1,'fixture-client-revision',?)`,
          )
          .bind(clientId, JSON.stringify({ name: "Standalone client" })),
        db
          .prepare(
            `INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)`,
          )
          .bind(acquiredOrgRecordId),
        db
          .prepare(
            `INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json)
        VALUES(?,1,'fixture-acquired-org-revision',?)`,
          )
          .bind(
            acquiredOrgRecordId,
            JSON.stringify({ name: "Acquired organization" }),
          ),
      ]);
    if (name === "0059_native_staff_profiles.sql")
      await db.batch([
        db
          .prepare(
            `INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')`,
          )
          .bind(staff.id, staff.email, "Native Staff", staff.accessSubject),
        db
          .prepare(
            `INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)`,
          )
          .bind(staff.id, staff.accessSubject, staff.id),
        db
          .prepare(
            `INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version) VALUES(?,?,?,1)`,
          )
          .bind(staff.id, staff.email, "Native Staff"),
      ]);
    if (name === "0065_project_alpha_directory_history_epoch.sql")
      await db.batch([
        db
          .prepare(
            `INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,
        destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,lease_token,lease_expires_at,expected_history_epoch_id)
        VALUES('map-org','project-alpha:primary',?,'organization',?,'{}','https://one.example.test',?,'{}','leased',1,0,'fixture',4102444800,?)`,
          )
          .bind(applicationId, orgId, sourceInstanceId, historyEpochId),
        db
          .prepare(
            `INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,command_id,history_epoch_id)
        VALUES('project-alpha:primary','organization',?,?,?,?,?,?)`,
          )
          .bind(
            orgId,
            orgPublic,
            sourceInstanceId,
            applicationId,
            "map-org",
            historyEpochId,
          ),
        db
          .prepare(
            `INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,
        destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,lease_token,lease_expires_at,expected_history_epoch_id)
        VALUES('map-client','project-alpha:primary',?,'client',?,'{}','https://one.example.test',?,'{}','leased',1,0,'fixture-client',4102444800,?)`,
          )
          .bind(applicationId, clientId, sourceInstanceId, historyEpochId),
        db
          .prepare(
            `INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,command_id,history_epoch_id)
        VALUES('project-alpha:primary','client',?,?,?,?,?,?)`,
          )
          .bind(
            clientId,
            clientPublic,
            sourceInstanceId,
            applicationId,
            "map-client",
            historyEpochId,
          ),
      ]);
  }
  await db.batch([
    db
      .prepare(
        "INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES('fixture-acquired-owner',?,'role-owner','global','global',?)",
      )
      .bind(staff.id, staff.id),
    db
      .prepare(
        `INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES('fixture-acquired-identity-link',?,'directory.identity.link','allow','global',1,?)`,
      )
      .bind(staff.id, staff.id),
  ]);
  await activateAcquiredOrganization();
  await db.batch([
    db
      .prepare(
        `INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by)
      VALUES('grant-native',?,'project.shared.sync','allow','global',1,1,?)`,
      )
      .bind(staff.id, staff.id),
    db
      .prepare(
        `INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count)
      VALUES('project-alpha:primary',?,?,?,'directory','30000000-0000-4000-8000-000000000001','7',?,1)`,
      )
      .bind(sourceInstanceId, applicationId, historyEpochId, "f".repeat(64)),
    db
      .prepare(
        `INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision)
      VALUES('project-alpha:primary',?,?,?,'30000000-0000-4000-8000-000000000001','organization',?,'3',1,'upsert',?,?,'active','3')`,
      )
      .bind(
        sourceInstanceId,
        applicationId,
        historyEpochId,
        orgPublic,
        projection,
        orgId,
      ),
    db
      .prepare(
        `INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision)
      VALUES('project-alpha:primary',?,?,?,'30000000-0000-4000-8000-000000000001','client',?,'2',1,'upsert',?,?,'active','2')`,
      )
      .bind(
        sourceInstanceId,
        applicationId,
        historyEpochId,
        clientPublic,
        clientProjection,
        clientId,
      ),
    db
      .prepare(
        `INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision)
      VALUES('project-alpha:primary',?,?,?,'30000000-0000-4000-8000-000000000001','organization',?,'4',1,'upsert',?,?,'active','4')`,
      )
      .bind(
        sourceInstanceId,
        applicationId,
        historyEpochId,
        acquiredOrgPublic,
        acquiredOrgProjection,
        acquiredOrgExternalId,
      ),
  ]);
  auth.current.mockResolvedValue({
    identity: {
      staffId: staff.id,
      email: staff.email,
      verifiedAccessSubject: staff.accessSubject,
      profileVersion: 1,
    },
    admissionVersion: 1,
    verifiedUntil: "2999-01-01T00:00:00.000Z",
  });
  policy.read.mockResolvedValue({
    allowed: true,
    filter: { sql: "1=1", values: [] },
    canViewUnprojectedCanonical: true,
    proof: "p".repeat(43),
  });
}, 180_000);
afterAll(async () => runtime.dispose());

import {
  retireNativeProjectLifecycleForInboundReview,
  prepareNativeProjectLifecycle,
  abandonNativeProjectLifecyclePreparation,
  submitNativeProjectLifecycle,
  prepareNativeProjectLifecycleRefresh,
  submitNativeProjectLifecycleRefresh,
  activateNativeProjectLifecycle,
} from "../src/worker/native-project-lifecycle";
import {
  proposeProjectAlphaInboundProjectEdit,
  resolveProjectAlphaInboundProjectEdit,
} from "../src/worker/project-alpha-project-inbound-reconciliation";
const lifecycleActor = {
  staffId: staff.id,
  accessSubject: staff.accessSubject,
  email: staff.email,
  admissionVersion: 1,
  profileVersion: 1,
  verifiedUntil: "2999-01-01T00:00:00.000Z",
};
const lifecycleOwner = {
  sourceId: "project-alpha:primary",
  rootKind: "organization" as const,
  rootPublicId: orgId,
  contextVersion: "native-context",
};
let lifecycleExternal = "ops/lifecycle-acceptance-204";
let lifecycleSequence = 0;
let lifecycleLive: ReturnType<typeof lifecycleTransport>;
function lifecycleTransport(
  external = lifecycleExternal,
  publicId = "5".repeat(32),
  initialHash = "8".repeat(64),
) {
  let revision = 1,
    bindingRevision = 1,
    authorizationGeneration = 100 + lifecycleSequence * 10,
    archived = false,
    posts = 0;
  const receipts = new Map<string, unknown>();
  let liveName = "Imported legacy project";
  let failLifecycle = false,
    failRefresh = false,
    capHook: (() => Promise<void>) | null = null,
    capFailure: "503" | "denied" | null = null;
  const hash = () =>
    revision === 1 ? initialHash : revision.toString(16).repeat(64);
  const send = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      method =
        input instanceof Request ? input.method : (init?.method ?? "GET"),
      requestId = crypto.randomUUID(),
      headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Request-ID": requestId,
      };
    const identity = {
      apiVersion: "2",
      sourceInstanceId,
      applicationId,
      historyEpoch: historyEpochId,
      requestId,
    };
    const response = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });
    if (url.pathname === "/api/v2/capabilities") {
      if (capFailure) {
        const kind = capFailure;
        capFailure = null;
        if (kind === "503") return response({ error: "unavailable" }, 503);
        return response({
          ...identity,
          grantedCapabilities: [],
          implementedEndpoints: [
            {
              method: "GET",
              path: "/api/v2/capabilities",
              requiredCapability: "api.capabilities.read",
            },
          ],
        });
      }
      if (capHook) {
        const hook = capHook;
        capHook = null;
        await hook();
      }
      const endpoints = [
        ["GET", "/api/v2/capabilities", "api.capabilities.read"],
        ["GET", "/api/v2/projects/inventory", "projects.inventory.read"],
        ["GET", "/api/v2/projects/{publicId}", "projects.v2.read"],
        [
          "GET",
          "/api/v2/projects/bindings/status/{base64urlExternalId}",
          "projects.binding_status.read",
        ],
        [
          "POST",
          "/api/v2/projects/{publicId}/archive/commands",
          "projects.lifecycle.archive",
        ],
        [
          "POST",
          "/api/v2/projects/{publicId}/restore/commands",
          "projects.lifecycle.restore",
        ],
        [
          "POST",
          "/api/v2/projects/bindings/revisions/commands",
          "projects.binding.revision.refresh",
        ],
      ];
      return response({
        ...identity,
        grantedCapabilities: [...new Set(endpoints.map((x) => x[2]))].map(
          (name) => ({ name }),
        ),
        implementedEndpoints: endpoints.map(
          ([method, path, requiredCapability]) => ({
            method,
            path,
            requiredCapability,
            requiresSourceInstanceId: true,
            requiresApplicationId: true,
            requiresHistoryEpoch: true,
          }),
        ),
      });
    }
    if (url.pathname === "/api/v2/projects/inventory")
      return response({
        ...identity,
        authorizationGeneration: String(authorizationGeneration),
        projects: [
          {
            externalId: external,
            publicId,
            revision: String(revision),
            projectionSha256: hash(),
            status: "active",
            archived,
          },
        ],
        nextCursor: null,
      });
    if (method === "POST") {
      posts++;
      const body = JSON.parse(String(init?.body));
      const key = url.pathname + body.commandId;
      if (receipts.has(key))
        return response({
          ...(receipts.get(key) as object),
          requestId,
          replayed: true,
        });
      if (url.pathname.includes("/bindings/revisions/")) {
        expect(body.expectedRevision).toBe(String(revision));
        expect(body.expectedPriorRevision).toBe(String(bindingRevision));
        bindingRevision = revision;
        authorizationGeneration++;
        const data = {
          ...identity,
          replayed: false,
          result: {
            resource: {
              type: "project",
              id: external,
              publicId: publicId,
              revision: String(revision),
              projectionSha256: hash(),
            },
            authorizationGeneration: String(authorizationGeneration),
            presentation: { portalPublished: false, publicLinkEnabled: false },
          },
        };
        receipts.set(key, data);
        if (failRefresh) {
          failRefresh = false;
          throw new Error("fixture refresh response lost after apply");
        }
        return response(data);
      }
      expect(body.expectedRevision).toBe(String(revision));
      archived = url.pathname.includes("/archive/");
      revision++;
      const data = {
        ...identity,
        replayed: false,
        accepted: true,
        resource: { type: "project", id: publicId, revision: String(revision) },
        result: {
          status: "active",
          completedAt: null,
          archived,
          archivedAt: archived ? "2026-10-14T00:00:00Z" : null,
          presentation: { portalPublished: false, publicLinkEnabled: false },
        },
      };
      receipts.set(key, data);
      if (failLifecycle) {
        failLifecycle = false;
        throw new Error("fixture lifecycle response lost after apply");
      }
      return response(data);
    }
    if (url.pathname.startsWith("/api/v2/projects/bindings/status/")) {
      if (bindingRevision !== revision)
        return response(
          {
            ...identity,
            error: { code: "binding_stale" },
            authorizationGeneration: String(authorizationGeneration),
            binding: {
              externalId: external,
              publicId: publicId,
              revision: String(bindingRevision),
            },
            resource: { revision: String(revision), projectionSha256: hash() },
          },
          409,
        );
      return response({
        ...identity,
        authorizationGeneration: String(authorizationGeneration),
        binding: {
          externalId: external,
          publicId: publicId,
          createdAt: "2026-10-14T00:00:00Z",
          updatedAt: "2026-10-14T00:00:00Z",
        },
        resource: {
          revision: String(revision),
          projectionSha256: hash(),
          status: "active",
          archived,
        },
      });
    }
    if (url.pathname === "/api/v2/projects/" + publicId)
      return response({
        ...identity,
        replayed: false,
        accepted: true,
        resource: {
          type: "project",
          id: publicId,
          revision: String(revision),
          projectionSha256: hash(),
        },
        data: {
          name: liveName,
          description: null,
          status: "active",
          archived,
          overdueWarning: !archived,
          completedAt: null,
          archivedAt: archived ? "2026-10-14T00:00:00Z" : null,
          estimatedStart: null,
          estimatedEnd: "2026-01-01",
          clientPublicId: null,
          organizationPublicId: orgPublic,
        },
      });
    throw new Error("unexpected lifecycle fixture request");
  });
  return {
    send,
    get posts() {
      return posts;
    },
    externalEdit() {
      revision++;
      liveName = "External PA profile edit";
    },
    setNameForContractTest(name: string) {
      liveName = name;
    },
    failCapabilities(kind: "503" | "denied") {
      capFailure = kind;
    },
    loseLifecycleResponse() {
      failLifecycle = true;
    },
    loseRefreshResponse() {
      failRefresh = true;
    },
    onNextCapabilities(hook: () => Promise<void>) {
      capHook = hook;
    },
  };
}
describe("native archive/restore lifecycle on complete D1 schema", () => {
  beforeEach(async () => {
    const digit = (++lifecycleSequence).toString(16),
      publicId = digit.repeat(32),
      hash = digit.repeat(64);
    lifecycleExternal = "ops/lifecycle-" + digit;
    await createLegacyMappedProject(lifecycleExternal, publicId, hash);
    lifecycleLive = lifecycleTransport(lifecycleExternal, publicId, hash);
  }, 120000);
  it("installs additive204 without changing old operation CHECKs", async () => {
    expect(
      await db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='project_alpha_project_outbox'",
        )
        .first<string>("sql"),
    ).toContain("'create','update','bind'");
    expect(
      await db
        .prepare("SELECT count(*) n FROM native_project_lifecycle_commands")
        .first("n"),
    ).toBe(0);
  });
  it("archives/restores through an explicit reviewed refresh child before activation", async () => {
    const transport = lifecycleLive;
    for (const [action, suffix, version] of [
      ["archive", "a", 2],
      ["restore", "b", 3],
    ] as const) {
      const cid = `a0000000-0000-4000-8000-00000000000${suffix}`,
        rid = `b0000000-0000-4000-8000-00000000000${suffix}`;
      const prepared = await prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        { commandId: cid, externalProjectId: lifecycleExternal, action },
        transport.send,
      );
      expect(prepared.state).toBe("prepared");
      await expect(
        submitNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          { commandId: cid, reviewSha256: "0".repeat(64), reconcile: false },
          transport.send,
        ),
      ).rejects.toThrow();
      expect(transport.posts).toBe((version - 2) * 2);
      const ack = await submitNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          reviewSha256: prepared.reviewSha256,
          reconcile: false,
        },
        transport.send,
      );
      expect(
        ack.state,
        JSON.stringify(
          (
            await db
              .prepare(
                "SELECT phase,safe_code FROM native_project_lifecycle_events WHERE command_id=?",
              )
              .bind(cid)
              .all()
          ).results,
        ),
      ).toBe("acknowledged");
      await expect(
        activateNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          { commandId: cid, reviewSha256: prepared.reviewSha256 },
          transport.send,
        ),
      ).rejects.toThrow();
      expect(
        await db
          .prepare(
            "SELECT current_version FROM operations_shared_projects WHERE external_project_id=?",
          )
          .bind(lifecycleExternal)
          .first("current_version"),
      ).toBe(version - 1);
      const refresh = await prepareNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          refreshCommandId: rid,
          reviewSha256: prepared.reviewSha256,
        },
        transport.send,
      );
      expect(transport.posts).toBe((version - 2) * 2 + 1);
      expect(
        await submitNativeProjectLifecycleRefresh(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          {
            commandId: cid,
            refreshCommandId: rid,
            reviewSha256: refresh.reviewSha256,
            reconcile: false,
          },
          transport.send,
        ),
      ).toMatchObject({ state: "acknowledged", canonicalActivated: false });
      // Real inventory persistence before canonical activation must not manufacture an external conflict.
      const inventory = await readConfiguredProjectAlphaProjectInventory(
        env() as never,
        lifecycleOwner.sourceId,
        { limit: 1 },
        transport.send,
      );
      expect(inventory.status).toBe("observed");
      if (inventory.status !== "observed")
        throw new Error("inventory read failed");
      expect(
        await persistProjectAlphaProjectInventoryPage(
          db,
          lifecycleOwner.sourceId,
          inventory.response,
          null,
        ),
      ).toMatchObject({ status: "persisted", conflictCount: 0 });
      expect(
        await activateNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          { commandId: cid, reviewSha256: prepared.reviewSha256 },
          transport.send,
        ),
      ).toMatchObject({ state: "activated", canonicalActivated: true });
      expect(
        await activateNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          { commandId: cid, reviewSha256: prepared.reviewSha256 },
          transport.send,
        ),
      ).toMatchObject({ state: "activated" });
      expect(
        await db
          .prepare(
            "SELECT current_version,archived,overdue_warning,organization_record_id,client_record_id FROM operations_shared_projects WHERE external_project_id=?",
          )
          .bind(lifecycleExternal)
          .first(),
      ).toEqual({
        current_version: version,
        archived: action === "archive" ? 1 : 0,
        overdue_warning: action === "archive" ? 0 : 1,
        organization_record_id: orgId,
        client_record_id: null,
      });
    }
    const lineage = await nativeProjectLifecycleCanonicalProof(db, "s");
    expect(lineage).not.toBeNull();
    expect(
      await db
        .prepare(
          `SELECT count(*) n FROM operations_shared_projects s WHERE s.external_project_id=? AND ${lineage}`,
        )
        .bind(lifecycleExternal)
        .first("n"),
    ).toBe(1);
    const display = await canonicalBusinessProjectPredicate(
      env() as never,
      context,
      {
        allowed: true,
        filter: { sql: "1=1", values: [] },
        canViewUnprojectedCanonical: true,
        proof: "p".repeat(43),
      } as never,
    );
    expect(display).not.toBeNull();
    expect(
      await db
        .prepare(
          `SELECT count(*) n FROM operations_shared_projects s WHERE s.external_project_id=? AND ${display!.sql}`,
        )
        .bind(lifecycleExternal, ...display!.values)
        .first("n"),
    ).toBe(1);
    expect(
      await resolveTrustedNativeFinancialMapping(env() as never, {
        kind: "project",
        externalProjectId: lifecycleExternal,
        sourceId: lifecycleOwner.sourceId,
      }),
    ).toMatchObject({ projectionSha256: "3".repeat(64), revision: "3" });
    expect(transport.posts).toBe(4);
    expect(
      await db
        .prepare("SELECT count(*) n FROM native_project_lifecycle_activations")
        .first("n"),
    ).toBe(2);
  }, 120000);
  it("requires current native authority before privileged reads and status", async () => {
    await db
      .prepare(
        "UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'",
      )
      .run();
    const reads = lifecycleLive.send.mock.calls.length;
    try {
      await expect(
        prepareNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          {
            commandId: crypto.randomUUID(),
            externalProjectId: lifecycleExternal,
            action: "archive",
          },
          lifecycleLive.send,
        ),
      ).rejects.toThrow(/authority/);
      expect(lifecycleLive.send.mock.calls).toHaveLength(reads);
      const prior = await db
        .prepare(
          "SELECT command_id FROM native_project_lifecycle_commands LIMIT 1",
        )
        .first<string>("command_id");
      const { readNativeProjectLifecycleStatus } = await import(
        "../src/worker/native-project-lifecycle"
      );
      await expect(
        readNativeProjectLifecycleStatus(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          prior!,
        ),
      ).rejects.toThrow(/authority/);
    } finally {
      await db
        .prepare(
          "UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'",
        )
        .run();
    }
  });
  it("releases only reviewed never-transmitted preparations while preserving history", async () => {
    const cid = crypto.randomUUID(),
      intent = {
        commandId: cid,
        externalProjectId: lifecycleExternal,
        action: "archive" as const,
      };
    const prepared = await prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        intent,
        lifecycleLive.send,
      ),
      posts = lifecycleLive.posts;
    await expect(
      prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        { ...intent, action: "restore" },
        lifecycleLive.send,
      ),
    ).rejects.toThrow(/conflict/);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 360000);
    try {
      await expect(
        submitNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          {
            commandId: cid,
            reviewSha256: prepared.reviewSha256,
            reconcile: false,
          },
          lifecycleLive.send,
        ),
      ).rejects.toThrow();
    } finally {
      clock.mockRestore();
    }
    expect(
      await abandonNativeProjectLifecyclePreparation(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        { commandId: cid, reviewSha256: prepared.reviewSha256 },
      ),
    ).toMatchObject({ noPaRequest: true });
    expect(lifecycleLive.posts).toBe(posts);
    expect(
      await db
        .prepare(
          "SELECT state,transmission_count FROM native_project_lifecycle_commands WHERE command_id=?",
        )
        .bind(cid)
        .first(),
    ).toEqual({ state: "rejected", transmission_count: 0 });
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM native_project_lifecycle_events WHERE command_id=? AND phase='never-transmitted-preparation-abandoned'",
        )
        .bind(cid)
        .first("n"),
    ).toBe(1);
  });
  it("denies actual POST when grant generation changes during capability preflight", async () => {
    let cid = crypto.randomUUID(),
      prepared = await prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          externalProjectId: lifecycleExternal,
          action: "archive",
        },
        lifecycleLive.send,
      ),
      posts = lifecycleLive.posts;
    lifecycleLive.onNextCapabilities(async () => {
      await db
        .prepare(
          "UPDATE native_project_grants SET active=0,version=version+1 WHERE id='grant-native'",
        )
        .run();
    });
    try {
      expect(
        await submitNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          {
            commandId: cid,
            reviewSha256: prepared.reviewSha256,
            reconcile: false,
          },
          lifecycleLive.send,
        ),
      ).toMatchObject({ state: "prepared" });
      expect(lifecycleLive.posts).toBe(posts);
      await expect(
        abandonNativeProjectLifecyclePreparation(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          { commandId: cid, reviewSha256: prepared.reviewSha256 },
        ),
      ).rejects.toThrow();
    } finally {
      await db
        .prepare(
          "UPDATE native_project_grants SET active=1,version=version+1 WHERE id='grant-native'",
        )
        .run();
    }
    // The revoked original generation cannot authorize a fresh send, despite a later replacement allow.
    await expect(
      submitNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          reviewSha256: prepared.reviewSha256,
          reconcile: false,
        },
        lifecycleLive.send,
      ),
    ).rejects.toThrow();
    expect(lifecycleLive.posts).toBe(posts);
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM native_project_lifecycle_post_attempts WHERE parent_command_id=?",
        )
        .bind(cid)
        .first("n"),
    ).toBe(0);
    await abandonNativeProjectLifecyclePreparation(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      { commandId: cid, reviewSha256: prepared.reviewSha256 },
    );
    cid = crypto.randomUUID();
    prepared = await prepareNativeProjectLifecycle(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      {
        commandId: cid,
        externalProjectId: lifecycleExternal,
        action: "archive",
      },
      lifecycleLive.send,
    );
    expect(
      await submitNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          reviewSha256: prepared.reviewSha256,
          reconcile: false,
        },
        lifecycleLive.send,
      ),
    ).toMatchObject({ state: "acknowledged" });
    const rid = crypto.randomUUID(),
      r = await prepareNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          refreshCommandId: rid,
          reviewSha256: prepared.reviewSha256,
        },
        lifecycleLive.send,
      );
    await submitNativeProjectLifecycleRefresh(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      {
        commandId: cid,
        refreshCommandId: rid,
        reviewSha256: r.reviewSha256,
        reconcile: false,
      },
      lifecycleLive.send,
    );
    await activateNativeProjectLifecycle(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      { commandId: cid, reviewSha256: prepared.reviewSha256 },
      lifecycleLive.send,
    );
  }, 120000);
  it("persists unknown lifecycle and refresh outcomes and reconciles only exact original IDs", async () => {
    const archiveId = crypto.randomUUID(),
      archive = await prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: archiveId,
          externalProjectId: lifecycleExternal,
          action: "archive",
        },
        lifecycleLive.send,
      );
    await submitNativeProjectLifecycle(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      {
        commandId: archiveId,
        reviewSha256: archive.reviewSha256,
        reconcile: false,
      },
      lifecycleLive.send,
    );
    const archiveRefreshId = crypto.randomUUID(),
      archiveRefresh = await prepareNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: archiveId,
          refreshCommandId: archiveRefreshId,
          reviewSha256: archive.reviewSha256,
        },
        lifecycleLive.send,
      );
    await submitNativeProjectLifecycleRefresh(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      {
        commandId: archiveId,
        refreshCommandId: archiveRefreshId,
        reviewSha256: archiveRefresh.reviewSha256,
        reconcile: false,
      },
      lifecycleLive.send,
    );
    await activateNativeProjectLifecycle(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      { commandId: archiveId, reviewSha256: archive.reviewSha256 },
      lifecycleLive.send,
    );
    const cid = crypto.randomUUID(),
      prepared = await prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          externalProjectId: lifecycleExternal,
          action: "restore",
        },
        lifecycleLive.send,
      ),
      posts = lifecycleLive.posts;
    lifecycleLive.loseLifecycleResponse();
    expect(
      await submitNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          reviewSha256: prepared.reviewSha256,
          reconcile: false,
        },
        lifecycleLive.send,
      ),
    ).toMatchObject({ state: "uncertain" });
    expect(lifecycleLive.posts).toBe(posts + 1);
    await expect(
      submitNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          reviewSha256: prepared.reviewSha256,
          reconcile: false,
        },
        lifecycleLive.send,
      ),
    ).rejects.toThrow();
    expect(lifecycleLive.posts).toBe(posts + 1);
    expect(
      await submitNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          reviewSha256: prepared.reviewSha256,
          reconcile: true,
        },
        lifecycleLive.send,
      ),
    ).toMatchObject({ state: "acknowledged" });
    const abandonedId = crypto.randomUUID(),
      abandoned = await prepareNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          refreshCommandId: abandonedId,
          reviewSha256: prepared.reviewSha256,
        },
        lifecycleLive.send,
      );
    await abandonNativeProjectLifecyclePreparation(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      {
        commandId: cid,
        refreshCommandId: abandonedId,
        reviewSha256: abandoned.reviewSha256,
      },
    );
    const rid = crypto.randomUUID(),
      r = await prepareNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          refreshCommandId: rid,
          reviewSha256: prepared.reviewSha256,
        },
        lifecycleLive.send,
      );
    lifecycleLive.loseRefreshResponse();
    expect(
      await submitNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          refreshCommandId: rid,
          reviewSha256: r.reviewSha256,
          reconcile: false,
        },
        lifecycleLive.send,
      ),
    ).toMatchObject({ state: "uncertain", canonicalActivated: false });
    await expect(
      prepareNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          refreshCommandId: crypto.randomUUID(),
          reviewSha256: prepared.reviewSha256,
        },
        lifecycleLive.send,
      ),
    ).rejects.toThrow();
    await expect(
      activateNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        { commandId: cid, reviewSha256: prepared.reviewSha256 },
        lifecycleLive.send,
      ),
    ).rejects.toThrow();
    expect(
      await submitNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          refreshCommandId: rid,
          reviewSha256: r.reviewSha256,
          reconcile: true,
        },
        lifecycleLive.send,
      ),
    ).toMatchObject({ state: "acknowledged" });
    expect(
      await activateNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        { commandId: cid, reviewSha256: prepared.reviewSha256 },
        lifecycleLive.send,
      ),
    ).toMatchObject({ canonicalActivated: true });
    expect(
      await db
        .prepare(
          "SELECT state FROM native_project_lifecycle_refreshes WHERE command_id=?",
        )
        .bind(abandonedId)
        .first("state"),
    ).toBe("rejected");
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM native_project_lifecycle_receipts WHERE command_id=?",
        )
        .bind(cid)
        .first("n"),
    ).toBe(1);
  }, 120000);

  it.each(["503", "denied"] as const)(
    "releases known unsent capability failure %s without ambiguous recovery",
    async (kind) => {
      const cid = crypto.randomUUID(),
        prepared = await prepareNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          {
            commandId: cid,
            externalProjectId: lifecycleExternal,
            action: "archive",
          },
          lifecycleLive.send,
        ),
        posts = lifecycleLive.posts;
      lifecycleLive.failCapabilities(kind);
      expect(
        await submitNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          {
            commandId: cid,
            reviewSha256: prepared.reviewSha256,
            reconcile: false,
          },
          lifecycleLive.send,
        ),
      ).toMatchObject({ state: "prepared", dispatchClaimCount: 1 });
      expect(lifecycleLive.posts).toBe(posts);
      expect(
        await db
          .prepare(
            "SELECT count(*) n FROM native_project_lifecycle_post_attempts WHERE parent_command_id=?",
          )
          .bind(cid)
          .first("n"),
      ).toBe(0);
      expect(
        await abandonNativeProjectLifecyclePreparation(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          { commandId: cid, reviewSha256: prepared.reviewSha256 },
        ),
      ).toMatchObject({ noPaRequest: true });
    },
  );
  it("hands known acceptance and newer external drift to explicit inbound review while keeping writers fenced", async () => {
    const cid = crypto.randomUUID(),
      prepared = await prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          externalProjectId: lifecycleExternal,
          action: "archive",
        },
        lifecycleLive.send,
      );
    await submitNativeProjectLifecycle(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      { commandId: cid, reviewSha256: prepared.reviewSha256, reconcile: false },
      lifecycleLive.send,
    );
    await expect(
      retireNativeProjectLifecycleForInboundReview(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        { commandId: cid, reviewSha256: prepared.reviewSha256 },
        lifecycleLive.send,
      ),
    ).rejects.toThrow(/strictly newer/);
    lifecycleLive.externalEdit();
    await expect(
      prepareNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          refreshCommandId: crypto.randomUUID(),
          reviewSha256: prepared.reviewSha256,
        },
        lifecycleLive.send,
      ),
    ).rejects.toThrow(/stale lifecycle/);
    const posts = lifecycleLive.posts;
    expect(
      await retireNativeProjectLifecycleForInboundReview(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        { commandId: cid, reviewSha256: prepared.reviewSha256 },
        lifecycleLive.send,
      ),
    ).toMatchObject({ state: "inbound_review", canonicalActivated: false });
    expect(lifecycleLive.posts).toBe(posts);
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM native_project_lifecycle_pending_handoffs WHERE command_id=?",
        )
        .bind(cid)
        .first("n"),
    ).toBe(1);
    await expect(
      prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: crypto.randomUUID(),
          externalProjectId: lifecycleExternal,
          action: "archive",
        },
        lifecycleLive.send,
      ),
    ).rejects.toThrow();
    const inventory = await readConfiguredProjectAlphaProjectInventory(
      env() as never,
      lifecycleOwner.sourceId,
      { limit: 1 },
      lifecycleLive.send,
    );
    if (inventory.status !== "observed") throw new Error("inventory failed");
    expect(
      await persistProjectAlphaProjectInventoryPage(
        db,
        lifecycleOwner.sourceId,
        inventory.response,
        null,
      ),
    ).toMatchObject({ status: "persisted", conflictCount: 0 });
    const actor = { staffId: staff.id, accessSubject: staff.accessSubject! };
    const proposal = await proposeProjectAlphaInboundProjectEdit(
      env() as never,
      actor,
      {
        idempotencyKey: crypto.randomUUID(),
        sourceId: lifecycleOwner.sourceId,
        externalProjectId: lifecycleExternal,
      },
      lifecycleLive.send,
    );
    expect(proposal.status).toBe("proposed");
    if (proposal.status !== "proposed")
      throw new Error(JSON.stringify(proposal));
    lifecycleLive.setNameForContractTest(
      "Changed after review without revision advance",
    );
    expect(
      await resolveProjectAlphaInboundProjectEdit(
        env() as never,
        actor,
        {
          idempotencyKey: crypto.randomUUID(),
          proposalId: proposal.proposalId,
          decision: "accept_project_alpha",
        },
        lifecycleLive.send,
      ),
    ).toEqual({ status: "blocked", reason: "stale_evidence" });
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM native_project_lifecycle_pending_handoffs WHERE command_id=?",
        )
        .bind(cid)
        .first("n"),
    ).toBe(1);
    await expect(
      db
        .prepare(
          "UPDATE operations_shared_projects SET current_version=current_version+1 WHERE external_project_id=?",
        )
        .bind(lifecycleExternal)
        .run(),
    ).rejects.toThrow();
    lifecycleLive.setNameForContractTest("External PA profile edit");
    expect(
      await resolveProjectAlphaInboundProjectEdit(
        env() as never,
        actor,
        {
          idempotencyKey: crypto.randomUUID(),
          proposalId: proposal.proposalId,
          decision: "accept_project_alpha",
        },
        lifecycleLive.send,
      ),
    ).toMatchObject({ status: "resolved", resultingVersion: 2 });
    const evidence = await db
      .prepare(
        "SELECT proposal.remote_snapshot_json,proposal.remote_snapshot_sha256,reviewed.final_remote_snapshot_json,reviewed.final_remote_snapshot_sha256 FROM project_alpha_project_inbound_proposals proposal JOIN project_alpha_project_inbound_resolution_authorizations reviewed ON reviewed.proposal_id=proposal.proposal_id WHERE proposal.proposal_id=?",
      )
      .bind(proposal.proposalId)
      .first<{
        remote_snapshot_json: string;
        remote_snapshot_sha256: string;
        final_remote_snapshot_json: string;
        final_remote_snapshot_sha256: string;
      }>();
    expect(JSON.parse(evidence!.remote_snapshot_json).requestId).not.toBe(
      JSON.parse(evidence!.final_remote_snapshot_json).requestId,
    );
    expect(evidence!.remote_snapshot_sha256).not.toBe(
      evidence!.final_remote_snapshot_sha256,
    );
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM native_project_lifecycle_pending_handoffs WHERE command_id=?",
        )
        .bind(cid)
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT name,current_version,archived FROM operations_shared_projects WHERE external_project_id=?",
        )
        .bind(lifecycleExternal)
        .first(),
    ).toEqual({
      name: "External PA profile edit",
      current_version: 2,
      archived: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM native_project_lifecycle_activations WHERE command_id=?",
        )
        .bind(cid)
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM native_project_lifecycle_receipts WHERE command_id=?",
        )
        .bind(cid)
        .first("n"),
    ).toBe(1);
    expect(lifecycleLive.posts).toBe(posts);
  }, 120000);
  it("allows one concurrent sender and refuses clearing a transmitted lease as rejected", async () => {
    const cid = crypto.randomUUID(),
      prepared = await prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          externalProjectId: lifecycleExternal,
          action: "archive",
        },
        lifecycleLive.send,
      );
    const guarded = vi.fn<typeof fetch>(async (input, init) => {
      if ((input instanceof Request ? input.method : init?.method) === "POST") {
        expect(
          await db
            .prepare(
              "SELECT count(*) n FROM native_project_lifecycle_post_attempts WHERE parent_command_id=?",
            )
            .bind(cid)
            .first("n"),
        ).toBe(1);
        await expect(
          db
            .prepare(
              "UPDATE native_project_lifecycle_commands SET state='rejected',lease_token=NULL,lease_expires_at=NULL WHERE command_id=?",
            )
            .bind(cid)
            .run(),
        ).rejects.toThrow(/transition/);
      }
      return lifecycleLive.send(input, init);
    });
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        submitNativeProjectLifecycle(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          {
            commandId: cid,
            reviewSha256: prepared.reviewSha256,
            reconcile: false,
          },
          guarded,
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(lifecycleLive.posts).toBe(1);
  });
  it("cannot forge a lifecycle canonical writer, receipt, or unleased network attempt", async () => {
    const cid = crypto.randomUUID(),
      prepared = await prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          externalProjectId: lifecycleExternal,
          action: "archive",
        },
        lifecycleLive.send,
      );
    await expect(
      db
        .prepare(
          "UPDATE operations_shared_projects SET archived=1,current_version=current_version+1 WHERE external_project_id=?",
        )
        .bind(lifecycleExternal)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO native_project_lifecycle_post_attempts(lease_token,parent_command_id,request_sha256)VALUES(?,?,?)",
        )
        .bind(crypto.randomUUID(), cid, "a".repeat(64))
        .run(),
    ).rejects.toThrow(/authorized lease/);
    await expect(
      db
        .prepare(
          "INSERT INTO native_project_lifecycle_receipts(command_id,response_json,response_sha256,project_alpha_revision,request_id)VALUES(?,?,?,?,?)",
        )
        .bind(cid, "{}", "a".repeat(64), "2", crypto.randomUUID())
        .run(),
    ).rejects.toThrow(/not exact/);
    await expect(
      db
        .prepare(
          "DELETE FROM native_project_lifecycle_commands WHERE command_id=?",
        )
        .bind(cid)
        .run(),
    ).rejects.toThrow(/durable/);
    const oldCommand = crypto.randomUUID(),
      h = await db
        .prepare(
          "SELECT * FROM operations_shared_projects WHERE external_project_id=?",
        )
        .bind(lifecycleExternal)
        .first<Record<string, unknown>>();
    const action = {
      sourceId: lifecycleOwner.sourceId,
      actor: { ...lifecycleActor, scopes: [] },
      operation: "update" as const,
      local: {
        expectedLocalVersion: h!.current_version as number,
        expectedLocalProjectionSha256: h!.canonical_projection_sha256 as string,
      },
      command: {
        commandId: oldCommand,
        externalId: lifecycleExternal,
        expectedRevision: h!.pa_revision as string,
        expectedProjectionSha256: h!.canonical_projection_sha256 as string,
        expectedAuthorizationGeneration: "8",
        project: {
          name: "Forbidden competing edit",
          description: null,
          estimatedStart: null,
          estimatedEnd: "2026-01-01",
        },
      },
    };
    expect(
      await planProjectAlphaProjectV2Command(env() as never, action),
    ).not.toMatchObject({ status: "queued" });
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM project_alpha_project_outbox WHERE command_id=?",
        )
        .bind(oldCommand)
        .first("n"),
    ).toBe(0);
    await abandonNativeProjectLifecyclePreparation(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      { commandId: cid, reviewSha256: prepared.reviewSha256 },
    );
    expect(
      await planProjectAlphaProjectV2Command(env() as never, action),
    ).toMatchObject({ status: "queued" });
  });
  it("denies cross-source reuse of one canonical ID before privileged reads", async () => {
    const sibling = "project-alpha:secondary",
      e = env();
    const profile = JSON.parse(e.PROJECT_ALPHA_API_V2_CONNECTIONS);
    profile.instances[sibling] = {
      ...profile.instances[lifecycleOwner.sourceId],
      sourceId: sibling,
      baseUrl: "https://two.example.test",
      sourceInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      applicationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      historyEpoch: "11111111-1111-4111-8111-111111111111",
    };
    e.PROJECT_ALPHA_API_V2_CONNECTIONS = JSON.stringify(profile);
    const reads = lifecycleLive.send.mock.calls.length;
    await expect(
      prepareNativeProjectLifecycle(
        e as never,
        lifecycleActor,
        { ...lifecycleOwner, sourceId: sibling },
        {
          commandId: crypto.randomUUID(),
          externalProjectId: lifecycleExternal,
          action: "archive",
        },
        lifecycleLive.send,
      ),
    ).rejects.toThrow(/owner context/);
    expect(lifecycleLive.send.mock.calls).toHaveLength(reads);
    expect(lifecycleLive.posts).toBe(0);
  });
  it("keeps parent and refresh known-unsent when the native context hook denies and reserves only one child", async () => {
    const cid = crypto.randomUUID(),
      prepared = await prepareNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          externalProjectId: lifecycleExternal,
          action: "archive",
        },
        lifecycleLive.send,
      );
    const denied = async () => {
      throw new Error("normal native context changed");
    };
    expect(
      await submitNativeProjectLifecycle(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          reviewSha256: prepared.reviewSha256,
          reconcile: false,
        },
        lifecycleLive.send,
        denied,
      ),
    ).toMatchObject({ state: "prepared" });
    expect(lifecycleLive.posts).toBe(0);
    await submitNativeProjectLifecycle(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      { commandId: cid, reviewSha256: prepared.reviewSha256, reconcile: false },
      lifecycleLive.send,
    );
    const results = await Promise.allSettled(
      [crypto.randomUUID(), crypto.randomUUID()].map((refreshCommandId) =>
        prepareNativeProjectLifecycleRefresh(
          env() as never,
          lifecycleActor,
          lifecycleOwner,
          {
            commandId: cid,
            refreshCommandId,
            reviewSha256: prepared.reviewSha256,
          },
          lifecycleLive.send,
        ),
      ),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const ch = fulfilled[0];
    if (!ch || ch.status !== "fulfilled") throw new Error("child reservation failed");
    const posts = lifecycleLive.posts;
    expect(
      await submitNativeProjectLifecycleRefresh(
        env() as never,
        lifecycleActor,
        lifecycleOwner,
        {
          commandId: cid,
          refreshCommandId: ch.value.refreshCommandId,
          reviewSha256: ch.value.reviewSha256,
          reconcile: false,
        },
        lifecycleLive.send,
        denied,
      ),
    ).toMatchObject({ state: "prepared" });
    expect(lifecycleLive.posts).toBe(posts);
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM native_project_lifecycle_post_attempts WHERE refresh_command_id=?",
        )
        .bind(ch.value.refreshCommandId)
        .first("n"),
    ).toBe(0);
    await abandonNativeProjectLifecyclePreparation(
      env() as never,
      lifecycleActor,
      lifecycleOwner,
      {
        commandId: cid,
        refreshCommandId: ch.value.refreshCommandId,
        reviewSha256: ch.value.reviewSha256,
      },
    );
  });
});
