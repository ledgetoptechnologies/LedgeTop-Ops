import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ltds/ui", async () => {
  const actual = await vi.importActual<typeof import("@ltds/ui")>("@ltds/ui");
  return { ...actual, Brand: () => null };
});

import { SignInProblem } from "../src/client/SignInProblem";

function renderProblem(status: number | null, message: string) {
  return renderToStaticMarkup(createElement(SignInProblem, { failure: { status, message } }));
}

describe("Operations startup sign-in recovery", () => {
  it("offers same-site sign-out and retry when the current email is not provisioned", () => {
    const html = renderProblem(403, "Your Access identity is not provisioned for LTDS Operations");

    expect(html).toContain("This email can&#x27;t open Ledge Top Operations");
    expect(html).toContain("href=\"/cdn-cgi/access/logout\"");
    expect(html).toContain("Sign in with a different email");
    expect(html).toContain("Try again");
    expect(html).not.toContain("LTDS Operations");
    expect(html).not.toContain("Your Access identity is not provisioned");
  });

  it("offers a safe way back after an expired or unavailable session", () => {
    for (const status of [401, 503, null]) {
      const html = renderProblem(status, "private server diagnostic");
      expect(html).toContain("/cdn-cgi/access/logout");
      expect(html).toContain("Try again");
      expect(html).not.toContain("private server diagnostic");
    }
  });
});
