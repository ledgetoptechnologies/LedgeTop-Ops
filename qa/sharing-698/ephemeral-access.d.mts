// Types for ephemeral-access.mjs (QA fixture for #698, not for merge).
export interface EphemeralAccessSigner { jwks: { keys: JsonWebKey[] }; mint(claims: Record<string, unknown>, options?: { ttlSeconds?: number }): Promise<string> }
export function createEphemeralAccessSigner(): Promise<EphemeralAccessSigner>;
export function mintFixtureAssertions(signer?: EphemeralAccessSigner): Promise<{ jwks: { keys: JsonWebKey[] }; assertions: Record<string, string> }>;
export function fixtureAccess(): Record<string, unknown>;
