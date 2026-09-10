import { hasBlockedIncomingMagic, validateIncomingFile } from "./incoming-security";

export const INCOMING_BASIC_SAMPLE_BYTES = 4096;

export type IncomingBasicObjectIdentity = {
  objectEtag: string;
  objectBytes: number;
  objectVersion: string;
};

/**
 * A bounded format check, NOT a malware verdict or a server pickup receipt.
 * The caller must authorize the upload and obtain the sample from an exact,
 * conditional R2 range read starting at zero. Passing this helper does not
 * authorize publication by itself; eligibility must be checked again then.
 */
export function validateIncomingBasicSample(input: {
  originalName: string;
  contentType: string;
  declaredBytes: number;
  expected: IncomingBasicObjectIdentity;
  observed: IncomingBasicObjectIdentity;
  sample: Uint8Array;
}): IncomingBasicObjectIdentity & { checkVersion: "basic-v1" } {
  validateIncomingFile(input.originalName, input.contentType, input.declaredBytes);
  const expected = input.expected;
  const observed = input.observed;
  if (!/^[a-f0-9-]{1,128}$/i.test(expected.objectEtag)
    || !expected.objectVersion || expected.objectVersion.length > 1024
    || !Number.isSafeInteger(expected.objectBytes)
    || expected.objectBytes !== input.declaredBytes
    || observed.objectBytes !== expected.objectBytes
    || observed.objectEtag !== expected.objectEtag
    || observed.objectVersion !== expected.objectVersion) {
    throw new Error("incoming_basic_object_changed");
  }
  if (input.sample.byteLength !== Math.min(INCOMING_BASIC_SAMPLE_BYTES, expected.objectBytes)) {
    throw new Error("incoming_basic_sample_incomplete");
  }
  if (hasBlockedIncomingMagic(input.sample)) throw new Error("incoming_basic_signature_rejected");
  return { ...expected, checkVersion: "basic-v1" };
}
