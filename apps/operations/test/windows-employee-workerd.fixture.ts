import { build, type BuildResult } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Miniflare, Request as MfRequest, Response as MfResponse } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { WINDOWS_STAGING_EXPORT_POLICY, assertWindowsStagingRuntimeExports } from "../../../scripts/windows-files-staging-exports.mjs";
import { employeeTransportAuthority } from "./windows-employee-transport.fixture";

const issuer = "https://ledgetoptechnologies.cloudflareaccess.com";
const audience = "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b";
const opsOrigin = "https://ops-staging.ledgetopdroneservices.com";
export const employeeWorkerdGatewayOrigin = "https://employee-gateway-staging.ledgetopdroneservices.com";
type Input = Readonly<{ rootId: string; gatewayId: string; fingerprint: string; gatewayOrigin: string; gatewayKey: Uint8Array;
  outboundGateway: (request: Request) => Promise<Response> }>;

/** Owned local gateway transport is supplied by the separate TLS/Docker harness.
 * No arbitrary gateway URL, real Access key, source path or product config override. */
export async function employeeWorkerdTransportFixture(input: Input) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (!uuid.test(input.rootId) || !uuid.test(input.gatewayId) || !/^[a-f0-9]{64}$/u.test(input.fingerprint)
    || input.gatewayOrigin !== employeeWorkerdGatewayOrigin || !(input.gatewayKey instanceof Uint8Array) || input.gatewayKey.length !== 32
    || typeof input.outboundGateway !== "function") throw Error("Invalid owned employee Workerd fixture inputs");
  const rootId = input.rootId, fingerprint = input.fingerprint, gatewayId = input.gatewayId, gatewayKey = new Uint8Array(input.gatewayKey), outboundGateway = input.outboundGateway;
  const options = { bundle: true, format: "esm" as const, platform: "browser" as const, conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"], write: false as const, metafile: true as const, outfile: "index.js", logLevel: "silent" as const };
  const baseline = await build({ ...options, entryPoints: [resolve("src/worker/staging-native-authority-entrypoint.ts")] });
  const entry = `import standard from "../src/worker/staging-native-authority-entrypoint";
    import {createWindowsEmployeeStagingWorker} from "../src/worker/windows-files-staging-worker";
    export {${WINDOWS_STAGING_EXPORT_POLICY.operations.runtime.join(",")}} from "../src/worker/staging-native-authority-entrypoint";
    export default createWindowsEmployeeStagingWorker(${JSON.stringify({ enabled: true, gateway: { origin: employeeWorkerdGatewayOrigin, gatewayId, keyId: "synthetic-local-key" } })},standard);`;
  const candidate = await build({ ...options, stdin: { contents: entry, resolveDir: resolve("test"), sourcefile: "local-employee-workerd.ts", loader: "ts" } });
  const exportsOf = (result: Pick<BuildResult, "metafile">) => Object.values(result.metafile!.outputs).flatMap(o => o.exports).sort();
  const exportAudit = assertWindowsStagingRuntimeExports("operations", exportsOf(baseline), exportsOf(candidate));
  const script = candidate.outputFiles[0]!.text;
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicKey = await exportJWK(pair.publicKey); publicKey.kid = "local-employee-workerd-only";
  const observations = { jwksRequests: 0, gatewayRequests: 0, forbiddenNetwork: [] as string[] };
  const runtime = new Miniflare({ name: "local-employee-ops", modules: true, compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"], script,
    d1Databases: { OPS_DB: crypto.randomUUID() }, bindings: { ENVIRONMENT: "staging", TEAM_DOMAIN: issuer, OPERATIONS_AUD: audience,
      PUBLIC_BASE_URL: opsOrigin, EXPECTED_HOST: new URL(opsOrigin).host,
      WINDOWS_EMPLOYEE_GATEWAY_SIGNING_KEY: Buffer.from(gatewayKey).toString("base64url"),
      WINDOWS_EMPLOYEE_HANDLE_KEY: randomBytes(32).toString("base64url"), WINDOWS_EMPLOYEE_QUEUE_KEY: randomBytes(32).toString("base64url") },
    outboundService: async (request: MfRequest) => {
      if (request.method === "GET" && request.url === issuer + "/cdn-cgi/access/certs") {
        observations.jwksRequests++; return MfResponse.json({ keys: [publicKey] });
      }
      if (request.method !== "POST" || request.url !== employeeWorkerdGatewayOrigin + "/v1/read") {
        observations.forbiddenNetwork.push(new URL(request.url).origin); return new MfResponse("Owned fixture outbound denied", { status: 503 });
      }
      if (["Cf-Access-Token", "Cf-Access-Jwt-Assertion", "Authorization", "Cookie"].some(name => request.headers.has(name))) throw Error("Human credentials reached gateway boundary");
      observations.gatewayRequests++;
      // The trusted harness enforces captured IPv4-loopback HTTPS, ephemeral CA,
      // rejectUnauthorized and hostname verification, while forwarding HMAC/body unchanged.
      const response = await outboundGateway(request as unknown as Request);
      return new MfResponse(response.body as unknown as ConstructorParameters<typeof MfResponse>[0], {
        status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers),
      });
    } });
  try {
    const db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    const authority = await employeeTransportAuthority(rootId, gatewayId, fingerprint, { database: db, runtime });
    const token = (person: typeof authority.alice) => new SignJWT({ type: "app", email: person.identity.email }).setProtectedHeader({ alg: "RS256", kid: publicKey.kid })
      .setIssuer(issuer).setSubject(person.identity.verifiedAccessSubject).setAudience(audience).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
    const worker = await runtime.getWorker() as unknown as { fetch(url: string, init: RequestInit): Promise<Response> };
    return { runtime, db, token: await token(authority.alice), otherToken: await token(authority.bob), opsOrigin, fullOpsComposition: true,
      bundle: { sha256: createHash("sha256").update(script).digest("hex"), exports: exportsOf(candidate), exportAudit }, observations,
      revoke: authority.revoke,
      fetch: (request: Request) => worker.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) }) };
  } catch (error) { await runtime.dispose(); throw error; }
}
