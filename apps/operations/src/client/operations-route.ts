export type OperationsPage="dashboard"|"operations"|"airspace"|"delivery"|"team"|"administration";
export type OperationsSection="operations"|"projects"|"tasks";

const PAGES:OperationsPage[]=["dashboard","operations","airspace","delivery","team","administration"];

export function pathPage(pathname:string):OperationsPage{
  const value=pathname.split("/").filter(Boolean)[0];
  if(value==="projects"||value==="tasks")return"operations";
  return PAGES.includes(value as OperationsPage)?value as OperationsPage:"dashboard";
}

export function pathOperationsSection(pathname:string):OperationsSection{
  const parts=pathname.split("/").filter(Boolean);
  const value=parts[0]==="operations"?parts[1]:parts[0];
  return value==="projects"||value==="tasks"?value:"operations";
}

export function operationsSectionPath(section:OperationsSection):string{
  return section==="operations"?"/operations":`/operations/${section}`;
}
