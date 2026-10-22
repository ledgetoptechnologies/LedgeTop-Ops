import { authenticateNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { resolveEmployeeReadAuthority, recheckEmployeeReadAuthority } from "./employee-read-authority";
import { readEmployeeGateway, type EmployeeGatewayConfiguration, type EmployeeReadProof,
  type EmployeeReadSelection } from "./employee-read-transport";

/** Not mounted. The eventual route must parse only root/path/operation inputs,
 * supply its own primary database and durable content-start audit sink, and keep
 * this feature disabled until staging enrollment and joined acceptance pass. */
export async function readAuthenticatedEmployeeFile(request: Request, database: D1Database,
  rootId: string, selection: EmployeeReadSelection,
  configuration: Readonly<{ enabled: boolean; access: NativeStaffAccessConfiguration; gateway: EmployeeGatewayConfiguration }>,
  dependencies: Readonly<{ fetch: typeof fetch;
    auditContentStart: (proof: EmployeeReadProof, selection: EmployeeReadSelection) => Promise<void> }>,
): Promise<Response> {
  const denied = () => Response.json({ error: "employee_read_denied" }, {
    status: 403, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
  if (configuration.enabled !== true) return Response.json({ error: "employee_read_disabled" }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
  if (request.method !== "GET") return denied();
  try {
    const access = Object.freeze({ enabled: configuration.access.enabled, issuer: configuration.access.issuer,
      staffAudience: configuration.access.staffAudience });
    const gateway = Object.freeze({ origin: configuration.gateway.origin, gatewayId: configuration.gateway.gatewayId,
      keyId: configuration.gateway.keyId, key: new Uint8Array(configuration.gateway.key) });
    const range = selection.range;
    const selected = Object.freeze({ operation: selection.operation, path: selection.path, expectedSha256: selection.expectedSha256,
      range: range === null ? null : Object.freeze({ start: range.start, end: range.end }) });
    const fetcher = dependencies.fetch, auditContentStart = dependencies.auditContentStart;
    const authenticated = await authenticateNativeStaffWithAdmissionVersion(request, database, access);
    const authority = await resolveEmployeeReadAuthority(database, authenticated, rootId);
    if (authority === null || authority.gatewayId !== gateway.gatewayId) return denied();
    return await readEmployeeGateway(authority, selected, gateway, {
      fetch: fetcher, auditContentStart,
      recheck: proof => recheckEmployeeReadAuthority(database, proof),
    }, request.signal);
  } catch { return denied(); }
}
