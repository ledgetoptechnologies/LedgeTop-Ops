export interface ApprovedExecutorD1Config {
  target: { accountId: string; databaseId: string };
}
export function createApprovedExecutorD1Provider(options: {
  config: ApprovedExecutorD1Config;
  getBearerToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): {
  assertTarget(): Promise<{ readonly databaseId: string; readonly name: string }>;
  prepare(sql: string): {
    readonly sql: string;
    readonly params: unknown[];
    bind(...values: Array<string | number | null>): any;
    all(): Promise<{ success: true; results: any[] }>;
    first(): Promise<any | null>;
    run(): Promise<{ success: true; results: any[] }>;
  };
  batch(statements: Array<{ sql: string; params?: Array<string | number | null> }>): Promise<Array<{ success: true; results: any[] }>>;
};
export function runNativeStaffBootstrapApprovedExecutor(options: {
  artifact: any;
  receipt: any;
  mode?: 'preview' | 'execute';
  preparedSha256?: string;
  getAccessToken: () => Promise<string> | string;
  getBearerToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<any>;
