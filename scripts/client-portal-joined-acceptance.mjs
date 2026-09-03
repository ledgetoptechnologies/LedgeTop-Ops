import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const groups = [
  {
    id: "j1",
    label: "two-source identity and Client Hub isolation",
    app: "operations",
    files: ["test/joined-business-party-isolation.test.ts"],
  },
  {
    id: "j2",
    label: "Project Alpha metadata remains non-authorizing",
    app: "client",
    files: ["test/joined-portal-metadata-authority.test.ts"],
  },
  {
    id: "j3",
    label: "operational memory copy-forward remains selective",
    app: "operations",
    files: ["test/joined-operational-memory-copy-forward.test.ts"],
  },
  {
    id: "j4",
    label: "membership and delegated access remain independently revocable",
    app: "client",
    files: ["test/joined-membership-delegated-access.test.ts"],
  },
  {
    id: "j5",
    label: "native delivery and notifications fail closed",
    app: "operations",
    files: ["test/joined-native-delivery-notifications.test.ts"],
  },
  {
    id: "j6",
    label: "feedback and service requests remain independently authorized",
    app: "client",
    files: ["test/joined-feedback-service-requests.test.ts"],
  },
  {
    id: "j7",
    label: "dual-domain daily use and authority boundaries",
    app: "client",
    files: ["test/joined-dual-domain-daily-use.test.ts"],
    browserConfig: "playwright.j7.config.ts",
  },
];

const selected = process.argv.slice(2).filter(argument => argument !== "--list");
const requested = selected.length === 0 ? groups : groups.filter(group => selected.includes(group.id));
if (process.argv.includes("--list")) {
  for (const group of groups) console.log(`${group.id}\t${group.app}\t${group.label}`);
  process.exit(0);
}
if (selected.some(id => !groups.some(group => group.id === id)) || new Set(selected).size !== selected.length) {
  console.error(`Unknown or duplicate group. Available groups: ${groups.map(group => group.id).join(", ")}`);
  process.exit(2);
}

for (const group of requested) {
  console.log(`\n[${group.id}] ${group.label}`);
  const appRoot = path.join(root, "apps", group.app);
  const vitest = path.join(appRoot, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(process.execPath, [
    vitest, "run", "--config", "vitest.config.ts", ...group.files,
    "--maxWorkers=1", "--testTimeout=60000",
  ], {
    cwd: appRoot,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (group.browserConfig) {
    const playwright = path.join(appRoot, "node_modules", "@playwright", "test", "cli.js");
    const browser = spawnSync(process.execPath, [playwright, "test", "--config", group.browserConfig], {
      cwd: appRoot,
      encoding: "utf8",
      stdio: "inherit",
      windowsHide: true,
    });
    if (browser.error) {
      console.error(browser.error.message);
      process.exit(1);
    }
    if (browser.status !== 0) process.exit(browser.status ?? 1);
  }
}

console.log(`\nJoined portal acceptance passed: ${requested.map(group => group.id).join(", ")}`);
