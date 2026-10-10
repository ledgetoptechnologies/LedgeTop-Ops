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
  if (!matches(names, contents, AUTHORITY_MIGRATION_CHAIN_187)) fail("exact reviewed 0187 migration chain required");
  const requestedChain = requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_184.count
    ? AUTHORITY_MIGRATION_CHAIN_184
    : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_185.count ? AUTHORITY_MIGRATION_CHAIN_185
      : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_186.count ? AUTHORITY_MIGRATION_CHAIN_186
        : requestedNames?.length === AUTHORITY_MIGRATION_CHAIN_187.count ? AUTHORITY_MIGRATION_CHAIN_187 : null;
  if (!requestedChain || !same(requestedNames, names.slice(0, requestedChain.count))) fail("exact authority artifact migration chain required");
  return requestedChain;
}
