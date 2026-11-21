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
    expect(directorySource).toMatch(/const search = \(event: FormEvent<HTMLFormElement>\) => \{\s*event\.preventDefault\(\);\s*if \(!composingRef\.current\) changeQuery\(\{ \.\.\.query, q: draft \}\);/);
  });

  it("commits only composed IME text and carries a pending draft into filter changes", () => {
    expect(directorySource).toContain("if (composing || draft.trim() === query.q) return;");
    expect(directorySource).toContain("event.nativeEvent.isComposing || composingRef.current");
    expect(directorySource).toContain("onCompositionEnd={event => { setComposition(false); setDraft(event.currentTarget.value); }}");
    expect(directorySource).toContain("changeQuery({ ...query, q: composingRef.current ? query.q : draft, ...change })");
    for (const call of ["changeFilters({ source: event.target.value })", "changeFilters({ kind: filter.kind })", 'changeFilters({ sort: event.target.value === "name" ? "name" : "recent" })'])
      expect(directorySource).toContain(call);
    expect(directorySource).not.toMatch(/changeQuery\(\{ \.\.\.query, (source|sort|kind):/);
  });

  it("shows short visible cues and keeps full accessible names and search help", async () => {
    const html = await render();
    expect(html).toContain('<label class="client-directory-cue" for="client-directory-query"><span aria-hidden="true">Search</span><span class="visually-hidden">Search clients</span></label>');
    expect(html).toContain('<span class="client-directory-cue" aria-hidden="true">Sort</span><span class="visually-hidden">Sort clients</span>');
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

  it("keeps 44px toolbar targets at every width and pointer type", () => {
    const css = source("../src/client/styles.css");
    // Same rule the multi-width Playwright specs check (375 to 3440px, desktop and touch projects).
    for (const selector of [".client-directory-toolbar :is(input, select) {",
      ".client-directory-toolbar :is(.client-directory-search, .client-directory-filters) > button {",
      ".client-directory-toolbar > .client-directory-create .client-directory-create-bar > button {"]) {
      const rule = css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
      expect(rule, selector).toContain("min-height: 44px;");
    }
    // Nothing (base or media query) shrinks a toolbar control below 44px.
    expect(css).not.toMatch(/\.client-directory-(toolbar|filters|search|source|sort)[^{}]*\{[^}]*min-height:\s*(2\.25rem|2\.5rem|3[0-9]px|[0-3]?[0-9]px)/);
  });

  it("drops descriptive sentences and the repeated eyebrow from the Client Hub header", () => {
    expect(appSource).toContain('clients: ["Client Hub", ""]');
    expect(appSource).toContain('const compact = page === "clients";');
    expect(hubSource).not.toContain("Organizations and standalone clients with their contacts");
    // The onboarding entry button stays where it is; this change does not alter it.
    expect(hubSource).toContain("<OnboardClientButton /></div>");
  });
});
