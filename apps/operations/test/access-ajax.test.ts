import { describe, expect, it, vi } from "vitest";
import { accessAjaxFetch } from "@ltds/ui";

const origin = "https://ops.example.test";
const html401 = () => new Response("<html></html>", { status: 401, headers: { "Content-Type": "text/html" } });
const json = (status: number) => new Response("{}", { status, headers: { "Content-Type": "application/json" } });

function setup(...responses: Response[]) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift() ?? json(200));
  const ended = vi.fn();
  return { fetcher, ended, wrapped: accessAjaxFetch(fetcher as typeof fetch, origin, ended) };
}
const sent = (fetcher: ReturnType<typeof setup>["fetcher"]) => new Headers(fetcher.mock.calls[0]![1]?.headers).get("X-Requested-With");

describe("Access AJAX header", () => {
  it.each(["/api/session", `${origin}/api/session`, "api/session"])("marks this site's API call %s", async url => {
    const { fetcher, wrapped } = setup();
    await wrapped(url);
    expect(sent(fetcher)).toBe("XMLHttpRequest");
  });

  it.each([
    "https://bucket.r2.example.test/api/upload?X-Amz-Signature=abc",
    "//ops.evil.test/api/session",
    "https://ops.example.test.evil.test/api/session",
    "http://ops.example.test/api/session",
    "/apish/session",
    "/media/clip.mp4",
    "/cdn-cgi/access/get-identity",
  ])("leaves %s exactly as it was called", async url => {
    const { fetcher, wrapped } = setup();
    const init = { method: "PUT", headers: { "Content-Type": "video/mp4" } };
    await wrapped(url, init);
    expect(fetcher).toHaveBeenCalledWith(url, init);
  });

  it("keeps the caller's options, headers, cookies, CSRF token and signal", async () => {
    const { fetcher, wrapped } = setup();
    const signal = new AbortController().signal;
    await wrapped("/api/save", { method: "POST", body: "{}", credentials: "same-origin", redirect: "error", signal,
      headers: { "X-CSRF-Token": "token", "Content-Type": "application/json" } });
    const init = fetcher.mock.calls[0]![1]!;
    expect(init).toMatchObject({ method: "POST", body: "{}", credentials: "same-origin", redirect: "error", signal });
    const headers = new Headers(init.headers);
    expect(headers.get("X-CSRF-Token")).toBe("token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
  });

  it("keeps a Request's own headers", async () => {
    const { fetcher, wrapped } = setup();
    await wrapped(new Request(`${origin}/api/save`, { headers: { "X-CSRF-Token": "token" } }));
    const headers = new Headers(fetcher.mock.calls[0]![1]?.headers);
    expect(headers.get("X-CSRF-Token")).toBe("token");
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
  });

  it("marks a URL object", async () => {
    const { fetcher, wrapped } = setup();
    await wrapped(new URL(`${origin}/api/session`));
    expect(sent(fetcher)).toBe("XMLHttpRequest");
  });

  it("sends a Request's body and signal without reading them", async () => {
    const { fetcher, wrapped } = setup();
    const controller = new AbortController();
    const request = new Request(`${origin}/api/save`, { method: "POST", body: "payload", credentials: "include", signal: controller.signal });
    await wrapped(request);
    expect(request.bodyUsed).toBe(false);
    const [input, init] = fetcher.mock.calls[0]!;
    expect(input).toBe(request);
    const delivered = new Request(input as Request, init);
    expect(delivered.method).toBe("POST");
    expect(delivered.credentials).toBe("include");
    controller.abort();
    expect(delivered.signal.aborted).toBe(true);
    expect(await delivered.text()).toBe("payload");
  });

  it("leaves a Request to another site untouched", async () => {
    const { fetcher, wrapped } = setup();
    const request = new Request("https://bucket.r2.example.test/api/upload?X-Amz-Signature=abc", { method: "PUT", body: "bytes" });
    await wrapped(request);
    expect(fetcher).toHaveBeenCalledWith(request, undefined);
    expect(request.headers.has("X-Requested-With")).toBe(false);
  });
});

describe("sign-in ending", () => {
  it("reports an Access 401 after the page was signed in, and still returns the response", async () => {
    const { ended, wrapped } = setup(json(200), html401());
    await wrapped("/api/session");
    expect((await wrapped("/api/session/status")).status).toBe(401);
    expect(ended).toHaveBeenCalledOnce();
  });

  it("leaves a 401 on a page that never got in to that page's own recovery screen", async () => {
    const { ended, wrapped } = setup(html401());
    await wrapped("/api/session");
    expect(ended).not.toHaveBeenCalled();
  });

  it.each([["a 403 denial", 403, "text/html"], ["the app's own JSON 401", 401, "application/json; charset=utf-8"], ["a server error", 500, "text/html"]])(
    "ignores %s", async (_name, status, type) => {
      const { ended, wrapped } = setup(json(200), new Response("", { status: status as number, headers: { "Content-Type": type as string } }));
      await wrapped("/api/session");
      await wrapped("/api/other");
      expect(ended).not.toHaveBeenCalled();
    });

  it("ignores a 401 from another site", async () => {
    const { ended, wrapped } = setup(json(200), html401());
    await wrapped("/api/session");
    await wrapped("https://storage.example.test/api/x");
    expect(ended).not.toHaveBeenCalled();
  });
});
