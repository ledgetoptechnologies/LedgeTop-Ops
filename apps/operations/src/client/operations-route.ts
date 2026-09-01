export type OperationsPage="dashboard"|"operations"|"clients"|"notifications"|"airspace"|"delivery"|"viewer"|"team"|"administration";
export type OperationsSection="operations"|"projects"|"tasks"|"sops";
export type DeliverySection="delivery"|"incoming"|"links";

export const DATA_PAGE_PERMISSIONS = ["delivery.browse", "delivery.share.audit"] as const;

export function canAccessDataPage(permissions:readonly string[]):boolean{
  return DATA_PAGE_PERMISSIONS.some(permission=>permissions.includes(permission));
}

const PAGES:OperationsPage[]=["dashboard","operations","clients","notifications","airspace","delivery","viewer","team","administration"];

export function operationsLandingPath(permissions:readonly string[], _feedbackEnabled=false, _invitationReview=false):string{
  if(permissions.includes("operations.view"))return"/operations";
  if(permissions.includes("projects.view"))return"/operations/projects";
  if(permissions.includes("tasks.view"))return"/operations/tasks";
  if(permissions.includes("sops.view"))return"/operations/sops";
  return"/operations";
}

export function pathPage(pathname:string):OperationsPage{
  const parts=pathname.split("/").filter(Boolean), value=parts[0];
  if(value==="operations"&&parts[1]==="processing")return"viewer";
  if(value==="operations"&&parts[1]==="notifications")return"notifications";
  if(value==="operations"&&["client-requests","feedback","inbox","invitation-requests"].includes(parts[1]||""))return"clients";
  if(value==="clients")return"clients";
  if(value==="configurations")return"administration";
  if(value==="sops"||(value==="operations"&&parts[1]==="sops"))return"operations";
  if(value==="projects"||value==="tasks")return"operations";
  if(value==="jobs")return"delivery";
  return PAGES.includes(value as OperationsPage)?value as OperationsPage:"dashboard";
}

export function pathOperationsSection(pathname:string):OperationsSection{
  const parts=pathname.split("/").filter(Boolean);
  const value=parts[0]==="operations"?parts[1]:parts[0];
  return value==="projects"||value==="tasks"||value==="sops"?value:"operations";
}

export function operationsSectionPath(section:OperationsSection):string{
  return section==="operations"?"/operations":`/operations/${section}`;
}

export function canonicalClientPath(pathname:string):string{
  const parts=pathname.split("/").filter(Boolean);
  if(parts[0]!=="operations")return pathname;
  if(parts[1]==="client-requests")return parts[2]?`/clients/requests/${parts[2]}`:"/clients";
  if(parts[1]==="feedback")return `/clients/feedback${parts[2]?`/${parts[2]}`:""}`;
  if(parts[1]==="invitation-requests")return `/clients/invitation-requests${parts[2]?`/${parts[2]}`:""}`;
  if(parts[1]==="inbox")return"/clients";
  return pathname;
}

export function pathDeliverySection(pathname:string):DeliverySection{
  const parts=pathname.split("/").filter(Boolean);
  if(parts[0]==="delivery"&&parts[1]==="incoming")return"incoming";
  if(parts[0]==="delivery"&&parts[1]==="links")return"links";
  return"delivery";
}

export function deliverySectionPath(section:DeliverySection):string{
  return section==="incoming"?"/delivery/incoming":section==="links"?"/delivery/links":"/delivery";
}
