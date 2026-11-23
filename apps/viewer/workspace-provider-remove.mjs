// Removing a processing node archives it on the server: its token is erased and
// it leaves the node list, new-task choices and polling, while past tasks keep
// its name. The UI cannot undo it, so the confirmation names the node.

export function removeProviderConfirmation(provider) {
  const name = String(provider?.displayName || 'this node');
  return {
    message: `Remove "${name}"? Its saved token is erased and it leaves the node list and new-task choices. Past tasks keep its name. This can't be undone here.`,
    options: { title: 'Remove node', submitLabel: 'Remove node', destructive: true },
  };
}

export async function removeProcessingProvider({ provider, confirm, mutate }) {
  if (!provider?.id) return false;
  const { message, options } = removeProviderConfirmation(provider);
  if (!await confirm(message, options)) return false;
  const result = await mutate(
    `/api/v1/processing/providers/${encodeURIComponent(provider.id)}`,
    { method: 'DELETE', body: {} },
    `Removed ${provider.displayName || 'node'}`,
  );
  return Boolean(result?.removed);
}

// A task's provider name: the live node when it still exists, otherwise the
// name the server recorded on the attempt (marked when the node was removed).
export function attemptProviderName(attempt, providers = []) {
  const live = providers.find((provider) => provider.id === attempt?.providerId)?.displayName;
  if (live) return live;
  const recorded = attempt?.providerDisplayName;
  if (!recorded) return null;
  return attempt.providerRemoved ? `${recorded} (removed)` : recorded;
}
