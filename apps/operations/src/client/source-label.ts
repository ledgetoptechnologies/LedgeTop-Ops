import { projectAlphaSourceName } from "@ltds/shared";

/** Staff-facing source label: a meaningful server name wins; raw source IDs never render. Display only. */
export function sourceDisplayName(sourceName: string | null | undefined, sourceId: string | null | undefined): string {
  const name = sourceName?.trim();
  if (name && name !== sourceId?.trim() && !name.toLowerCase().startsWith("project-alpha:")) return name;
  return projectAlphaSourceName(sourceId);
}
