import { describe, expect, it } from "vitest";
import { incomingRequestPage } from "../src/worker/incoming-page";

describe("incoming request page", () => {
  const page = incomingRequestPage({
    publicId: "request-id",
    title: "Project files",
    turnstileSiteKey: "site-key",
  });

  it("renders required identity fields and an accessible file picker", () => {
    expect(page).toContain('id="name" maxlength="120" autocomplete="name" required');
    expect(page).toContain('id="email" type="email" maxlength="254" autocomplete="email" required');
    expect(page).toContain('id="files" type="file" multiple');
    expect(page).toContain(".drop:focus-within");
    expect(page).toContain("Your files are quarantined for LTDS processing");
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
  });
});
