'use strict';

// Stored only in the existing private auth_env_key column. It distinguishes
// an explicitly probed no-auth endpoint from a provider whose credential is
// missing or was cleared.
const NO_AUTH_MARKER = '__ltds_provider_no_auth__';

module.exports = { NO_AUTH_MARKER };
