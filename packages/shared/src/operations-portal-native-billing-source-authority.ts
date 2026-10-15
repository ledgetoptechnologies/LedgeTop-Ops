/** Source selection is an operator-reviewed restriction beneath an existing native entity grant.
 * Browser requests never supply a PA selector, credential or source identity tuple. */
export type NativeBillingSourceSelection = Readonly<{ parentGrantId: string; sourceId: string }>;
export type NativeBillingSourceGrant = NativeBillingSourceSelection & Readonly<{
  operationId: string; grantId: string; expectedRevision: number; reviewFingerprint: string }>;
export type NativeBillingSourceRevoke = Readonly<{ operationId: string; grantId: string; expectedRevision: number }>;
export type NativeBillingSourceContext = Readonly<{
  sourceId: string; sourceInstanceId: string; applicationId: string; historyEpochId: string; origin: string;
  kind: "organization" | "client" | "project"; externalId: string; publicId: string;
  mappingKind: string; mappingProvenanceId: string;
  revision: string; projectionSha256: string; authorizationGeneration: string; conflictRevision:string }>;
export const nativeBillingSourceUuid = (v: unknown): v is string => typeof v === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const nativeBillingSourceId = (v: unknown): v is string => typeof v === "string"
  && /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(v);
export const nativeBillingSourceExact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function parseNativeBillingSourceContext(value:unknown):NativeBillingSourceContext|null{
  const keys=["sourceId","sourceInstanceId","applicationId","historyEpochId","origin","kind","externalId","publicId",
    "mappingKind","mappingProvenanceId","revision","projectionSha256","authorizationGeneration","conflictRevision"];
  if(!nativeBillingSourceExact(value,keys)||!nativeBillingSourceId(value.sourceId)
    ||![value.sourceInstanceId,value.applicationId,value.historyEpochId].every(nativeBillingSourceUuid)
    ||!["organization","client","project"].includes(String(value.kind))
    ||typeof value.origin!=="string"||typeof value.publicId!=="string"||!/^[0-9a-f]{32}$/.test(value.publicId)
    ||typeof value.projectionSha256!=="string"||!/^[0-9a-f]{64}$/.test(value.projectionSha256))return null;
  for(const key of ["externalId","mappingKind","mappingProvenanceId"])
    if(typeof value[key]!=="string"||!(value[key] as string).length||(value[key] as string).length>191||/\p{C}/u.test(value[key] as string))return null;
  for(const key of ["revision","authorizationGeneration","conflictRevision"])
    if(typeof value[key]!=="string"||!/^(0|[1-9][0-9]{0,19})$/.test(value[key] as string)
      ||key==="revision"&&value[key]==="0")return null;
  try{const url=new URL(value.origin);if(url.protocol!=="https:"||url.origin!==value.origin||url.username||url.password)return null;}catch{return null;}
  return value as unknown as NativeBillingSourceContext;
}
export function parseNativeBillingSourceSelection(value: unknown): NativeBillingSourceSelection | null {
  return nativeBillingSourceExact(value, ["parentGrantId", "sourceId"])
    && nativeBillingSourceUuid(value.parentGrantId) && nativeBillingSourceId(value.sourceId)
    ? { parentGrantId: value.parentGrantId, sourceId: value.sourceId } : null;
}
export function parseNativeBillingSourceGrant(value: unknown): NativeBillingSourceGrant | null {
  if (!nativeBillingSourceExact(value, ["parentGrantId", "sourceId", "operationId", "grantId", "expectedRevision", "reviewFingerprint"])) return null;
  const selection = parseNativeBillingSourceSelection({ parentGrantId: value.parentGrantId, sourceId: value.sourceId });
  return selection && nativeBillingSourceUuid(value.operationId) && nativeBillingSourceUuid(value.grantId)
    && typeof value.expectedRevision === "number" && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0
    && typeof value.reviewFingerprint === "string" && /^[0-9a-f]{64}$/.test(value.reviewFingerprint)
    ? { ...selection, operationId: value.operationId, grantId: value.grantId,
      expectedRevision: value.expectedRevision, reviewFingerprint: value.reviewFingerprint } : null;
}
export function parseNativeBillingSourceRevoke(value: unknown): NativeBillingSourceRevoke | null {
  return nativeBillingSourceExact(value, ["operationId", "grantId", "expectedRevision"])
    && nativeBillingSourceUuid(value.operationId) && nativeBillingSourceUuid(value.grantId)
    && typeof value.expectedRevision === "number" && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 1
    ? { operationId: value.operationId, grantId: value.grantId, expectedRevision: value.expectedRevision } : null;
}
