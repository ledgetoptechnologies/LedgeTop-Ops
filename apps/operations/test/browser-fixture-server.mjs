import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

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

const server = createServer(async (request, response) => {
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
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https://ledgetopdroneservices.com https://*.mapbox.com data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.r2.cloudflarestorage.com https://api.mapbox.com https://events.mapbox.com; worker-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  createReadStream(file).pipe(response);
});

server.listen(port, "127.0.0.1");
function shutdown() {
  const forceExit = setTimeout(() => process.exit(0), 2_000);
  forceExit.unref();
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
