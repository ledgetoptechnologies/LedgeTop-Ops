// Types for viewer-readback.mjs (QA fixture for #698, not for merge).
export interface ViewerFixtureDatabase { sqlite: unknown; head: { version: number; name: string }; seedChangedSchema: boolean; repository: unknown; processing: unknown }
export const VIEWER_SCHEMA: { version: number; name: string };
export function buildViewerDatabase(options?: { publication?: boolean }): ViewerFixtureDatabase;
export function catalogResponse(processing: unknown, projectId: string, options?: { taskId?: string; limit?: number }): unknown;
export interface SeededViewerService {
  clientDeliveryCatalog(input: { projectId: string; taskId?: string; cursor?: string; limit?: number }): any;
  createSession(input: Record<string, any>): any;
  revokePublishedSessionSourceAuthorization(input: { sourceAuthorization: { type: string; id: string; version: number } }): any;
}
export function viewerServiceFromSeed(viewer: ViewerFixtureDatabase, options?: { sessionTtlSeconds?: number; grantTtlSeconds?: number }): SeededViewerService;
export function viewerDependencies(caseItem: Record<string, any>): string[];
export function runViewerReadback(): { failures: string[]; schema: { version: number; name: string }; dependencies: Record<string, string[]> };
