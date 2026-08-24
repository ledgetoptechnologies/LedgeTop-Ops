export type OperationsPage="dashboard"|"operations"|"clients"|"sops"|"airspace"|"delivery"|"viewer"|"team"|"configurations"|"administration";
export type OperationsSection="operations"|"projects"|"tasks"|"client-requests";
export type DeliverySection="delivery"|"incoming"|"models"|"links";

const PAGES:OperationsPage[]=["dashboard","operations","clients","sops","airspace","delivery","viewer","team","configurations","administration"];

export function pathPage(pathname:string):OperationsPage{
  const parts=pathname.split("/").filter(Boolean), value=parts[0];
  if(value==="operations"&&parts[1]==="processing")return"viewer";
  if(value==="operations"&&parts[1]==="client-requests")return"clients";
  if(value==="clients")return"clients";
  if(value==="operations"&&parts[1]==="sops")return"sops";
  if(value==="projects"||value==="tasks")return"operations";
  if(value==="jobs")return"delivery";
  return PAGES.includes(value as OperationsPage)?value as OperationsPage:"dashboard";
}

export function pathOperationsSection(pathname:string):OperationsSection{
  const parts=pathname.split("/").filter(Boolean);
  const value=parts[0]==="operations"?parts[1]:parts[0];
  return value==="projects"||value==="tasks"||value==="client-requests"?value:"operations";
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
  if(parts[0]==="viewer")return"models";
  if(parts[0]==="delivery"&&parts[1]==="incoming")return"incoming";
  if(parts[0]==="delivery"&&parts[1]==="links")return"links";
  return"delivery";
}

export function deliverySectionPath(section:DeliverySection):string{
  return section==="models"?"/viewer":section==="incoming"?"/delivery/incoming":section==="links"?"/delivery/links":"/delivery";
}
