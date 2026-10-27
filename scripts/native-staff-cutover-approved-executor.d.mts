export function runNativeStaffCutoverApprovedExecutor(options: { candidate: any; receipt: any; mode?: 'preview' | 'execute';
  preparedSha256?: string; getAccessToken?: () => Promise<string> | string; getBearerToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch; now?: number }): Promise<any>;
export function wranglerBearerToken(): Promise<string>;
