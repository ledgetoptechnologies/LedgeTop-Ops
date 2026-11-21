import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const directorySource = source("../src/client/ClientDirectory.tsx");
const hubSource = source("../src/client/ClientHub.tsx");
const appSource = source("../src/client/OperationsApp.tsx");

describe("Client Hub compact directory toolbar", () => {
  const previous = (globalThis as { location?: unknown }).location;
  beforeAll(() => { (globalThis as { location?: unknown }).location = { search: "?q=Example", pathname: "/clients", origin: "https://ops.example.test" }; });
  afterAll(() => { (globalThis as { location?: unknown }).location = previous; });

  async function render(nativeDirectoryProfileWrites = false): Promise<string> {
    const { ClientDirectory } = await import("../src/client/ClientDirectory");
    return renderToStaticMarkup(createElement(ClientDirectory, { nativeDirectoryProfileWrites }));
  }

  it("searches from the search form on Enter without a separate Search button", async () => {
    const html = await render();
    const form = /<form class="client-directory-search" role="search">([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
    expect(form).toContain('id="client-directory-query"');
    expect(form).toContain('type="search"');
    expect(form).toContain('enterKeyHint="search"');
    expect(form).toContain('value="Example"');
    // Implicit submission: one search field and no submit button, so Enter submits the form.
    expect(form).not.toMatch(/type="submit"/);
    expect(form).not.toMatch(/>Search<\/button>/);
    expect(form).toContain(">Clear search</button>");
    expect(directorySource).toContain("onSubmit={search}");
    expect(directorySource).toMatch(/const search = \(event: FormEvent<HTMLFormElement>\) => \{\s*event\.preventDefault\(\);\s*changeQuery\(\{ \.\.\.query, q: draft \}\);/);
  });

  it("keeps accessible names and the search help for screen readers while hiding them visually", async () => {
    const html = await render();
    expect(html).toContain('<label class="visually-hidden" for="client-directory-query">Search clients</label>');
    expect(html).toContain('<span class="visually-hidden">Sort clients</span>');
    expect(html).toContain('aria-describedby="client-directory-search-help"');
    expect(html).toMatch(/<small id="client-directory-search-help" class="visually-hidden">Search by client name/);
    expect(html).toContain('role="group" aria-label="Client type"');
  });

  it("puts the type tabs and Add client profile in the toolbar row", async () => {
    const html = await render(true);
    const toolbar = /<div class="client-directory-toolbar">([\s\S]*?)<div class="client-directory-meta">/.exec(html)?.[1] ?? "";
    expect(toolbar).toContain("client-directory-filters ltds-segmented");
    expect(toolbar).toContain(">Add client profile</button>");
  });

  it("keeps the live client count and folds freshness into one short line", async () => {
    const html = await render();
    expect(html).toMatch(/<div class="client-directory-meta"><p class="client-directory-status" role="status" aria-live="polite">Loading clients…<\/p><\/div>/);
    expect(directorySource).toContain('`${number(clients.length)} client${clients.length === 1 ? "" : "s"} shown');
    expect(directorySource).toContain("Directory refreshed <time dateTime={indexUpdatedAt}>");
    expect(directorySource).not.toContain("This reflects directory synchronization");
    expect(directorySource).not.toContain("Sorted by the latest business record change");
    expect(directorySource).not.toContain("Open each source workspace for its contacts");
  });

  it("drops descriptive sentences and the repeated eyebrow from the Client Hub header", () => {
    expect(appSource).toContain('clients: ["Client Hub", ""]');
    expect(appSource).toContain('const compact = page === "clients";');
    expect(hubSource).not.toContain("Organizations and standalone clients with their contacts");
    // The onboarding entry button stays where it is; this change does not alter it.
    expect(hubSource).toContain("<OnboardClientButton /></div>");
  });
});
