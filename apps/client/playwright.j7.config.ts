import { defineConfig, devices } from "@playwright/test";

const hostResolver = "--host-resolver-rules=MAP portal.drone.test 127.0.0.1,MAP portal.technology.test 127.0.0.1";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "dual-domain-daily-use.spec.ts",
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  use: {
    channel: "msedge",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: [hostResolver] },
  },
  projects: [
    { name: "drone-desktop", use: { baseURL: "http://portal.drone.test:4173", viewport: { width: 1280, height: 800 } } },
    { name: "technology-desktop", use: { baseURL: "http://portal.technology.test:4173", viewport: { width: 1280, height: 800 } } },
    { name: "drone-mobile", use: { ...devices["iPhone 13"], browserName: "chromium", channel: "msedge", baseURL: "http://portal.drone.test:4173", viewport: { width: 375, height: 812 } } },
    { name: "technology-mobile", use: { ...devices["iPhone 13"], browserName: "chromium", channel: "msedge", baseURL: "http://portal.technology.test:4173", viewport: { width: 375, height: 812 } } },
  ],
  webServer: {
    command: "npm run build && node test/browser-fixture-server.mjs",
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
