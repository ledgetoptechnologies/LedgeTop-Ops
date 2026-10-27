export interface ApprovedExecutorD1Config {
  target: { accountId: string; databaseId: string };
}
export interface ApprovedExecutorD1Result {
  success: true;
  results: any[];
  meta?: { changes: number };
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
    all(): Promise<ApprovedExecutorD1Result>;
    first(): Promise<any | null>;
    run(): Promise<ApprovedExecutorD1Result>;
  };
  batch(statements: Array<{ sql: string; params?: Array<string | number | null> }>): Promise<ApprovedExecutorD1Result[]>;
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
