import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "msedge",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-edge", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile-edge", use: { ...devices["iPhone 13"], browserName: "chromium", channel: "msedge" } },
  ],
  webServer: {
    command: "node test/browser-fixture-server.mjs",
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
