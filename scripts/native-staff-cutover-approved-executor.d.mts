export function runNativeStaffCutoverApprovedExecutor(options: { candidate: any; receipt: any; mode?: 'preview' | 'execute';
  preparedSha256?: string; getAccessToken?: () => Promise<string> | string; getBearerToken: () => Promise<string> | string;
  getAccessGroupReadCredential?: () => Promise<{schemaVersion:1;accountId:string;groupId:string;groupName:string;token:string}> | {schemaVersion:1;accountId:string;groupId:string;groupName:string;token:string};
  fetchImpl?: typeof fetch; now?: number }): Promise<any>;
export function wranglerBearerToken(): Promise<string>;
