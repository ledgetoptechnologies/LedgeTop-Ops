import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperationsNativeServicePanel } from "../src/client/OperationsHomeApp";
import {
  operationsNativeRefreshTarget,
  type OperationsNativeBrowserIntent,
} from "../src/client/OperationsNativeDataBrowser";
import type { PortalOperationsHomeResponse } from "../src/client/portal-api";

const response: PortalOperationsHomeResponse = {
  resourceMode: "operations_home",
  homes: [{
    authorityId: "12345678-1234-4123-8123-123456789abc",
    workspaceId: "workspace-one",
    ownershipEpoch: 1,
    grantRevision: 7,
    services: [{
      serviceId: "private-service",
      providerId: "operations",
      displayLabel: "Private service label",
      revision: 1,
    }],
  }],
};

describe("operations native refresh navigation", () => {
  it("retains only navigation intent and does not authorize refresh while authority is pending", () => {
    const folder: OperationsNativeBrowserIntent = { kind: "folder", folderId: "opaque-folder-selector" };
    expect(operationsNativeRefreshTarget(true, false, folder)).toBeNull();
    expect(operationsNativeRefreshTarget(false, true, folder)).toBeNull();
    expect(operationsNativeRefreshTarget(true, true, folder)).toEqual(folder);
  });

  it.each(["checking", "unavailable"] as const)(
    "hides stale service data while authority is %s",
    authorityStatus => {
      const html = renderToStaticMarkup(createElement(OperationsNativeServicePanel, {
        response,
        embedded: true,
        authorityStatus,
      }));
      expect(html).not.toContain("Private service label");
      expect(html).not.toContain("Browse shared deliveries");
      expect(html).toContain("Checking your current delivery access");
    },
  );

  it("renders current service and browser entry only after authority is current", () => {
    const html = renderToStaticMarkup(createElement(OperationsNativeServicePanel, {
      response,
      embedded: true,
      authorityStatus: "current",
    }));
    expect(html).toContain("Private service label");
    expect(html).toContain("Browse shared deliveries");
  });
});
