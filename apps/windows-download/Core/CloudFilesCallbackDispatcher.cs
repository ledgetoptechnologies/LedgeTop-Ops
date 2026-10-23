namespace LedgeTop.WindowsDownload;

// This is a trusted composition seam, never an adapter selected by callback bytes.
// The native implementation owns and joins its provider-progress keepalive before returning.
internal delegate Task CloudFilesCallbackHydrator(PlaceholderHydrationCoordinator coordinator, PlaceholderIdentity identity,
    CloudFilesOperationContext context, CancellationToken cancellationToken);
internal readonly record struct CloudFilesRequestKey(long ConnectionKey, long TransferKey, long RequestKey);
internal enum CloudFilesCancelResult { NotFound, UnsupportedRange, Drained }

/// <summary>Unregistered callback lifecycle rehearsal. Copies borrowed identity data before any await.
/// No native callbacks, roots, connections, browser sign-in or raw transfer sinks are exposed.</summary>
internal sealed class CloudFilesCallbackDispatcher : IAsyncDisposable
{
    private sealed record Entry(byte[] Identity, CloudFilesOperationContext Context, CancellationTokenSource Cancellation,
        TaskCompletionSource Completion) { internal readonly object CancelSync = new(); internal bool Ending; internal Task? CancelTask; }
    private readonly object sync = new();
    private readonly Dictionary<CloudFilesRequestKey, Entry> requests = [];
    private readonly PlaceholderHydrationCoordinator coordinator;
    private readonly CloudFilesCallbackHydrator hydrate;
    private readonly string channel, alias, origin, principal;
    private readonly long connection;
    private readonly int maximumRequests;
    private bool stopping;
    private Task? stopTask;

    internal CloudFilesCallbackDispatcher(IQueuedDownloadSource source, string channel, string principal, long connection,
        string stateRoot, CloudFilesCallbackHydrator hydrate, int maximumRequests = 256)
    {
        ArgumentNullException.ThrowIfNull(principal);
        if (channel is not ("pilot" or "stable") || !System.Text.RegularExpressions.Regex.IsMatch(principal, "\\Aodqp1_[a-f0-9]{64}\\z")
            || maximumRequests is < 1 or > 4096) throw new TransferException("Callback provider context is invalid.");
        this.channel = channel; this.principal = principal; this.connection = connection; this.maximumRequests = maximumRequests;
        alias = source.Alias; origin = source.Origin.GetLeftPart(UriPartial.Authority);
        this.hydrate = hydrate ?? throw new ArgumentNullException(nameof(hydrate));
        coordinator = new(source, channel, stateRoot);
    }

    internal Task FetchDataAsync(ReadOnlyMemory<byte> borrowedIdentity, CloudFilesOperationContext context)
    {
        if (borrowedIdentity.Length > 4096) throw new TransferException("Callback identity exceeds native bounds.");
        // Callback-owned memory and mutable caller buffers must not survive into asynchronous work.
        var identityBytes = borrowedIdentity.ToArray();
        var identity = PlaceholderIdentity.Decode(identityBytes);
        if (identity.Channel != channel || identity.SourceAlias != alias || identity.Origin != origin || identity.PrincipalId != principal
            || context.ConnectionKey != connection || context.FileSize != identity.Length || context.RequiredOffset < 0
            || context.RequiredOffset > identity.Length) throw new TransferException("Callback does not match this provider context.");
        var length = context.RequiredLength == -1 ? identity.Length - context.RequiredOffset : context.RequiredLength;
        if (length <= 0 || length > identity.Length - context.RequiredOffset || context.RequiredOffset % 4096 != 0
            || (length % 4096 != 0 && length != identity.Length - context.RequiredOffset)) throw new TransferException("Callback range is unsupported.");
        var ownedContext = context with { RequiredLength = length };
        var key = Key(ownedContext);
        Entry entry;
        lock (sync) {
            if (stopping) throw new TransferException("Callback provider is stopping.");
            if (requests.TryGetValue(key, out var existing)) {
                if (existing.Context != ownedContext || !existing.Identity.AsSpan().SequenceEqual(identityBytes))
                    throw new TransferException("Callback request key was reused for different data.");
                return existing.Completion.Task;
            }
            // Bound only in-flight work. Native keys (including RequestKey zero) may be reused after terminal drain.
            if (requests.Count >= maximumRequests) throw new TransferException("Callback active request limit reached.");
            entry = new(identityBytes, ownedContext, new(), new(TaskCreationOptions.RunContinuationsAsynchronously));
            requests.Add(key, entry);
        }
        _ = RunAsync(entry, identity); // RunAsync catches every outcome and completes the tracked task.
        return entry.Completion.Task;
    }

