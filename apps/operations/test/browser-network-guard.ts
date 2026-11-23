// Keeps a browser test off every real host. Playwright fulfils requests, but the
// browser itself may still resolve and preconnect to the names it sees, so request
// routing alone does not contain it. Three layers, none of which can forward:
//  1. no name resolves except loopback;
//  2. every non-loopback connection, speculative ones included, goes to a loopback
//     proxy that records the target and hangs up;
//  3. anything recorded that is not an allowed reserved name fails the test.
import { createServer, type Server, type Socket } from "node:net";

/** RFC 2606 / 6761 names: nobody can own them, so nothing real can answer. */
export function reservedHost(host: string): boolean {
  return /(?:^|\.)(?:test|example|invalid|localhost)$/u.test(host);
}

export function loopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** The hosts a test must not have tried to reach: anything but loopback and the reserved names it declares. */
export function unexpectedHosts(hosts: Iterable<string>, declared: readonly string[]): string[] {
  for (const host of declared) if (!reservedHost(host)) throw new Error(`Only reserved host names may be declared: ${host}`);
  return [...new Set(hosts)].filter(host => !loopbackHost(host) && !declared.includes(host)).sort();
}

export function isolatedBrowserArgs(proxyPort: number): string[] {
  return [
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    // Chromium's implicit bypass keeps loopback direct; everything else meets the sink.
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--disable-quic",
    "--dns-prefetch-disable",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--no-pings",
  ];
}

export interface ProxySink { port: number; hosts: string[]; close(): Promise<void> }

/** "CONNECT host:443 HTTP/1.1" or "GET http://host/path HTTP/1.1"; anything else is itself unexpected. */
export function proxiedHost(line: string): string {
  const [method, target = ""] = line.split(" ");
  try { return new URL(method === "CONNECT" ? `https://${target}` : target).hostname || "unreadable proxy request"; }
  catch { return "unreadable proxy request"; }
}

/** Records the host of each proxied connection and closes it. It opens no outgoing connection. */
export async function startProxySink(): Promise<ProxySink> {
  const hosts: string[] = [], sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    let received = "", recorded = false;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      if (recorded) return;
      received += chunk.toString("latin1");
      if (!received.includes("\r\n") && received.length < 8192) return;
      recorded = true;
      hosts.push(proxiedHost(received.split("\r\n", 1)[0]!));
      socket.end();
      socket.destroySoon();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The proxy sink has no port");
  return { port: address.port, hosts, close: () => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }) };
}
