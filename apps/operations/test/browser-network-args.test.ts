// Pure checks; no browser starts here. The final command line is read by asking Playwright to
// launch Node instead of a browser: Node rejects the first Chromium switch and exits, and the
// launch error carries the exact command Playwright ran.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import config from "../playwright.config";
import { BROWSER_NETWORK_ARGS } from "./browser-network-args";

// Reviewed exceptions: a spec that replaces the launch with a stricter one of its own. Name
// and reason; adding one is a reviewed change to this file.
const REVIEWED: Readonly<Record<string, string>> = Object.freeze({
  "viewer-opener-policy.spec.ts": "replaces the proxy with a loopback sink that records and drops every connection",
});
const directory = new URL("./browser/", import.meta.url);
const RULES = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]";

async function finalSwitches(args: readonly string[]): Promise<string[]> {
  const failure = await chromium.launch({ executablePath: process.execPath, headless: true, args: [...args] }).then(async browser => {
    await browser.close();
    throw new Error("A browser started");
  }, (error: Error) => error.message);
  const command = /<launching> ([^\n]*)/u.exec(failure)?.[1] ?? "";
  expect(command, failure.slice(0, 400)).toContain(process.execPath);
  return command.split(/\s(?=--)/u).slice(1).map(value => value.trim());
}
const named = (list: string[], name: string) => list.filter(value => value === `--${name}` || value.startsWith(`--${name}=`));

describe("Operations browser tests and outside hosts", () => {
  it("asks every project's browser to resolve only loopback", () => {
    expect(BROWSER_NETWORK_ARGS[0]).toBe(RULES);
    expect(config.use?.launchOptions?.args).toEqual([...BROWSER_NETWORK_ARGS]);
    expect(config.use?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    for (const project of config.projects ?? []) for (const key of ["launchOptions", "proxy", "connectOptions", "baseURL"])
      expect(project.use, `${project.name} must not replace ${key}`).not.toHaveProperty(key);
  });

  it.each(["Operations config", "Viewer direct-client launch"])("gives Playwright exactly one of each switch: %s", async source => {
    const viewer = new URL("../../viewer/test/launch-network-isolation.mjs", import.meta.url).href;
    const args: string[] = source === "Operations config" ? [...BROWSER_NETWORK_ARGS]
      : (await import(/* @vite-ignore */ viewer)).playwrightIsolationArguments(["--disable-gpu"]);
    const defaults = await finalSwitches([]), final = await finalSwitches(args);
    const names = (list: string[]) => list.map(value => value.split("=", 1)[0]!);
    // Playwright repeats one valueless switch of its own; nothing this change passes repeats anything.
    const repeats = (list: string[]) => names(list).filter((name, index, all) => all.indexOf(name) !== index);
    expect(repeats(final)).toEqual(repeats(defaults));
    expect(repeats(defaults).every(name => !args.some(arg => arg.startsWith(name)))).toBe(true);
    for (const name of ["host-resolver-rules", "proxy-server", "disable-features", "disable-background-networking", "disable-component-update", "disable-sync", "dns-prefetch-disable", "no-pings"])
      expect(named(final, name), name).toHaveLength(1);
    expect(named(final, "host-resolver-rules")).toEqual([RULES]);
    // Playwright's own list survives whole.
    expect(named(final, "disable-features")).toEqual(named(defaults, "disable-features"));
    expect(named(defaults, "disable-features")[0]).toContain("OptimizationHints");
    for (const value of defaults.filter(value => !value.startsWith("--user-data-dir="))) expect(final).toContain(value);
  });

  it("lets no spec replace the launch unless it is a reviewed exception", () => {
    const names = readdirSync(fileURLToPath(directory), { recursive: true }).map(String).filter(name => /\.(?:ts|tsx|mjs)$/u.test(name));
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      if (Object.hasOwn(REVIEWED, name)) continue;
      expect(readFileSync(new URL(name.replaceAll("\\", "/"), directory), "utf8"), name)
        .not.toMatch(/launchOptions|connectOptions|host-resolver-rules|proxy-server|launchPersistentContext|\b(?:chromium|browserType)\b[^\n]{0,20}\.launch\(|\bproxy:/u);
    }
    for (const reason of Object.values(REVIEWED)) expect(reason.length).toBeGreaterThan(20);
  });
});
