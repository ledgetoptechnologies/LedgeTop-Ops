export type BootstrapOwner = Readonly<{
  email: string;
  displayName: string;
  clientStaffId: string;
  operationsStaffId: string;
}>;

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
