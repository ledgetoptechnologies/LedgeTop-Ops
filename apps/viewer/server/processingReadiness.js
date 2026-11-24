'use strict';

const { readProviderCredential } = require('./processingRepository');
const { ProviderCredentials } = require('./providerCredentials');

function resolveEnabledProviderCredentials(database, config) {
  const providers = database.prepare('SELECT id FROM processing_providers WHERE enabled=1').all();
  // Readiness must not seed processing presets through the repository constructor.
  const credentials = new ProviderCredentials({
    processing: { getProviderCredential: (providerId) => readProviderCredential(database, providerId) },
    activeKeyId: config.providerCredentialsKeyId,
    keys: config.providerCredentialsKeys,
    legacyTokens: config.processingProviderTokens,
  });
  for (const provider of providers) {
    try { credentials.resolve(provider.id); }
    catch { throw new Error(`provider ${provider.id} credential is unavailable`); }
  }
  return providers.map((provider) => provider.id);
}

module.exports = { resolveEnabledProviderCredentials };
