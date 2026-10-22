'use strict';

const { ProcessingRepository } = require('./processingRepository');
const { ProviderCredentials } = require('./providerCredentials');

function resolveEnabledProviderCredentials(database, config) {
  const providers = database.prepare('SELECT id FROM processing_providers WHERE enabled=1').all();
  const processing = new ProcessingRepository(database, { logMaxBytes: config.processingLogMaxBytes });
  const credentials = new ProviderCredentials({
    processing,
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
