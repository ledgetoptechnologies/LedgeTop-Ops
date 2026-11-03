#if LEDGETOP_CACHE_RACE_TEST
namespace LedgeTop.WindowsDownload;

// Lifetime prerequisite only: deliberately not connected to the provider and
// does not expose the receipt or a cached stream to its callers.
internal sealed class ExperimentalSharedReceipt : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly PlaceholderHydrationCoordinator coordinator;
    private readonly PlaceholderIdentity identity;
    private readonly ExperimentalReservationOwner.LeaseReceipt receipt;
    private readonly TaskCompletionSource drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Task? disposal;
    private int users;
    private bool closing;

    private ExperimentalSharedReceipt(PlaceholderHydrationCoordinator coordinator, PlaceholderIdentity identity, ExperimentalReservationOwner.LeaseReceipt receipt)
    { this.coordinator = coordinator; this.identity = identity; this.receipt = receipt; }

    internal static async Task<ExperimentalSharedReceipt> CreateAsync(PlaceholderHydrationCoordinator coordinator, PlaceholderIdentity identity, CancellationToken token = default)
    {
        var receipt = await coordinator.ExperimentalPrepareReceiptAsync(identity, token).ConfigureAwait(false);
        try {
            if (!await coordinator.ExperimentalAuthorizeAndStageAsync(identity, receipt, token).ConfigureAwait(false))
                throw new TransferException("Synthetic shared reservation unavailable.");
            return new ExperimentalSharedReceipt(coordinator, identity, receipt);
        } catch {
            // Receipt retains its own uncertain resources if staging failed.
            receipt.Dispose();
            throw;
        }
    }

    internal async Task<Request> JoinAsync(PlaceholderIdentity requested, CancellationToken token = default)
    {
        lock (gate) {
            if (closing) throw new ObjectDisposedException(nameof(ExperimentalSharedReceipt));
            if (requested != identity) throw new ResourceUnavailableException();
            checked { users++; }
        }
        try {
            await coordinator.ExperimentalReauthorizeStagedAsync(requested, receipt, token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            return new Request(this);
        } catch { Leave(); throw; }
    }

    private void Leave()
    {
        lock (gate) {
            if (--users < 0) throw new InvalidOperationException("Shared receipt reference underflow.");
            if (closing && users == 0) drained.TrySetResult();
        }
    }

    internal sealed class Request : IDisposable
    {
        private ExperimentalSharedReceipt? owner;
        internal Request(ExperimentalSharedReceipt owner) => this.owner = owner;
        public void Dispose() => Interlocked.Exchange(ref owner, null)?.Leave();
    }

    public ValueTask DisposeAsync()
    {
        lock (gate) {
            if (disposal is not null) return new ValueTask(disposal);
            closing = true;
            if (users == 0) drained.TrySetResult();
            disposal = DisposeCoreAsync();
            return new ValueTask(disposal);
        }
    }

    private async Task DisposeCoreAsync()
    {
        await drained.Task.ConfigureAwait(false);
        receipt.RemoveSyntheticReservationForTest(coordinator.ExperimentalRootForTest, identity.ScopeKey + identity.CacheKey);
        receipt.Dispose();
    }
}
#endif
