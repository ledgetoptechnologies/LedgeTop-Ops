import { describe, expect, it } from "vitest";
import type { ViewerProviderCapabilities } from "@ltds/shared";
import { defaultViewerProviderOverrides } from "../src/client/provider-options";

describe("NodeODM provider option defaults", () => {
  it("does not send 2.2.3 string-shaped defaults as typed overrides", () => {
    const capabilities = {
      apiVersion: "1", engine: "NodeODM", engineVersion: "2.2.3", maxImages: 1000,
      maxParallelTasks: 1, taskQueueCount: 0, totalMemory: 1, availableMemory: 1, cpuCores: 8,
      providerType: "nodeodm", testedBaseline: "2.2.3", compatibilityWarning: null,
      options: [
        { name: "dsm", type: "bool", domain: ["true", "false"], help: "Generate DSM", value: "false" },
        { name: "orthophoto-resolution", type: "float", domain: "positive", help: "Resolution", value: "5" },
      ],
    } as ViewerProviderCapabilities;
    expect(defaultViewerProviderOverrides(capabilities)).toEqual({});
  });
});
