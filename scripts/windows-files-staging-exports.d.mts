export const WINDOWS_STAGING_EXPORT_POLICY: Readonly<Record<"operations" | "delivery", Readonly<{
  runtime: readonly string[]; helpers: readonly string[];
}>>>;
export function assertWindowsStagingRuntimeExports(app: "operations" | "delivery", baseline: string[], candidate: string[]): {
  runtimeExportsPreserved: true; excludedModuleHelpers: string[];
};
