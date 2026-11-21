// Types for fixture-db.mjs (QA fixture for #698, not for merge).
export interface FixtureDatabase { sqlite: unknown; d1: D1Database; migrations: string[] }
export function buildDatabase(kind: "delivery" | "ops"): FixtureDatabase;
export function buildFixtureDatabases(): { delivery: FixtureDatabase; ops: FixtureDatabase };
export function currentDigests(): Record<string, string>;
export const fixtureDir: string;
export const repoRoot: string;
export const PINNED_FILES: string[];
