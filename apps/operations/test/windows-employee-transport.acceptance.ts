import { createServer, request as tlsRequest } from "node:https";
import { request as plainRequest } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, mkdir, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createEmployeeReadRouter } from "../src/worker/employee-read-routes";
import { employeeTransportAuthority } from "./windows-employee-transport.fixture";

// Discovery is local; production RS256 validation and D1 identity/authority are real.
const keys = vi.hoisted(() => vi.fn());
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: keys }));
const execute = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
it("actual .NET employee client reads real Python gateway under native D1 grants and refuses revoked/stale/cross-user reads", async () => {
  if (process.env.LEDGETOP_EMPLOYEE_LARGE !== undefined && process.env.LEDGETOP_EMPLOYEE_LARGE !== "1")
    throw Error("Large mode must be explicitly selected as 1");
  const large = process.env.LEDGETOP_EMPLOYEE_LARGE === "1";
  const expectedBytes = large ? 3 * 1024 ** 3 + 17 : 2 * 1024 ** 2;
  const interruptAfter = large ? 2 * 1024 ** 3 + 1024 ** 2 + 17 : 16_384;
  const startedAt = Date.now();
  const dotnet = process.env.LEDGETOP_TEST_DOTNET ?? "dotnet", windowsRoot = resolve("../windows-download");
  const childEnv = { ...process.env, DOTNET_GENERATE_ASPNET_CERTIFICATE: "false", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
  expect((await execute(dotnet, ["--version"], { cwd: windowsRoot, env: childEnv, timeout: 20_000 })).stdout.trim())
    .toBe(JSON.parse(await readFile(join(windowsRoot, "global.json"), "utf8")).sdk.version);
  await execute(dotnet, ["build", "EmployeeTransportTests/WindowsDownload.EmployeeTransportTests.csproj", "--nologo"],
    { cwd: windowsRoot, env: childEnv, timeout: 90_000 });
  const dll = join(windowsRoot, "EmployeeTransportTests/bin/Debug/net10.0/LedgeTop.WindowsDownload.Tests.dll");
  const hostSpace = await statfs(tmpdir(), { bigint: true });
  const hostAvailableBytes = hostSpace.bavail * hostSpace.bsize;
  // Allow source + two immutable gateway snapshots + desktop destination plus
  // reserve on the PC, even if Docker's virtual disk grows on the same drive.
  if (large && hostAvailableBytes < BigInt(expectedBytes) * 4n + 2n * 1024n ** 3n)
    throw Error("Insufficient PC disk space for the bounded large-file fixture");
  const temporary = await mkdtemp(join(tmpdir(), "ledge-top-synthetic-employee-"));
  const suffix = randomUUID(), container = `ops-employee-transport-${suffix}`, network = `ops-employee-transport-${suffix}`, image = `ops-employee-transport:${suffix}`;
  const volume = `ops-employee-transport-${suffix}`;
  const rootId = randomUUID(), gatewayId = randomUUID(), key = randomBytes(32), control = randomBytes(32).toString("hex");
  let authority: Awaited<ReturnType<typeof employeeTransportAuthority>> | undefined, server: ReturnType<typeof createServer> | undefined;
  let localDockerValidated = false, ownedVolumeCreated = false;
  const docker = (args: string[], timeout = 30_000) => execute("docker", args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  try {
    // Never build/run this fixture through a remote Docker context or NAS daemon.
    if (process.env.DOCKER_HOST) throw Error("Remote/overridden Docker hosts are not permitted by this local fixture");
    const endpoint = JSON.parse((await docker(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"])).stdout);
    if (typeof endpoint !== "string" || !(endpoint.startsWith("npipe:////./pipe/") || endpoint.startsWith("unix:///")))
      throw Error("A local named-pipe or Unix-socket Docker endpoint is required");
    if ((await docker(["info", "--format", "{{.OSType}}"])).stdout.trim() !== "linux") throw Error("Linux gateway fixture required");
    localDockerValidated = true;
    await docker(["build", "--pull=false", "--network=none", "-f", resolve("../employee-read-gateway/Dockerfile.transport-test"), "-t", image, resolve("../employee-read-gateway")], 90_000);
    const imageId = (await docker(["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();
    if (large) {
      await docker(["volume", "create", "--driver=local", "--label", "ledgetop.synthetic-transport=true", volume]);
      ownedVolumeCreated = true;
      if ((await docker(["volume", "inspect", "--format", "{{.Driver}} {{json .Options}}", volume])).stdout.trim() !== "local null")
        throw Error("Synthetic volume must be a plain local Docker volume without driver options");
    }
    await docker(["network", "create", "--label", "ledgetop.synthetic-transport=true", network]);
    await docker(["run", "--detach", "--name", container, "--label", "ledgetop.synthetic-transport=true", "--network", network,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=128m", "--cpus=1",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777", "--publish", "127.0.0.1::8080",
      ...(large ? ["--mount", `type=volume,source=${volume},target=/synthetic`, "--env", "SYNTHETIC_LARGE_FILE=1"] : []),
      "--env", `SYNTHETIC_ROOT_ID=${rootId}`, "--env", `SYNTHETIC_GATEWAY_ID=${gatewayId}`, "--env", `SYNTHETIC_KEY_HEX=${key.toString("hex")}`, image]);
    let ready: { root: { path: string; fingerprint: string }; bytes: number; sha256: string; volumeAvailableBytes: number;
      volumeAvailableBytesBefore: number; sourceAllocatedBytes: number } | undefined;
    for (let attempt = 0; attempt < (large ? 480 : 80); attempt++) {
      const status = JSON.parse((await docker(["inspect", "--format", "{{json .State}}", container])).stdout);
      if (!status.Running) throw Error("Owned synthetic gateway exited before readiness");
      const logs = (await docker(["logs", container])).stdout.trim();
      if (logs) { ready = JSON.parse(logs.split("\n")[0]!); break; }
      await delay(250);
    }
    const allowedRoot = large ? /^\/synthetic\/synthetic-transport-[A-Za-z0-9_-]+\/source$/u : /^\/tmp\/synthetic-transport-[A-Za-z0-9_-]+\/source$/u;
    if (!ready || !allowedRoot.test(ready.root.path) || ready.bytes !== expectedBytes) throw Error("Synthetic root readiness missing");
    const ownedSource = ready.root.path;
    const binding = (await docker(["port", container, "8080/tcp"])).stdout.trim();
    if (!/^127\.0\.0\.1:[0-9]+$/u.test(binding)) throw Error("Gateway must publish only to IPv4 loopback");
    const port = Number(binding.split(":").at(-1));
    if (!Number.isInteger(port) || port < 1024) throw Error("Missing loopback-only gateway port");
    authority = await employeeTransportAuthority(rootId, gatewayId, ready.root.fingerprint);
    const fixture = authority;
    await execute(dotnet, [dll, "--certificate", temporary], { env: childEnv, timeout: 20_000 });
    const certificate = await readFile(join(temporary, "certificate.pem")), pair = await generateKeyPair("RS256", { extractable: true });
    const publicKey = await exportJWK(pair.publicKey); publicKey.kid = "synthetic-employee-transport";
    keys.mockReturnValue(createLocalJWKSet({ keys: [publicKey] }));
    const issuer = "https://synthetic.cloudflareaccess.com", audience = "synthetic-employee-transport-audience";
    const token = (person: typeof fixture.alice) => new SignJWT({ type: "app", email: person.identity.email })
      .setProtectedHeader({ alg: "RS256", kid: publicKey.kid }).setIssuer(issuer).setSubject(person.identity.verifiedAccessSubject)
      .setAudience(audience).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
    let origin = "", interrupted = false, gatewayCalls = 0, gatewayCallsAtRevocation = -1;
    let router: ReturnType<typeof createEmployeeReadRouter>;
    const errors: unknown[] = [], requests: { status: number; path: string; range: string | null }[] = [];
    const upstreamOperations: string[] = [];
    server = createServer({ cert: certificate, key: await readFile(join(temporary, "key.pem")) }, async (req, res) => {
      try {
        if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
        if (req.url === "/v1/read" && req.method === "POST") {
          if (req.headers["cf-access-token"] || req.headers["cf-access-jwt-assertion"]) throw Error("Human assertion leaked to gateway");
          gatewayCalls++;
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks); upstreamOperations.push(JSON.parse(body.toString()).operation);
          const upstream = plainRequest({ hostname: "127.0.0.1", port, path: "/v1/read", method: "POST", headers: { ...req.headers, host: `127.0.0.1:${port}` } }, incoming => {
            res.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(res);
          });
          upstream.on("error", error => { errors.push(error); res.destroy(); }); upstream.end(body); return;
        }
        if (req.method === "POST" && req.headers["x-local-lab-token"] === control) {
          if (req.url === "/__lab/revoke") { await fixture.revoke(); gatewayCallsAtRevocation = gatewayCalls; }
          else if (req.url === "/__lab/mutate") await docker(["exec", "--user", "65532:65532", container, "python", "-c",
            "import os,sys; p=sys.argv[1]+'/map.bin'; st=os.stat(p); f=open(p,'r+b'); f.write(b'CHANGED!'); f.flush(); os.fsync(f.fileno()); f.close(); os.utime(p,ns=(st.st_atime_ns,st.st_mtime_ns))", ownedSource]);
          else { res.writeHead(404).end(); return; }
          res.writeHead(200).end(); return;
        }
        if (req.method !== "GET") { res.writeHead(405).end(); return; }
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
        if (typeof req.headers["cf-access-token"] === "string") headers.set("Cf-Access-Jwt-Assertion", req.headers["cf-access-token"]);
        const response = await router.fetch(new Request(origin + req.url, { headers }));
        requests.push({ status: response.status, path: new URL(origin + req.url).pathname, range: headers.get("Range") });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) { res.end(); return; }
        const reader = response.body.getReader();
        try {
          if (!interrupted && response.status === 200 && req.url?.startsWith("/api/staff/files/downloads/")) {
            interrupted = true;
            // TCP/TLS may deliver arbitrarily small chunks. Commit an actual
            // complete configured prefix before cutting the response; aborting before
            // headers permits HttpClient's normal safe GET retry instead.
            let written = 0;
            while (written < interruptAfter) {
              const part = await reader.read(); if (part.done) throw Error("Short synthetic gateway body");
              const selected = part.value.subarray(0, interruptAfter - written);
              if (!res.write(selected)) await once(res, "drain"); written += selected.length;
            }
            await delay(150); res.destroy();
            while (!(await reader.read()).done) { /* drain owned fixture; upstream cancel is separate */ }
          } else {
            for (;;) { const part = await reader.read(); if (part.done) break; if (!res.write(part.value)) await once(res, "drain"); } res.end();
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
      } catch (error) { errors.push(error); res.destroy(); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw Error("Missing TLS listener");
    origin = `https://127.0.0.1:${address.port}`;
    const gatewayFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) !== origin + "/v1/read" || init?.method !== "POST") throw Error("Unexpected gateway destination");
      return await new Promise<Response>((resolve, reject) => {
        const request = tlsRequest(String(url), { method: "POST", headers: Object.fromEntries(new Headers(init.headers)), ca: certificate,
          rejectUnauthorized: true, signal: init.signal ?? undefined }, incoming => {
          const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
          resolve(new Response(Readable.toWeb(incoming, { strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream<Uint8Array>, { status: incoming.statusCode!, headers }));
        }); request.on("error", reject); request.end(String(init.body));
      });
    }) as typeof fetch;
    router = createEmployeeReadRouter({ enabled: true, opsOrigin: origin, access: { enabled: true, issuer, staffAudience: audience },
      gateway: { origin, gatewayId, keyId: "synthetic-local-key", key }, handleKey: randomBytes(32) }, { database: fixture.db, fetch: gatewayFetch });
    const output = join(temporary, "output"); await mkdir(output);
    const hash = createHash("sha256"), pattern = Buffer.from(Uint8Array.from({ length: 251 }, (_, i) => (i * 31 + 17) % 251));
    const block = Buffer.alloc(pattern.length * 4096); for (let at = 0; at < block.length; at += pattern.length) pattern.copy(block, at);
    for (let remaining = expectedBytes; remaining > 0;) { const count = Math.min(remaining, block.length); hash.update(block.subarray(0, count)); remaining -= count; }
    const sha256 = hash.digest("hex"); expect(ready.sha256).toBe(sha256);
    const config = join(temporary, "synthetic-employee.json");
    await writeFile(config, JSON.stringify({ Origin: origin, Certificate: join(temporary, "certificate.pem"), Output: output,
      Token: await token(fixture.alice), OtherToken: await token(fixture.bob), RootId: rootId, Sha256: sha256, ControlToken: control, ExpectedBytes: expectedBytes }));
    const result = await execute(dotnet, [dll, "--run", config], { env: childEnv, timeout: large ? 480_000 : 90_000 }).catch(error => {
      console.error(JSON.stringify({ interrupted, gatewayCalls, upstreamOperations,
        requests: requests.map(r => ({ status: r.status, range: r.range, download: r.path.startsWith("/api/staff/files/downloads/") })),
        adapterErrors: errors.map(e => e instanceof Error ? e.message : "adapter_error") }));
      throw error;
    });
    expect(errors).toEqual([]);
    const receipt = JSON.parse(result.stdout.trim());
    expect(receipt).toMatchObject({ kind: "local-employee-transport-v1", bytes: expectedBytes, sha256, tlsPinRejected: true,
      rootsAndListingParsed: true, resumedDigestVerified: true, crossUserDenied: true, traversalDenied: true, staleVersionRejected: true, revokedHandleDenied: true });
    const downloads = requests.filter(item => item.path.startsWith("/api/staff/files/downloads/"));
    expect(downloads.map(item => item.status)).toEqual([200, 206, 403, 412, 403]);
    expect(downloads[1]!.range).toBe(`bytes=${receipt.retainedPrefixBytes}-`);
    if (large) expect(receipt.retainedPrefixBytes).toBeGreaterThan(2 ** 31 - 1);
    expect(gatewayCallsAtRevocation).toBeGreaterThan(0); expect(gatewayCalls).toBe(gatewayCallsAtRevocation);
    expect(upstreamOperations).toEqual(["list", "manifest", "content", "content", "manifest"]);
    const auditEvents = await fixture.db.prepare("SELECT count(*) n FROM ops_employee_read_content_starts").first("n");
    expect(auditEvents).toBe(2);
    const pythonPeak = (await docker(["exec", container, "python", "-c", "print(next(line.split()[1] for line in open('/proc/1/status') if line.startswith('VmHWM:')))"])).stdout.trim();
    const evidence = { ...receipt, imageId, largeFileMode: large, elapsedMs: Date.now() - startedAt,
      hostAvailableBytesBefore: hostAvailableBytes.toString(), volumeAvailableBytesBefore: ready.volumeAvailableBytesBefore,
      volumeAvailableBytesAfterSource: ready.volumeAvailableBytes, sourceAllocatedBytes: ready.sourceAllocatedBytes,
      nodePeakRssBytes: process.resourceUsage().maxRSS * 1024, pythonPeakRssBytes: Number(pythonPeak) * 1024,
      observedDownloadStatuses: downloads.map(item => item.status), upstreamOperations,
      gatewayCallsAfterRevocation: 0, auditEvents, limits: "Actual local .NET/Ops D1/Python container transport; synthetic JWKS discovery/helper and local TLS adapters. No human sign-in, NAS, staging host, EH or production acceptance." };
    console.log(JSON.stringify(evidence));
    if (process.env.LEDGETOP_EMPLOYEE_TRANSPORT_RECEIPT) await writeFile(process.env.LEDGETOP_EMPLOYEE_TRANSPORT_RECEIPT, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await authority?.runtime.dispose();
    if (localDockerValidated) {
      await docker(["rm", "--force", container]).catch(() => {});
      if (ownedVolumeCreated) await docker(["volume", "rm", volume]).catch(() => {});
      await docker(["network", "rm", network]).catch(() => {});
      await docker(["image", "rm", image]).catch(() => {});
    }
    if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith("ledge-top-synthetic-employee-")) throw Error("Unexpected cleanup target");
    await rm(temporary, { recursive: true, force: true });
  }
});
