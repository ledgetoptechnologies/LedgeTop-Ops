import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve("dist/client");
const port = Number(process.env.PLAYWRIGHT_PORT || 4174);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

export function createBrowserFixtureServer() {
  return createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") {
    response.writeHead(204).end();
    return;
  }
  const requested = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  let file = requested.startsWith(`${root}${sep}`) ? requested : resolve(root, "index.html");
  try {
    await access(file);
    if ((await stat(file)).isDirectory()) file = resolve(root, "index.html");
  } catch {
    file = resolve(root, "index.html");
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentTypes.get(extname(file)) ?? "application/octet-stream",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https://ledgetopdroneservices.com https://*.mapbox.com data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.r2.cloudflarestorage.com https://api.mapbox.com https://events.mapbox.com https://viewer.ledgetopdroneservices.com; frame-src https://viewer.ledgetopdroneservices.com; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  createReadStream(file).pipe(response);
  });
}

export async function startBrowserFixtureServer() {
  const server = createBrowserFixtureServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export async function stopBrowserFixtureServer(server) {
  if (!server.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await closed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startBrowserFixtureServer();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopBrowserFixtureServer(server);
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void shutdown());
}
