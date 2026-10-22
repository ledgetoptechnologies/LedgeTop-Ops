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
import { expect, it } from "vitest";
import { employeeWorkerdTransportFixture } from "./windows-employee-workerd.fixture";

const execute = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
it("actual .NET employee crosses full Ops Workerd and Python gateway and rejects revoked/stale/cross-user reads", async () => {
  if (process.env.LEDGETOP_EMPLOYEE_LARGE !== undefined) throw Error("This acceptance permits only the bounded 2 MiB fixture");
  const expectedBytes = 2 * 1024 ** 2, interruptAfter = 16_384;
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
  const temporary = await mkdtemp(join(tmpdir(), "ledge-top-synthetic-employee-"));
  const suffix = randomUUID(), container = `ops-employee-transport-${suffix}`, network = `ops-employee-transport-${suffix}`, image = `ops-employee-transport:${suffix}`;
  const rootId = randomUUID(), gatewayId = randomUUID(), key = randomBytes(32), control = randomBytes(32).toString("hex");
  let authority: Awaited<ReturnType<typeof employeeWorkerdTransportFixture>> | undefined, server: ReturnType<typeof createServer> | undefined;
  let localDockerValidated = false, dockerContext: string | undefined;
  const docker = (args: string[], timeout = 30_000) => execute("docker", dockerContext ? ["--context", dockerContext, ...args] : args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  try {
    // Never build/run this fixture through a remote Docker context or NAS daemon.
    if (process.env.DOCKER_HOST || process.env.BUILDKIT_HOST || process.env.BUILDX_BUILDER) throw Error("Docker host/builder overrides are not permitted by this local fixture");
    const contextName = (await docker(["context", "show"])).stdout.trim();
    if (!contextName || contextName.length > 128 || /[\s\p{Cc}]/u.test(contextName)) throw Error("Invalid local Docker context name");
    const endpoint = JSON.parse((await docker(["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"])).stdout);
    if (typeof endpoint !== "string" || !(endpoint.startsWith("npipe:////./pipe/") || endpoint.startsWith("unix:///")))
      throw Error("A local named-pipe or Unix-socket Docker endpoint is required");
    dockerContext = contextName; // Pin all subsequent commands to the endpoint already checked above.
    if ((await docker(["info", "--format", "{{.OSType}}"])).stdout.trim() !== "linux") throw Error("Linux gateway fixture required");
    localDockerValidated = true;
    await docker(["image", "inspect", "--format", "{{.Id}}", "python:3.14.9-slim-trixie"]); // Cached base only; no implicit registry pull.
    await docker(["build", "--label", "ledgetop.synthetic-transport=true", "--pull=false", "--network=none", "-f", resolve("../employee-read-gateway/Dockerfile.transport-test"), "-t", image, resolve("../employee-read-gateway")], 90_000);
    const imageId = (await docker(["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();
    await docker(["network", "create", "--label", "ledgetop.synthetic-transport=true", network]);
    await docker(["run", "--detach", "--name", container, "--label", "ledgetop.synthetic-transport=true", "--network", network,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=128m", "--cpus=1",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777", "--publish", "127.0.0.1::8080",
      "--env", `SYNTHETIC_ROOT_ID=${rootId}`, "--env", `SYNTHETIC_GATEWAY_ID=${gatewayId}`, "--env", `SYNTHETIC_KEY_HEX=${key.toString("hex")}`, image]);
    let ready: { root: { path: string; fingerprint: string }; bytes: number; sha256: string; volumeAvailableBytes: number;
      volumeAvailableBytesBefore: number; sourceAllocatedBytes: number } | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      const status = JSON.parse((await docker(["inspect", "--format", "{{json .State}}", container])).stdout);
      if (!status.Running) throw Error("Owned synthetic gateway exited before readiness");
      const logs = (await docker(["logs", container])).stdout.trim();
      if (logs) { ready = JSON.parse(logs.split("\n")[0]!); break; }
      await delay(250);
    }
    const allowedRoot = /^\/tmp\/synthetic-transport-[A-Za-z0-9_-]+\/source$/u;
    if (!ready || !allowedRoot.test(ready.root.path) || ready.bytes !== expectedBytes) throw Error("Synthetic root readiness missing");
    const ownedSource = ready.root.path;
    const binding = (await docker(["port", container, "8080/tcp"])).stdout.trim();
    if (!/^127\.0\.0\.1:[0-9]+$/u.test(binding)) throw Error("Gateway must publish only to IPv4 loopback");
    const port = Number(binding.split(":").at(-1));
    if (!Number.isInteger(port) || port < 1024) throw Error("Missing loopback-only gateway port");
    await execute(dotnet, [dll, "--certificate", temporary], { env: childEnv, timeout: 20_000 });
    const certificate = await readFile(join(temporary, "certificate.pem"));
    const virtualGatewayOrigin = "https://employee-gateway-staging.ledgetopdroneservices.com";
    let origin = "", interrupted = false, gatewayCalls = 0, gatewayCallsAtRevocation = -1;
    const errors: unknown[] = [], requests: { status: number; path: string; range: string | null; contentLength: string | null; contentEncoding: string | null; strongEtag: boolean }[] = [];
    const upstreamOperations: string[] = [];
    const gatewayHeaders: { contentLength: string | null; contentEncoding: string | null; strongEtag: boolean }[] = [];
    server = createServer({ cert: certificate, key: await readFile(join(temporary, "key.pem")) }, async (req, res) => {
      try {
        if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
        if (req.url === "/v1/read" && req.method === "POST") {
          if (req.headers["cf-access-token"] || req.headers["cf-access-jwt-assertion"]) throw Error("Human assertion leaked to gateway");
          gatewayCalls++;
          const chunks: Buffer[] = []; let bodyBytes = 0;
          for await (const chunk of req) { const bytes = Buffer.from(chunk); bodyBytes += bytes.length; if (bodyBytes > 16384) throw Error("Gateway body bound exceeded"); chunks.push(bytes); }
          const body = Buffer.concat(chunks); upstreamOperations.push(JSON.parse(body.toString()).operation);
          const upstream = plainRequest({ hostname: "127.0.0.1", port, path: "/v1/read", method: "POST", headers: { ...req.headers, host: `127.0.0.1:${port}` } }, incoming => {
            gatewayHeaders.push({ contentLength: typeof incoming.headers["content-length"] === "string" ? incoming.headers["content-length"] : null,
              contentEncoding: typeof incoming.headers["content-encoding"] === "string" ? incoming.headers["content-encoding"] : null,
              strongEtag: typeof incoming.headers.etag === "string" && /^"[a-f0-9]{64}"$/u.test(incoming.headers.etag) });
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
        const response = await fixture.fetch(new Request(fixture.opsOrigin + req.url, { headers }));
        requests.push({ status: response.status, path: new URL(origin + req.url).pathname, range: headers.get("Range"),
          contentLength: response.headers.get("Content-Length"), contentEncoding: response.headers.get("Content-Encoding"),
          strongEtag: /^"[a-f0-9]{64}"$/u.test(response.headers.get("ETag") ?? "") });
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
    const outboundGateway = async (request: Request) => {
      if (request.url !== virtualGatewayOrigin + "/v1/read" || request.method !== "POST"
          || request.headers.has("Cf-Access-Token") || request.headers.has("Cf-Access-Jwt-Assertion"))
        throw Error("Unexpected gateway destination or human assertion");
      const destination = new URL(origin + "/v1/read");
      if (destination.protocol !== "https:" || destination.hostname !== "127.0.0.1" || destination.origin !== origin)
        throw Error("Gateway TLS forwarding is not owned loopback");
      const body = Buffer.from(await request.arrayBuffer());
      if (body.length > 16384) throw Error("Gateway control body exceeds protocol bound");
      const forwardedHeaders = new Headers(request.headers);
      // HTTP Host belongs to the owned physical TLS ingress; signed protocol headers and body stay intact.
      forwardedHeaders.delete("host");
      return await new Promise<Response>((resolve, reject) => {
        const outgoing = tlsRequest(destination, { method: "POST", headers: Object.fromEntries(forwardedHeaders), ca: certificate,
          rejectUnauthorized: true, signal: request.signal }, incoming => {
          const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
          resolve(new Response(Readable.toWeb(incoming, { strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream<Uint8Array>, { status: incoming.statusCode!, headers }));
        }); outgoing.on("error", reject); outgoing.end(body);
      });
    };
    authority = await employeeWorkerdTransportFixture({rootId, gatewayId, fingerprint: ready.root.fingerprint,
      gatewayOrigin: virtualGatewayOrigin, gatewayKey: key, outboundGateway});
    const fixture = authority;
    expect(fixture.fullOpsComposition).toBe(true);
    const invalidParts = fixture.token.split(".");
    invalidParts[2] = (invalidParts[2]![0] === "A" ? "B" : "A") + invalidParts[2]!.slice(1);
    expect((await fixture.fetch(new Request(fixture.opsOrigin + "/api/staff/files/roots", { headers: { "Cf-Access-Jwt-Assertion": invalidParts.join(".") } }))).status).toBe(401);
    expect(gatewayCalls).toBe(0);
    const output = join(temporary, "output"); await mkdir(output);
    const hash = createHash("sha256"), pattern = Buffer.from(Uint8Array.from({ length: 251 }, (_, i) => (i * 31 + 17) % 251));
    const block = Buffer.alloc(pattern.length * 4096); for (let at = 0; at < block.length; at += pattern.length) pattern.copy(block, at);
    for (let remaining = expectedBytes; remaining > 0;) { const count = Math.min(remaining, block.length); hash.update(block.subarray(0, count)); remaining -= count; }
    const sha256 = hash.digest("hex"); expect(ready.sha256).toBe(sha256);
    const config = join(temporary, "synthetic-employee.json");
    await writeFile(config, JSON.stringify({ Origin: origin, Certificate: join(temporary, "certificate.pem"), Output: output,
      Token: fixture.token, OtherToken: fixture.otherToken, RootId: rootId, Sha256: sha256, ControlToken: control, ExpectedBytes: expectedBytes }));
    const result = await execute(dotnet, [dll, "--run", config], { env: childEnv, timeout: 90_000 }).catch(error => {
      console.error(JSON.stringify({ interrupted, gatewayCalls, upstreamOperations, gatewayHeaders,
        requests: requests.map(r => ({ status: r.status, range: r.range, download: r.path.startsWith("/api/staff/files/downloads/"), contentLength: r.contentLength, contentEncoding: r.contentEncoding, strongEtag: r.strongEtag })),
        adapterErrors: errors.map(e => e instanceof Error ? e.message : "adapter_error") }));
      throw error;
    });
    expect(errors).toEqual([]);
    expect(fixture.observations.forbiddenNetwork).toEqual([]);
    expect(fixture.observations.jwksRequests).toBeGreaterThan(0);
    const receipt = JSON.parse(result.stdout.trim());
    expect(receipt).toMatchObject({ kind: "local-employee-transport-v1", bytes: expectedBytes, sha256, tlsPinRejected: true,
      rootsAndListingParsed: true, resumedDigestVerified: true, crossUserDenied: true, traversalDenied: true, staleVersionRejected: true, revokedHandleDenied: true });
    const downloads = requests.filter(item => item.path.startsWith("/api/staff/files/downloads/"));
    expect(downloads.map(item => item.status)).toEqual([200, 206, 403, 412, 403]);
    expect(downloads[1]!.range).toBe(`bytes=${receipt.retainedPrefixBytes}-`);
    expect(downloads.slice(0, 2).map(item => item.contentLength)).toEqual([String(expectedBytes), String(expectedBytes - receipt.retainedPrefixBytes)]);
    expect(downloads.slice(0, 2).every(item => item.strongEtag && item.contentEncoding === null)).toBe(true);
    expect(gatewayCallsAtRevocation).toBeGreaterThan(0); expect(gatewayCalls).toBe(gatewayCallsAtRevocation);
    expect(upstreamOperations).toEqual(["list", "manifest", "content", "content", "manifest"]);
    const auditEvents = await fixture.db.prepare("SELECT count(*) n FROM ops_employee_read_content_starts").first("n");
    expect(auditEvents).toBe(2);
    const pythonPeak = (await docker(["exec", container, "python", "-c", "print(next(line.split()[1] for line in open('/proc/1/status') if line.startswith('VmHWM:')))"])).stdout.trim();
    const evidence = { ...receipt, imageId, invalidSignatureRejected: true, fullOpsComposition: fixture.fullOpsComposition, workerBundle: fixture.bundle, elapsedMs: Date.now() - startedAt,
      hostAvailableBytesBefore: hostAvailableBytes.toString(), volumeAvailableBytesBefore: ready.volumeAvailableBytesBefore,
      volumeAvailableBytesAfterSource: ready.volumeAvailableBytes, sourceAllocatedBytes: ready.sourceAllocatedBytes,
      nodePeakRssBytes: process.resourceUsage().maxRSS * 1024, pythonPeakRssBytes: Number(pythonPeak) * 1024,
      observedDownloadStatuses: downloads.map(item => item.status), observedSuccessContentLengths: downloads.slice(0, 2).map(item => item.contentLength), upstreamOperations,
      gatewayCallsAfterRevocation: 0, auditEvents, limits: "Actual local .NET/full Ops Workerd/D1/Python container transport; virtual staging hosts, exact local JWKS/synthetic helper and ephemeral pinned TLS ingress/offload. No human sign-in, NAS, staging host, EH or production acceptance." };
    console.log(JSON.stringify(evidence));
    if (process.env.LEDGETOP_EMPLOYEE_TRANSPORT_RECEIPT) await writeFile(process.env.LEDGETOP_EMPLOYEE_TRANSPORT_RECEIPT, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  } finally {
    const cleanupErrors: unknown[] = [];
    try { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); } } catch (error) { cleanupErrors.push(error); }
    try { await authority?.runtime.dispose(); } catch (error) { cleanupErrors.push(error); }
    if (localDockerValidated) {
      // Names are generated only by this invocation. Missing never-created resources are harmless;
      // successful cleanup is independently checked instead of silently accepting a leaked resource.
      await docker(["rm", "--force", container]).catch(() => {});
      await docker(["network", "rm", network]).catch(() => {});
      await docker(["image", "rm", image]).catch(() => {});
      try {
        const containers = (await docker(["ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"])).stdout.trim();
        const networks = (await docker(["network", "ls", "--filter", `name=^${network}$`, "--format", "{{.Name}}"])).stdout.trim();
        const images = (await docker(["image", "ls", "--filter", `reference=${image}`, "--format", "{{.Repository}}:{{.Tag}}"])).stdout.trim();
        if (containers || networks || images) throw Error("Owned Docker fixture cleanup incomplete");
      } catch (error) { cleanupErrors.push(error); }
    }
    try {
      if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith("ledge-top-synthetic-employee-")) throw Error("Unexpected cleanup target");
      await rm(temporary, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw Error("Owned local employee fixture cleanup failed");
  }
});