import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Brand } from "@ltds/ui";

describe("Operations umbrella display brand", () => {
  // The linked UI package uses the classic JSX transform in this Node test
  // loader; the application build supplies its automatic JSX runtime.
  beforeEach(() => vi.stubGlobal("React", React));
  afterEach(() => vi.unstubAllGlobals());
  it("supports the shared business name without changing the product", () => {
    const html = renderToStaticMarkup(createElement(Brand, { product: "Operations", name: "Ledge Top" }));
    expect(html).toContain("Ledge Top<small>Operations</small>");
    expect(html).not.toContain("Ledge Top Drone Services");
  });
  it("defaults to the generic Ledge Top identity with the shared LT mark", () => {
    const html = renderToStaticMarkup(createElement(Brand, { product: "Client Delivery" }));
    expect(html).toContain("Ledge Top<small>Client Delivery</small>");
    expect(html).toContain('class="ltds-mark"');
    expect(html).not.toMatch(/Drone Services|<img/);
  });
});