    internal async Task<CloudFilesCancelResult> CancelFetchDataAsync(CloudFilesRequestKey key, long offset, long length,
        CancellationToken waitCancellation = default)
    {
        Entry? entry;
        lock (sync) {
            if (key.ConnectionKey != connection || !requests.TryGetValue(key, out entry)) return CloudFilesCancelResult.NotFound;
            // Native CANCEL may describe a subset. This first unregistered slice cannot drop still-needed intervals.
            if (offset != entry.Context.RequiredOffset || length != entry.Context.RequiredLength) return CloudFilesCancelResult.UnsupportedRange;
        }
        await Observe(RequestCancel(entry)).WaitAsync(waitCancellation); // No callback runs under the dispatcher lock.
        await Observe(entry.Completion.Task).WaitAsync(waitCancellation);
        return CloudFilesCancelResult.Drained;
    }

    internal Task StopAsync(CancellationToken waitCancellation = default)
    {
        Task task;
        lock (sync) {
            if (stopTask is null) {
                stopping = true;
                // Yield first: cancellation handlers and worker completion may acquire sync.
                stopTask = DrainAsync(requests.Values.ToArray());
            }
            task = stopTask;
        }
        return task.WaitAsync(waitCancellation);
    }
    private async Task DrainAsync(Entry[] entries)
    {
        await Task.Yield();
        await Task.WhenAll(entries.Select(entry => Observe(RequestCancel(entry))));
        await Task.WhenAll(entries.Select(entry => Observe(entry.Completion.Task)));
        // Includes the native hydrator's joined keepalive and terminal operation lifetime.
        coordinator.Dispose();

    }
    private async Task RunAsync(Entry entry, PlaceholderIdentity identity)
    {
        var token = entry.Cancellation.Token;
        Exception? failure = null; var cancelled = false;
        try {
            await hydrate(coordinator, identity, entry.Context, token);
        } catch (OperationCanceledException) when (entry.Cancellation.IsCancellationRequested) {
            cancelled = true;
        } catch {
            failure = new TransferException("Callback hydration unavailable; no automatic login or retry was attempted.");
        }
        // The hydrator's native terminal call and keepalive are now fully joined.
        // Retirement permits a later callback with the same opaque keys to authorize a new range.
        Task cancellationDrain;
        lock (entry.CancelSync) { entry.Ending = true; cancellationDrain = entry.CancelTask ?? Task.CompletedTask; }
        await Observe(cancellationDrain); // CTS.Dispose must not race executing cancellation observers.
        entry.Cancellation.Dispose();
        lock (sync) {
            requests.Remove(Key(entry.Context));
            if (cancelled) entry.Completion.TrySetCanceled(token);
            else if (failure is not null) entry.Completion.TrySetException(failure);
            else entry.Completion.TrySetResult();
        }
    }
    private static Task RequestCancel(Entry entry) {
        lock (entry.CancelSync) {
            if (entry.Ending) return Task.CompletedTask;
            // CancelAsync returns a tracked completion for all token observers. No callback is invoked under sync.
            return entry.CancelTask ??= entry.Cancellation.CancelAsync();
        }
    }
    private static async Task Observe(Task task) { try { await task; } catch { } }
    private static CloudFilesRequestKey Key(CloudFilesOperationContext c) => new(c.ConnectionKey, c.TransferKey, c.RequestKey);
    public async ValueTask DisposeAsync() => await StopAsync();
}
