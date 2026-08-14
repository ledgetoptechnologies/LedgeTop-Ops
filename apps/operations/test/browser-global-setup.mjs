import {
  startBrowserFixtureServer,
  stopBrowserFixtureServer,
} from "./browser-fixture-server.mjs";

export default async function globalSetup() {
  if (process.env.PLAYWRIGHT_EXTERNAL_SERVER === "true") return;
  const server = await startBrowserFixtureServer();
  return async () => stopBrowserFixtureServer(server);
}
