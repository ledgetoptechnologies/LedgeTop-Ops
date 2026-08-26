export type OperationsPage="dashboard"|"operations"|"clients"|"airspace"|"delivery"|"viewer"|"team"|"configurations"|"administration";
export type OperationsSection="operations"|"projects"|"tasks"|"sops"|"notifications"|"feedback"|"inbox"|"client-requests";
export type DeliverySection="delivery"|"incoming"|"links";

export const DATA_PAGE_PERMISSIONS = ["delivery.browse", "delivery.share.audit"] as const;

export function canAccessDataPage(permissions:readonly string[]):boolean{
  return DATA_PAGE_PERMISSIONS.some(permission=>permissions.includes(permission));
}

const PAGES:OperationsPage[]=["dashboard","operations","clients","airspace","delivery","viewer","team","configurations","administration"];

export function operationsLandingPath(permissions:readonly string[], feedbackEnabled=false):string{
  if(permissions.includes("operations.view"))return"/operations";
  if(permissions.includes("projects.view"))return"/operations/projects";
  if(permissions.includes("tasks.view"))return"/operations/tasks";
  if(permissions.includes("sops.view"))return"/operations/sops";
  if(permissions.includes("delivery.share.audit"))return"/operations/notifications";
  if(feedbackEnabled)return"/operations/feedback";
  if(permissions.includes("operations.manage") || permissions.includes("integrations.manage") && permissions.includes("administration.view"))return"/operations/inbox";
  return"/operations";
}

export function pathPage(pathname:string):OperationsPage{
  const parts=pathname.split("/").filter(Boolean), value=parts[0];
  if(value==="operations"&&parts[1]==="processing")return"viewer";
  if(value==="operations"&&parts[1]==="client-requests")return"clients";
  if(value==="clients")return"clients";
  if(value==="sops"||(value==="operations"&&parts[1]==="sops"))return"operations";
  if(value==="projects"||value==="tasks")return"operations";
  if(value==="jobs")return"delivery";
  return PAGES.includes(value as OperationsPage)?value as OperationsPage:"dashboard";
}

export function pathOperationsSection(pathname:string):OperationsSection{
  const parts=pathname.split("/").filter(Boolean);
  const value=parts[0]==="operations"?parts[1]:parts[0];
  return value==="projects"||value==="tasks"||value==="sops"||value==="notifications"||value==="feedback"||value==="inbox"||value==="client-requests"?value:"operations";
}

export function operationsSectionPath(section:OperationsSection):string{
  return section==="operations"?"/operations":`/operations/${section}`;
}

export function canonicalClientPath(pathname:string):string{
  const parts=pathname.split("/").filter(Boolean);
  if(parts[0]!=="operations"||parts[1]!=="client-requests")return pathname;
  return parts[2]?`/clients/requests/${parts[2]}`:"/clients";
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
