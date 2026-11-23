import type { InviteDestinationBinding } from "./client-onboarding-invite-destinations";

type SourceId = InviteDestinationBinding["sourceId"];
type SourceIdentity = Readonly<{ sourceId: SourceId; sourceInstanceId: string; applicationId: string; historyEpoch: string }>;
type TargetRef = Readonly<{ publicId: string; recordVersion: number }>;
type Pick = Readonly<{ client?: TargetRef; organization?: TargetRef }>;
type AuthorizedTarget = TargetRef & SourceIdentity & Readonly<{
  kind: "client" | "organization";
  recordId: string;
  organizationRecordId?: string;
}>;

const sameSource = (target: SourceIdentity, source: SourceIdentity) => target.sourceId === source.sourceId
  && target.sourceInstanceId === source.sourceInstanceId && target.applicationId === source.applicationId && target.historyEpoch === source.historyEpoch;

/** Matches selections against fresh, independently authorized exact rows. The caller must
 * obtain active staff-authorized rows and current relationship evidence before using it. */
export function resolveInviteTargetSelections(sources: readonly SourceIdentity[], picks: Readonly<Partial<Record<SourceId, Pick>>>,
  authorizedTargets: readonly AuthorizedTarget[]) {
  const seen = new Set(sources.map(source => source.sourceId));
  if (seen.size !== sources.length || Object.keys(picks).some(id => !seen.has(id as SourceId))) return null;

  const resolved: Array<{ source: SourceIdentity; client: AuthorizedTarget | null; organization: AuthorizedTarget | null }> = [];
  for (const source of sources) {
    const pick = picks[source.sourceId];
    const find = (kind: AuthorizedTarget["kind"], ref?: TargetRef) => {
      if (!ref) return null;
      const matches = authorizedTargets.filter(row => sameSource(row, source) && row.kind === kind && row.publicId === ref.publicId);
      const [match] = matches;
      return matches.length === 1 && match && match.recordVersion === ref.recordVersion ? match : null;
    };
    const client = find("client", pick?.client);
    const organization = find("organization", pick?.organization);
    if ((pick?.client && !client) || (pick?.organization && !organization)
      || (client && organization && client.organizationRecordId !== organization.recordId)) return null;
    resolved.push({ source, client, organization });
  }
  return resolved;
}
