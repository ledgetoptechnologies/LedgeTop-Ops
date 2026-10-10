export type FrozenDirectoryRequest = Readonly<{
  path: string;
  method: "POST" | "PATCH";
  mutationId: string;
  body: string;
}>;

/**
 * Retry evidence is deliberately memory-only: bodies can contain profile data and must not be
 * persisted in browser storage. Reloading or navigating abandons it, so the operator must review
 * fresh server state before starting another mutation.
 */
export type FrozenCreateAttempt = Readonly<{
  mutationId: string;
  phase: "admission" | "write";
  sourceIds: readonly string[];
  admission: FrozenDirectoryRequest;
  write: FrozenDirectoryRequest;
}>;

type Requester = (request: FrozenDirectoryRequest) => Promise<unknown>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function verifiedProfileWrite(value: unknown, expected: {
  recordId: string; kind: "organization" | "client"; version: number; sourceIds?: readonly string[];
}): value is { status: "written" | "pending" } {
  if (!object(value) || (value.status !== "written" && value.status !== "pending")
    || value.recordId !== expected.recordId || value.kind !== expected.kind || value.version !== expected.version
    || typeof value.replayed !== "boolean" || !Array.isArray(value.destinations)
    || !exactKeys(value, ["status", "recordId", "kind", "version", "replayed", "destinations"])) return false;
  const destinations = value.destinations as unknown[];
  if (!destinations.length || !destinations.every(destination => object(destination) && exactKeys(destination, ["sourceId", "state"])
    && typeof destination.sourceId === "string" && destination.sourceId.length > 0
    && (destination.state === "pending" || destination.state === "acknowledged"))) return false;
  const states = destinations.map(destination => (destination as Record<string, unknown>).state);
  if (value.status === "written" ? states.some(state => state !== "acknowledged") : !states.some(state => state === "pending")) return false;
  const sources = destinations.map(destination => String((destination as Record<string, unknown>).sourceId));
  if (new Set(sources).size !== sources.length) return false;
  return expected.sourceIds === undefined
    || JSON.stringify([...sources].sort()) === JSON.stringify([...expected.sourceIds].sort());
}

export function verifiedRelationshipWrite(value: unknown, expected: {
  mutationId: string; relationshipVersion: number;
}): value is { status: "written" | "pending" } {
  if (!object(value) || (value.status !== "written" && value.status !== "pending")
    || value.mutationId !== expected.mutationId || value.relationshipVersion !== expected.relationshipVersion
    || typeof value.replayed !== "boolean" || !Array.isArray(value.destinations)
    || !exactKeys(value, ["status", "mutationId", "relationshipVersion", "replayed", "destinations"])) return false;
  const destinations = value.destinations as unknown[];
  if (!destinations.length || !destinations.every(destination => object(destination) && exactKeys(destination, ["sourceId", "state"])
    && typeof destination.sourceId === "string" && destination.sourceId.length > 0
    && (destination.state === "pending" || destination.state === "acknowledged"))) return false;
  const states = destinations.map(destination => (destination as Record<string, unknown>).state);
  const sources = destinations.map(destination => String((destination as Record<string, unknown>).sourceId));
  return new Set(sources).size === sources.length
    && (value.status === "written" ? states.every(state => state === "acknowledged") : states.some(state => state === "pending"));
}

export async function executeCreateAttempt(attempt: FrozenCreateAttempt, request: Requester,
  writeExpected: { recordId: string; kind: "organization" | "client"; version: number; sourceIds?: readonly string[] },
  enteredWrite: (attempt: FrozenCreateAttempt) => void): Promise<unknown> {
  let current = attempt;
  if (current.phase === "admission") {
    const admission = await request(current.admission);
    if (!object(admission) || admission.status !== "prepared" || Object.keys(admission).length !== 1)
      throw new Error("The create admission response could not be verified.");
    current = { ...current, phase: "write" };
    enteredWrite(current);
  }
  const result = await request(current.write);
  if (!verifiedProfileWrite(result, writeExpected)) throw new Error("The client profile save response could not be verified.");
  return result;
}

export async function executeProfileAttempt(requestValue: FrozenDirectoryRequest, request: Requester,
  expected: { recordId: string; kind: "organization" | "client"; version: number; sourceIds?: readonly string[] }): Promise<unknown> {
  const result = await request(requestValue);
  if (!verifiedProfileWrite(result, expected)) throw new Error("The client profile save response could not be verified.");
  return result;
}

export async function executeRelationshipAttempt(requestValue: FrozenDirectoryRequest, request: Requester,
  expected: { mutationId: string; relationshipVersion: number }): Promise<unknown> {
  const result = await request(requestValue);
  if (!verifiedRelationshipWrite(result, expected)) throw new Error("The organization relationship response could not be verified.");
  return result;
}
