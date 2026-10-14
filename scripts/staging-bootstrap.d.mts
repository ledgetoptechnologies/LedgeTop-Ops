export type BootstrapOwner = Readonly<{
  email: string;
  displayName: string;
  clientStaffId: string;
  operationsStaffId: string;
}>;

export const CLIENT_CURRENT_SOURCE_MIGRATION_CHAIN: Readonly<{
  count: number;
  finalMigration: string;
  namesSha256: string;
  contentsSha256: string;
  appendedMigrations: Readonly<Record<string, string>>;
}>;
export const OPERATIONS_CURRENT_SOURCE_MIGRATION_CHAIN: typeof CLIENT_CURRENT_SOURCE_MIGRATION_CHAIN;
export const OPERATIONS_LATEST_SOURCE_MIGRATION_CHAIN: typeof CLIENT_CURRENT_SOURCE_MIGRATION_CHAIN;

export type BootstrapMigration = Readonly<{
  name: string;
  source: string;
  generated: string;
  sourceSha256: string;
  generatedSha256: string;
  transformed: boolean;
}>;

export type BootstrapArtifact = {
  entry: Readonly<{ source: string; workerName: string; binding: string; databaseName: string; seed: string;
    migrationCount: number; migrationNamesSha256: string; migrationContentsSha256: string }>;
  files: BootstrapMigration[];
  config: Record<string, unknown>;
  manifest: Readonly<{ transformedFiles: string[]; sourceChainSha256: string; [key: string]: unknown }>;
  runDirectory: string;
  configFilename: string;
};

export type BootstrapArtifacts = Record<string, BootstrapArtifact> & {
  delivery: BootstrapArtifact;
  operations: BootstrapArtifact;
};

export function buildArtifacts(base: string, owner: BootstrapOwner,
  options?: Readonly<{ disposableTargets?: unknown }>): BootstrapArtifacts;
