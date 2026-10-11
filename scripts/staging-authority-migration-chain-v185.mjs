import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";

export const AUTHORITY_MIGRATION_CHAIN_184 = Object.freeze({
  count: 184,
  final: "0184_project_alpha_directory_relationship_generation_recovery.sql",
  names: "c6d567a0c4d9450cc867d99db6188dc54e7a827e581059d4714e7bf55b66bc15",
  contents: "52a45f212ce83e639a9ac3b9753a7122a56d897c187bf4dcbc741b4a059948cc",
});
export const AUTHORITY_MIGRATION_CHAIN_185 = Object.freeze({
  count: 185,
  final: "0185_project_alpha_directory_binding_generation_epochs.sql",
  names: "64348c16f468003bdb895f7855b5e5adf5e6c6fcefbfb915dbc4a93bdd2eb0ef",
  contents: "57ea88b00af9f6775f8750d11f13d56c1ed654ab7a466b48abbb9f2a00a28a32",
});
export const AUTHORITY_MIGRATION_CHAIN_186 = Object.freeze({
  count: 186,
  final: "0186_project_alpha_directory_conflict_evidence_binding.sql",
  names: "fde48e301d292d3a681d9a64b6028f026fae8bfa2eac8d0580cb72d46b56729a",
  contents: "ba268e73a2ca0e43dffab37f17a79d97f129a214880645de2727802d3f1cd4c5",
});
export const AUTHORITY_MIGRATION_CHAIN_187 = Object.freeze({
  count: 187,
  final: "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
  names: "ce00ad1a6b67cb8a7f0ed5e197ebd5fbdfabd2566dc3c402f1eee79302036951",
  contents: "3e0f92864210aab88c97220e50649a46d4ec8d6367262ea8f42ca75ce17a8567",
});
export const AUTHORITY_MIGRATION_CHAIN_190 = Object.freeze({
  count: 190,
  final: "0190_client_hub_native_project_preparation_authority.sql",
  names: "1c42cda3e4a770e59da42fecb2eaa9063abbe415eb500d5cde22b5755fc0ddbf",
  contents: "7e6f75368c5aed14209b092e026458894c6509324c8fdbedcf96c8df2ac0f260",
});
export const AUTHORITY_MIGRATION_CHAIN_192 = Object.freeze({
  count: 192,
  final: "0192_ops_service_definition_authority.sql",
  names: "2ac701ff1485af80b9b2edfcd0ce1b8cb9a413a925bf799d6531069eabb1f78c",
  contents: "148ff7d7b73ec90af81730f48520f2b7e4f0c1d80eebe32143c6a088d5f81e62",
});
export const AUTHORITY_MIGRATION_CHAIN_194 = Object.freeze({
  count: 194,
  final: "0194_operations_portal_native_delivery_terminal_cancellations.sql",
  names: "21797f48e9c38621119a6e78eb431594609ae5520aea9036f1e5db288a984a10",
  contents: "156c845b6185e89ae18533015055b0c0e09f6939348a165da68a1a3c10eabc25",
});
export const AUTHORITY_MIGRATION_CHAIN_195 = Object.freeze({
  count: 195,
  final: "0195_client_hub_native_project_current_owner_observation.sql",
  names: "3aecb42400d7a5e95687cca3eb256e880aa306dd4184747c0171f6301ffb71fd",
  contents: "46d06078251512d73faf9b96f277165d2a7a01e8c7d97d3e775dde0a167ef9da",
});
export const AUTHORITY_MIGRATION_CHAIN_196 = Object.freeze({
  count: 196,
  final: "0196_native_directory_maintenance_authority.sql",
  names: "c8f55f7a543d1e51d69abce753c2ce54a4640c35fd93c2769c8e971bb8162106",
  contents: "5dd50102b800eb3b49c9c5f41adb6f1ce44005425118b718ecc544e7f0b49c03",
});

export const AUTHORITY_MIGRATION_CHAIN_198 = Object.freeze({
  count: 198,
  final: "0198_native_directory_active_binding_revision_refresh.sql",
  names: "d88ba83a54c045e5eb416fb912324047d68160f9f198e6b56591f0f0909788f2",
  contents: "47369a1c36e64853cf8e82c874af734ff0c2745bef416cca9c3a01cae16f8409",
});

export const AUTHORITY_MIGRATION_CHAIN_199 = Object.freeze({
  count: 199,
  final: "0199_native_directory_profile_binding_continuations.sql",
  names: "7be05fcb2b54c3a345b76b1f37e3dbbf33c0f4278b6cabe8307a064549c33821",
  contents: "9fd14f1d7bb71719c532e11ed55963a05b962ae433fd1ead8be400752b550a53",
});

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const matches = (names, contents, chain) => names.length === chain.count
  && names.at(-1) === chain.final && sha(names.join("\n")) === chain.names
  && sha(contents.join("\n")) === chain.contents;

export function validateAuthorityMigrationChainV185(root, requestedNames, fail) {
  const directory = path.join(root, "apps", "operations", "migrations");
  const names = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const contents = names.map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("regular migration required");
    return `${name}\0${sha(fs.readFileSync(file))}`;
  });
  if (!matches(names, contents, AUTHORITY_MIGRATION_CHAIN_199)) fail("exact reviewed 0199 migration chain required");
  const requestedChain = requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_199.count
    ? AUTHORITY_MIGRATION_CHAIN_199
    : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_198.count
    ? AUTHORITY_MIGRATION_CHAIN_198
    : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_196.count
    ? AUTHORITY_MIGRATION_CHAIN_196
    : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_195.count
    ? AUTHORITY_MIGRATION_CHAIN_195
    : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_194.count
    ? AUTHORITY_MIGRATION_CHAIN_194
    : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_192.count
    ? AUTHORITY_MIGRATION_CHAIN_192
    : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_190.count
    ? AUTHORITY_MIGRATION_CHAIN_190
    : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_184.count
    ? AUTHORITY_MIGRATION_CHAIN_184
    : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_185.count ? AUTHORITY_MIGRATION_CHAIN_185
      : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_186.count ? AUTHORITY_MIGRATION_CHAIN_186
        : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_187.count ? AUTHORITY_MIGRATION_CHAIN_187 : null;
  if (!requestedChain || !same(requestedNames, names.slice(0, requestedChain.count))) fail("exact authority artifact migration chain required");
  return requestedChain;
}
