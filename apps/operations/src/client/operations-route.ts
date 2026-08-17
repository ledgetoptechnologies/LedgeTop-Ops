export type OperationsPage="dashboard"|"operations"|"client-requests"|"sops"|"airspace"|"delivery"|"viewer"|"team"|"administration";
export type OperationsSection="operations"|"projects"|"tasks"|"client-requests";

const PAGES:OperationsPage[]=["dashboard","operations","client-requests","sops","airspace","delivery","viewer","team","administration"];

export function pathPage(pathname:string):OperationsPage{
  const parts=pathname.split("/").filter(Boolean), value=parts[0];
  if(value==="operations"&&parts[1]==="processing")return"viewer";
  if(value==="operations"&&parts[1]==="client-requests")return"client-requests";
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
