import { defineConfig, devices } from "@playwright/test";

const fixturePort = Number(process.env.PLAYWRIGHT_PORT || 4174);

export default defineConfig({
  testDir: "./test/browser",
  globalSetup: "./test/browser-global-setup.mjs",
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${fixturePort}`,
    channel: "msedge",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-edge", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile-edge", use: { ...devices["iPhone 13"], viewport: { width: 375, height: 812 }, browserName: "chromium", channel: "msedge" } },
  ],
});
