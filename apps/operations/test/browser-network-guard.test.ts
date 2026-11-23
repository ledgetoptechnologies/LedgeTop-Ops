// The guard itself, without a browser: raw sockets to a loopback sink.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedBrowserArgs, loopbackHost, proxiedHost, reservedHost, startProxySink, unexpectedHosts, type ProxySink } from "./browser-network-guard";

let sink: ProxySink | null = null;
afterEach(async () => { await sink?.close(); sink = null; });

function send(port: number, ...parts: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let answer = "";
    const socket = connect(port, "127.0.0.1", async () => {
      for (const part of parts) { socket.write(part); await new Promise(next => setTimeout(next, 10)); }
    });
    socket.on("data", chunk => { answer += String(chunk); });
    socket.on("close", () => resolve(answer));
    socket.on("error", error => { if ((error as { code?: string }).code !== "ECONNRESET") reject(error); });
  });
}

describe("browser network guard", () => {
  it("records every proxied target, answers nothing and hangs up", async () => {
    sink = await startProxySink();
    expect(await send(sink.port, "CONNECT viewer.example.test:443 HTTP/1.1\r\nHost: viewer.example.test:443\r\n\r\n")).toBe("");
    expect(await send(sink.port, "GET http://live.invalid/path HTTP/1.1\r\n\r\n")).toBe("");
    expect(await send(sink.port, "CONNECT split", ".example.test:443 HT", "TP/1.1\r\n\r\n")).toBe("");
    expect(await send(sink.port, "\u0016\u0003\u0001 not a proxy request\r\n")).toBe("");
    expect(sink.hosts).toEqual(["viewer.example.test", "live.invalid", "split.example.test", "unreadable proxy request"]);
  });

  it("accepts only loopback and declared reserved names", () => {
    const hosts = ["127.0.0.1", "localhost", "viewer.example.test", "viewer.example.test", "real-host.com", "unreadable proxy request"];
    expect(unexpectedHosts(hosts, ["viewer.example.test"])).toEqual(["real-host.com", "unreadable proxy request"]);
    expect(unexpectedHosts(["other.example.test"], ["viewer.example.test"])).toEqual(["other.example.test"]);
    expect(() => unexpectedHosts([], ["real-host.com"])).toThrow(/reserved/);
    for (const host of ["a.test", "a.b.example", "x.invalid", "x.localhost"]) expect(reservedHost(host), host).toBe(true);
    for (const host of ["attest", "test.com", "example.dev", "viewer.example.test.com"]) expect(reservedHost(host), host).toBe(false);
    for (const host of ["127.0.0.1.test", "localhost.test"]) expect(loopbackHost(host), host).toBe(false);
    expect(proxiedHost("CONNECT [::1]:443 HTTP/1.1")).toBe("[::1]");
  });

  it("blocks resolution of everything except loopback and proxies the rest to the sink", () => {
    const args = isolatedBrowserArgs(4321);
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1");
    expect(args).toContain("--proxy-server=http://127.0.0.1:4321");
    // A bypass list would open a direct path; --disable-features would replace Playwright's own list.
    expect(args.some(arg => arg.startsWith("--proxy-bypass-list") || arg.startsWith("--disable-features"))).toBe(false);
  });

  it("keeps every URL in the opener spec on a reserved name", () => {
    const spec = readFileSync(new URL("./browser/viewer-opener-policy.spec.ts", import.meta.url), "utf8");
    expect(spec).toContain('viewerHost = "viewer.example.test"');
    for (const match of spec.matchAll(/(?:https?|wss?):\/\/([a-z0-9.-]+)/giu)) expect(reservedHost(match[1]!), match[0]).toBe(true);
    expect(spec).not.toMatch(/\b[a-z0-9-]+\.(?:com|app|net|org|io|dev)\b/iu);
    expect(spec).toContain("...isolatedBrowserArgs(sink.port)");
    expect(spec).toContain("{ auto: true }");
  });
});
