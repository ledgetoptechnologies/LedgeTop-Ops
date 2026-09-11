import { describe, expect, it } from "vitest";
import { incomingRequestPage } from "../src/worker/incoming-page";

describe("incoming request page", () => {
  const page = incomingRequestPage({
    publicId: "request-id",
    title: "Project files",
    turnstileSiteKey: "site-key",
    requiresAccessCode: false,
  });

  it("renders required identity fields and an accessible file picker", () => {
    expect(page).toContain('id="name" maxlength="120" autocomplete="name" required');
    expect(page).toContain('id="email" type="email" maxlength="254" autocomplete="email" required');
    expect(page).toContain('id="files" type="file" multiple');
    expect(page).toContain(".drop:focus-within");
    expect(page).toContain('class="drop" id="drop" for="files" tabindex="0" role="button"');
    expect(page).toContain("Choose files or drop them here");
    expect(page).toContain("drop.addEventListener(\"keydown\"");
    expect(page).toContain("Files are checked before they can be delivered.");
    expect(page).toContain('data-size="compact"');
    expect(page).toContain(".cf-turnstile{width:150px;min-height:140px;max-width:100%}");
    expect(page).toContain('id="website" type="text" tabindex="-1" autocomplete="off"');
  });

  it("renders an access-code control only when the resolved request requires one", () => {
    expect(page).not.toContain('id="code"');
    const protectedPage = incomingRequestPage({ publicId: "request-id", title: "Project files", requiresAccessCode: true });
    expect(protectedPage).toContain('<label for="code">Access code</label><input id="code" type="password" maxlength="128" required');
    expect(protectedPage).toContain('accessCode:accessCode?.value||""');
    expect(protectedPage).not.toContain("access_code_hash");
    expect(protectedPage).toContain("accessCode&&!accessCode.reportValidity()");
  });

  it("never reports zero successful uploads as success", () => {
    expect(page).toContain('kind=failed===0?"ok":succeeded===0?"error":"warning"');
    expect(page).toContain('succeeded+" of "+selected.length+" files uploaded"');
    expect(page).not.toContain('succeeded+" file"+(succeeded===1?"":"s")+" uploaded successfully."');
  });

  it("supports honest retry and same-file reselection", () => {
    expect(page).toContain('picker.value=""');
    expect(page).toContain("You can select the file again to retry.");
    expect(page).toContain("Empty files cannot be uploaded");
    expect(page).toContain("etag:checkpoint.etag");
    expect(page).toContain('crypto.subtle.digest("SHA-256",bytes)');
    expect(page).toContain("resumeFingerprint");
    expect(page).toContain("new XMLHttpRequest()");
    expect(page).toContain("250*2**(attempt-1)");
    expect(page).toContain('undefined,"DELETE"');
    expect(page).toContain("deleteSaved(key)");
  });
});
