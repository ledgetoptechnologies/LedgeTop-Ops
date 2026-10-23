import { createServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { workerdRpcTransportFixture } from "./windows-workerd-rpc.fixture";
// Node-only provisioning imports need the platform base class. The fixture bundles
// fresh Worker modules with esbuild; this Vitest stub never enters Workerd or RPC.
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const run = promisify(execFile);
it("actual .NET client crosses Client Worker and named Ops RPC, resumes TLS/R2 bytes, then refuses Ops-only revocation", async () => {
  const dotnet = process.env.LEDGETOP_TEST_DOTNET ?? "dotnet";
  const project = resolve("../windows-download/TransportTests/WindowsDownload.TransportTests.csproj");
  // No ASP.NET developer-certificate creation, store installation, helper execution,
  // staging host, NAS mount, actual Access token or real client data is involved.
  const childEnv = { ...process.env, DOTNET_GENERATE_ASPNET_CERTIFICATE: "false", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
  const windowsRoot = resolve("../windows-download");
  const expectedSdk = JSON.parse(await readFile(join(windowsRoot, "global.json"), "utf8")).sdk.version;
  const sdk = await run(dotnet, ["--version"], { cwd: windowsRoot, env: childEnv, timeout: 20_000 });
  expect(sdk.stdout.trim()).toBe(expectedSdk);
  await run(dotnet, ["build", project, "--nologo"], { cwd: windowsRoot, env: childEnv, timeout: 90_000 });
  const dll = resolve("../windows-download/TransportTests/bin/Debug/net10.0/LedgeTop.WindowsDownload.Tests.dll");
  const temporary = await mkdtemp(join(tmpdir(), "ledge-top-synthetic-transport-"));
  async function cleanupTemporary() {
    if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith("ledge-top-synthetic-transport-")) throw Error("Refusing unexpected cleanup target");
    await rm(temporary, { recursive: true, force: true });
  }
  const f = await workerdRpcTransportFixture().catch(async error => { await cleanupTemporary(); throw error; });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    expect(f.fullOpsComposition).toBe(true);
    await run(dotnet, [dll, "--certificate", temporary], { env: childEnv, timeout: 20_000 });
    const token = f.token;
    const controlToken = randomBytes(32).toString("hex");
    const workerOrigin = f.workerOrigin;
    let origin = "", interrupted = false;
    const requests: { path: string; range: string | null; status: number }[] = [];
    const errors: unknown[] = [];
    server = createServer({ cert: await readFile(join(temporary, "certificate.pem")), key: await readFile(join(temporary, "key.pem")) }, async (req, res) => {
      try {
        if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
        if (req.method === "POST" && req.url === "/__lab/revoke" && req.headers["x-local-lab-token"] === controlToken) {
          await f.revoke(); res.writeHead(200).end(); return;
        }
        if (req.method !== "GET") { res.writeHead(405).end(); return; }
        // Local equivalent of Access ingress header injection, not an auth bypass:
        // routers still cryptographically verify the received synthetic assertion.
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
        if (typeof req.headers["cf-access-token"] === "string") headers.set("Cf-Access-Jwt-Assertion", req.headers["cf-access-token"]);
        // Local virtual host adapter only; no product pins or DNS change.
        const request = new Request(workerOrigin + req.url, { headers });
        const response = await f.fetch(request);
        requests.push({ path: new URL(request.url).pathname, range: headers.get("Range"), status: response.status });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        const body = response.body;
        if (!body) { res.end(); return; }
        const reader = body.getReader();
        try {
          if (!interrupted && response.status === 200 && req.url?.endsWith("/download")) {
            interrupted = true;
            // Cut the *transport* after the real route's authorization, R2 pinning
            // and mandatory D1 content-start audit; do not fake a route response.
            let sent = 0;
            while (sent < 16_384) {
              const part = await reader.read();
              if (part.done) throw Error("Fixture body too short to interrupt");
              const prefix = part.value.subarray(0, 16_384 - sent);
              if (!res.write(prefix)) await once(res, "drain");
              sent += prefix.length;
            }
            await new Promise(resolve => setTimeout(resolve, 150));
            res.destroy();
            // Drain this tiny owned fixture after cutting the client socket.
            // R2 cancellation semantics are outside this transport acceptance;
            // canceling its Miniflare proxy mid-write emits Windows WSASend noise.
            while (!(await reader.read()).done) { /* deliberately discard */ }
          } else {
            for (;;) { const part = await reader.read(); if (part.done) break; if (!res.write(part.value)) await once(res, "drain"); }
            res.end();
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
      } catch (error) { errors.push(error); res.destroy(); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw Error("No loopback port");
    origin = `https://127.0.0.1:${address.port}`;
    const output = join(temporary, "output"); await mkdir(output);
    const sha256 = Buffer.from(f.sha).toString("hex");
    const configPath = join(temporary, "synthetic-config.json");
    await writeFile(configPath, JSON.stringify({ Origin: origin, Certificate: join(temporary, "certificate.pem"), Output: output, Token: token, Sha256: sha256, ControlToken: controlToken }));
    const result = await run(dotnet, [dll, "--run", configPath], { env: childEnv, timeout: 60_000 }).catch(error => {
      if (errors.length) throw new AggregateError(errors, "Local route adapter failed");
      throw error;
    });
    expect(errors).toEqual([]);
    expect(f.observations.forbiddenNetwork).toEqual([]);
    expect(f.observations.jwksRequests).toBeGreaterThan(0);
    const receipt = JSON.parse(result.stdout.trim());
    expect(receipt).toMatchObject({ kind: "local-client-transport-v1", bytes: f.bytes.length, sha256, tlsPinRejected: true, invalidSignatureRejected: true, catalogParsed: true, resumedDigestVerified: true, revokedHandleDenied: true });
    const downloads = requests.filter(r => r.path.endsWith("/download"));
    expect(downloads.map(r => r.status)).toEqual([200, 206, 404]);
    expect(downloads[1]!.range).toBe(`bytes=${receipt.retainedPrefixBytes}-`);
    expect(await f.db.prepare("SELECT count(*) n FROM windows_portal_successor_content_start_events").first("n")).toBe(1);
    const evidence = { ...receipt, observedDownloadStatuses: downloads.map(r => r.status), auditEvents: 1, opsOnlyRevokeDenied: true, clientGrantStillActive: true, namedOpsRpc: true, fullOpsComposition: f.fullOpsComposition, workerBundles: f.bundles, localJwksFetches: f.observations.jwksRequests,
      limits: "Actual local Workerd Client fetch and named Ops WorkerEntrypoint RPC with emulated D1/R2; loopback virtual host/TLS ingress and synthetic RS256/token helper. No human sign-in, deployed Worker, real R2 or employee gateway acceptance." };
    console.log(JSON.stringify(evidence));
    // Optional caller-owned receipt, never includes ephemeral keys, JWTs or handles.
    if (process.env.LEDGETOP_TRANSPORT_RECEIPT) await writeFile(process.env.LEDGETOP_TRANSPORT_RECEIPT, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    try { await f.runtime.dispose(); } finally { await cleanupTemporary(); }
  }
});
