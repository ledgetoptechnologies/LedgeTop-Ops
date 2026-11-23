// Pure checks; no browser starts here.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../playwright.config";
import { BROWSER_NETWORK_ARGS } from "./browser-network-args";

// Reviewed exceptions: a spec that replaces the launch with a stricter one of its own. Name
// and reason; adding one is a reviewed change to this file.
const REVIEWED: Readonly<Record<string, string>> = Object.freeze({
  "viewer-opener-policy.spec.ts": "adds a loopback proxy that records and drops every connection, and keeps these arguments",
});
const directory = new URL("./browser/", import.meta.url);

describe("Operations browser tests and live hosts", () => {
  it("resolves only loopback, for every project", () => {
    expect(BROWSER_NETWORK_ARGS[0]).toBe("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]");
    for (const flag of ["--proxy-server=direct://", "--disable-background-networking", "--disable-component-update", "--dns-prefetch-disable", "--no-pings"])
      expect(BROWSER_NETWORK_ARGS).toContain(flag);
    expect(BROWSER_NETWORK_ARGS.some(flag => flag.startsWith("--disable-features"))).toBe(false);
    expect(config.use?.launchOptions?.args).toEqual([...BROWSER_NETWORK_ARGS]);
    expect(config.use?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    for (const project of config.projects ?? []) for (const key of ["launchOptions", "proxy", "connectOptions", "baseURL"])
      expect(project.use, `${project.name} must not replace ${key}`).not.toHaveProperty(key);
  });

  it("lets no spec replace the launch unless it is a reviewed exception", () => {
    const names = readdirSync(directory, { recursive: true }).map(String).filter(name => /\.(?:ts|tsx|mjs)$/u.test(name));
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      if (Object.hasOwn(REVIEWED, name)) continue;
      expect(readFileSync(new URL(name.replaceAll("\\", "/"), directory), "utf8"), name)
        .not.toMatch(/launchOptions|connectOptions|host-resolver-rules|proxy-server|launchPersistentContext|\b(?:chromium|browserType)\b[^\n]{0,20}\.launch\(|\bproxy:/u);
    }
    for (const reason of Object.values(REVIEWED)) expect(reason.length).toBeGreaterThan(20);
  });
});
