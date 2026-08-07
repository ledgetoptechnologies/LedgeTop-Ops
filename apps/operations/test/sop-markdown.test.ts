import { describe, expect, it } from "vitest";
import {
  isSafeSopImage,
  isSafeSopLink,
  renderSopMarkdown,
  SOP_SANITIZER_VERSION,
} from "../src/sop-markdown";

describe("SOP Markdown rendering", () => {
  it("renders the supported GFM subset and builds stable, unique heading anchors", () => {
    const rendered = renderSopMarkdown(`
# Preflight & Safety
## Café setup
## Café setup

Purpose with **strong**, *emphasis*, ~~removed~~, and \`inline code\`.

- [x] Batteries charged
- [ ] Airspace checked

| Item | Value |
| --- | ---: |
| Altitude | 300 ft |

> Stop the flight if conditions become unsafe.

\`\`\`html
<script>alert("shown as code")</script>
\`\`\`

[Published SOP](/sops/general-flight/) and [weather](https://weather.gov/).

![Authorized plan](/api/operations/operation-1/job-brief/attachments/attachment-1/content)
`);

    expect(rendered.sanitizerVersion).toBe(SOP_SANITIZER_VERSION);
    expect(rendered.toc).toEqual([
      { id: "sop-heading-preflight-safety", level: 1, text: "Preflight & Safety" },
      { id: "sop-heading-cafe-setup", level: 2, text: "Café setup" },
      { id: "sop-heading-cafe-setup-2", level: 2, text: "Café setup" },
    ]);
    expect(rendered.html).toContain('<h1 id="sop-heading-preflight-safety">');
    expect(rendered.html).toContain("<strong>strong</strong>");
    expect(rendered.html).toContain("<em>emphasis</em>");
    expect(rendered.html).toContain("<del>removed</del>");
    expect(rendered.html).toContain("<ul>");
    expect(rendered.html).toMatch(
      /<input(?=[^>]*type="checkbox")(?=[^>]*disabled)(?=[^>]*checked)[^>]*>/,
    );
    expect(rendered.html).toContain("<table>");
    expect(rendered.html).toContain("<blockquote>");
    expect(rendered.html).toContain("&lt;script&gt;alert(");
    expect(rendered.html).toContain('href="/sops/general-flight/"');
    expect(rendered.html).toContain(
      'href="https://weather.gov/" rel="noopener noreferrer nofollow"',
    );
    expect(rendered.html).toContain(
      'src="/api/operations/operation-1/job-brief/attachments/attachment-1/content"',
    );
  });

  it.each([
    ["heading fragment", "#sop-heading-preflight", true],
    ["published SOP path", "/sops/general-flight", true],
    ["published SOP path with query", "/sops/general-flight?print=1", true],
    ["authorized job attachment", "/api/operations/op-1/job-brief/attachments/file-1/content", true],
    ["HTTPS link", "https://www.faa.gov/uas", true],
    ["HTTP link", "http://example.test", false],
    ["protocol-relative link", "//example.test/file", false],
    ["credentialed HTTPS link", "https://user:secret@example.test/file", false],
    ["JavaScript URL", "javascript:alert(1)", false],
    ["data URL", "data:text/html,<script>alert(1)</script>", false],
    ["vbscript URL", "vbscript:msgbox(1)", false],
    ["blob URL", "blob:https://operations.example/id", false],
    ["encoded slash", "/sops/general-flight%2fadmin", false],
    ["encoded traversal", "/sops/%2e%2e/admin", false],
    ["backslash", "/sops\\general-flight", false],
    ["unrelated local API", "/api/admin/sops", false],
  ])("classifies the %s", (_label, value, expected) => {
    expect(isSafeSopLink(value)).toBe(expected);
  });

  it.each([
    ["authorized attachment", "/api/operations/op-1/job-brief/attachments/file-1/content", true],
    ["SOP page", "/sops/general-flight", false],
    ["remote HTTPS image", "https://example.test/pixel.png", false],
    ["protocol-relative image", "//example.test/pixel.png", false],
    ["data image", "data:image/png;base64,AA==", false],
    ["blob image", "blob:https://operations.example/id", false],
    ["traversal", "/api/operations/op-1/job-brief/attachments/../content", false],
    ["encoded separator", "/api/operations/op-1/job-brief/attachments/file%2fsecret/content", false],
  ])("classifies the %s image source", (_label, value, expected) => {
    expect(isSafeSopImage(value)).toBe(expected);
  });

  it("strips active content, raw HTML, dangerous attributes, and untrusted loads", () => {
    const rendered = renderSopMarkdown(`
# Malicious examples

<script>alert(1)</script>
<style>body { display: none }</style>
<iframe src="https://evil.example"></iframe>
<object data="https://evil.example"></object>
<embed src="https://evil.example">
<svg onload="alert(1)"><script>alert(2)</script></svg>
<form action="https://evil.example"><input name="secret"></form>
<img src="x" onerror="alert(1)" style="position:fixed">

[javascript](JaVaScRiPt:alert(1))
[data](data:text/html;base64,PHNjcmlwdD4=)
[vbscript](vbscript:msgbox(1))
[protocol relative](//evil.example/file)
[credentialed](https://user:secret@evil.example/file)

![remote](https://evil.example/tracker.png)
![data](data:image/svg+xml,<svg onload=alert(1)>)
![blob](blob:https://operations.example/id)
![unrelated local](/api/admin/sops/export.png)
`);

    expect(rendered.toc).toEqual([
      { id: "sop-heading-malicious-examples", level: 1, text: "Malicious examples" },
    ]);
    expect(rendered.html).not.toMatch(
      /<(?:script|style|iframe|object|embed|svg|form)(?:\s|>)/i,
    );
    expect(rendered.html).not.toMatch(/\s(?:on\w+|style)=/i);
    expect(rendered.html).not.toMatch(
      /(?:href|src)="[^"]*(?:javascript|data|vbscript|blob):/i,
    );
    expect(rendered.html).not.toContain("//evil.example");
    expect(rendered.html).not.toContain("user:secret@");
    expect(rendered.html).not.toContain("evil.example/tracker.png");
    expect(rendered.html).not.toContain("/api/admin/sops/export.png");
    expect(rendered.html).not.toContain("<img");
  });
});
