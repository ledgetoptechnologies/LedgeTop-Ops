import { projectAlphaSourceName } from "@ltds/shared";

const GENERIC_PLACEHOLDER = /^project alpha(?: \((?:primary|secondary)\))?$/;
const PROJECT_ALPHA_SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Staff-facing source label: a meaningful server name wins; raw source IDs never render,
 * and generic product placeholders defer to the business name. Display only.
 */
export function sourceDisplayName(sourceName: string | null | undefined, sourceId: string | null | undefined): string {
  const name = sourceName?.trim();
  const normalized = name?.replace(/\s+/g, " ").toLowerCase();
  if (name && normalized && name !== sourceId?.trim() && !normalized.startsWith("project-alpha:")
    && !(GENERIC_PLACEHOLDER.test(normalized) && sourceId && PROJECT_ALPHA_SOURCE.test(sourceId))) return name;
  return projectAlphaSourceName(sourceId);
}
