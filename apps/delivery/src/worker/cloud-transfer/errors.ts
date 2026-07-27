export interface CloudTransferFailure {
  code: string;
  message: string;
  retryable: boolean;
}

const FAILURES: Record<string, CloudTransferFailure> = {
  "authorization-required": { code: "authorization-required", message: "Connect your cloud account to continue.", retryable: false },
  "authorization-expired": { code: "authorization-expired", message: "Your cloud authorization expired. Connect your account again.", retryable: false },
  "share-revoked": { code: "share-revoked", message: "This delivery is no longer available.", retryable: false },
  "empty-selection": { code: "empty-selection", message: "No transferable files were found.", retryable: false },
  "file-limit": { code: "file-limit", message: "This delivery contains too many files. Choose a smaller selection.", retryable: false },
  "byte-limit": { code: "byte-limit", message: "This delivery is too large to copy in one job. Choose a smaller selection.", retryable: false },
  "source-changed": { code: "source-changed", message: "The source file changed while it was being copied. Start a new transfer.", retryable: false },
  "source-missing": { code: "source-missing", message: "The source file is no longer available.", retryable: false },
  "provider-rate-limited": { code: "provider-rate-limited", message: "The cloud provider is busy. The transfer will retry automatically.", retryable: true },
  "provider-unavailable": { code: "provider-unavailable", message: "The cloud provider is temporarily unavailable.", retryable: true },
  "provider-quota": { code: "provider-quota", message: "The destination account does not have enough available storage.", retryable: false },
  "destination-unavailable": { code: "destination-unavailable", message: "The selected destination is no longer available.", retryable: false },
  "cancelled": { code: "cancelled", message: "The remaining files were cancelled.", retryable: false },
  "transfer-failed": { code: "transfer-failed", message: "The file could not be copied. Please try again.", retryable: true },
};

export function friendlyCloudFailure(code?: string | null): CloudTransferFailure {
  return (code && FAILURES[code]) || FAILURES["transfer-failed"]!;
}

export function classifyCloudFailure(error: unknown): CloudTransferFailure {
  const raw = error instanceof Error ? error.message : String(error);
  if (FAILURES[raw]) return FAILURES[raw]!;
  if (/etag|precondition|source.changed/i.test(raw)) return FAILURES["source-changed"]!;
  if (/not.found|source.missing/i.test(raw)) return FAILURES["source-missing"]!;
  if (/429|rate.?limit|retry.after/i.test(raw)) return FAILURES["provider-rate-limited"]!;
  if (/quota|insufficient.storage/i.test(raw)) return FAILURES["provider-quota"]!;
  if (/destination|folder.*not.found/i.test(raw)) return FAILURES["destination-unavailable"]!;
  if (/401|invalid.grant|expired.*token|authorization/i.test(raw)) return FAILURES["authorization-expired"]!;
  if (/5\d\d|temporar|unavailable|network/i.test(raw)) return FAILURES["provider-unavailable"]!;
  return FAILURES["transfer-failed"]!;
}

export function safeCloudError(error: unknown): { code: string; message: string; retryable: boolean } {
  const failure = classifyCloudFailure(error);
  return { code: failure.code, message: failure.message, retryable: failure.retryable };
}
