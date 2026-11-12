namespace LedgeTop.Files.Explorer;

internal enum AvailabilityScanTrigger { Notification, Fallback }

// Notifications are bounded wake hints, never file names or availability receipts.
// One scanner, one pending signal, no per-event task and no abandoned timeout waiter.
internal sealed class AvailabilityScanWake : IAsyncDisposable
{
    internal static readonly TimeSpan FallbackInterval = TimeSpan.FromSeconds(2);
    internal static readonly TimeSpan CoalescingInterval = TimeSpan.FromMilliseconds(100);
    private readonly object sync = new();
    private readonly SemaphoreSlim pulse = new(0, 1);
    private readonly CancellationTokenSource stop = new();
    private readonly TimeProvider clock;
    private IDisposable? notifications;
    private Task<AvailabilityScanTrigger>? waiting;
    private Task? closing;
    private Exception? cleanupFailure;
    private bool failed, stopped;
    internal bool FallbackOnly { get { lock (sync) return failed; } }

    internal static AvailabilityScanWake ForRoot(string root) => new((changed, error) => RootWatcher.Create(root, changed, error));

    internal AvailabilityScanWake(Func<Action, Action, IDisposable> createNotifications, TimeProvider? clock = null)
    {
        this.clock = clock ?? TimeProvider.System;
        IDisposable? candidate = null;
        try {
            candidate = createNotifications(Pulse, NotificationsFailed);
            lock (sync) { if (!failed) { notifications = candidate; candidate = null; } }
        } catch { lock (sync) failed = true; }
        finally { DisposeNotifications(candidate); }
    }

    private void Pulse()
    {
        lock (sync) {
            if (stopped || failed) return;
            if (pulse.CurrentCount == 0) pulse.Release();
        }
    }
    private void NotificationsFailed()
    {
        // Retain the one watcher for final disposal, but ignore every subsequent hint.
        // No callback performs native disconnect, filesystem work, restart or async work.
        lock (sync) { if (!stopped) failed = true; }
    }
    private void DisposeNotifications(IDisposable? source)
    {
        try { source?.Dispose(); }
        catch (Exception error) { lock (sync) cleanupFailure ??= error; }
    }

    internal Task<AvailabilityScanTrigger> WaitForNextScanAsync(CancellationToken token = default)
    {
        lock (sync) {
            if (stopped) return Task.FromCanceled<AvailabilityScanTrigger>(new CancellationToken(true));
            if (waiting is { IsCompleted: false }) throw new InvalidOperationException("Only one availability scanner may wait.");
            return waiting = WaitCoreAsync(token);
        }
    }
    private async Task<AvailabilityScanTrigger> WaitCoreAsync(CancellationToken token)
    {
        using var deadline = new CancellationTokenSource(FallbackInterval, clock);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, stop.Token, deadline.Token);
        try {
            await pulse.WaitAsync(linked.Token).ConfigureAwait(false);
            // Fixed coalescing rather than resetting on each event: a busy folder cannot
            // postpone scanning indefinitely, and the two-second deadline still wins.
            await Task.Delay(CoalescingInterval, clock, linked.Token).ConfigureAwait(false);
            lock (sync) {
                linked.Token.ThrowIfCancellationRequested();
                _ = pulse.Wait(0); // Consume at most the one coalesced signal under the pulse lock.
            }
            return AvailabilityScanTrigger.Notification;
        } catch (OperationCanceledException) when (deadline.IsCancellationRequested && !token.IsCancellationRequested && !stop.IsCancellationRequested) {
            return AvailabilityScanTrigger.Fallback;
        }
    }

    // This is the exact provider composition seam: inspect only a frozen manifest.
    // Event paths never enter this method or become new work/source authorization.
    internal async Task RunScannerAsync(IEnumerable<string> manifest, Action<string> inspectKnownFile, CancellationToken token)
    {
        var paths = manifest.Take(1001).ToArray();
        if (paths.Length > 1000) throw new ArgumentException("Availability manifest is too large.");
        await RunScannerAsync(() => paths, inspectKnownFile, token).ConfigureAwait(false);
    }

    // The caller must return a stable immutable committed snapshot for the duration of
    // copying. Notifications never add paths, and membership is not authority. If a
    // mistakenly mutable collection changes during copying, skip this scan and retry later.
    internal async Task RunScannerAsync(Func<IReadOnlyList<string>> manifestSnapshot, Action<string> inspectKnownFile, CancellationToken token)
    {
        try {
            while (!token.IsCancellationRequested && !stop.IsCancellationRequested) {
                string[] paths;
                try { paths = manifestSnapshot().Take(1001).ToArray(); }
                catch (InvalidOperationException) {
                    await WaitForNextScanAsync(token).ConfigureAwait(false);
                    continue;
                }
                if (paths.Length > 1000) throw new ArgumentException("Availability manifest is too large.");
                foreach (var relative in paths) {
                    token.ThrowIfCancellationRequested();
                    if (stop.IsCancellationRequested) return;
                    inspectKnownFile(relative);
                }
                await WaitForNextScanAsync(token).ConfigureAwait(false);
            }
        } catch (OperationCanceledException) when (token.IsCancellationRequested || stop.IsCancellationRequested) { }
    }

    // Synchronous hint-admission shutdown only. Never await scanner/native work before
    // the provider has disconnected callbacks that can release blocking hydration.
    internal void Stop()
    {
        lock (sync) { if (stopped) return; stopped = true; }
        // Close hint admission now; defer watcher Dispose until AFTER callback/native
        // worker drain, so watcher cleanup cannot block the required disconnect order.
        try { stop.Cancel(); } catch (Exception error) { lock (sync) cleanupFailure ??= error; }
    }
    public ValueTask DisposeAsync()
    {
        TaskCompletionSource completion;
        lock (sync) {
            if (closing is not null) return new(closing);
            completion = new(TaskCreationOptions.RunContinuationsAsynchronously); closing = completion.Task;
        }
        _ = CompleteDisposeAsync(completion);
        return new(completion.Task);
    }
    private async Task CompleteDisposeAsync(TaskCompletionSource completion)
    {
        try {
            Stop();
            Task? pending; lock (sync) pending = waiting;
            if (pending is not null) { try { await pending.ConfigureAwait(false); } catch (OperationCanceledException) { } }
            IDisposable? retired; lock (sync) { retired = notifications; notifications = null; }
            DisposeNotifications(retired);
            pulse.Dispose(); stop.Dispose();
            if (cleanupFailure is not null) throw new IOException("Availability notifications could not confirm shutdown.", cleanupFailure);
            completion.TrySetResult();
        } catch (Exception error) { completion.TrySetException(error); }
    }

    private sealed class RootWatcher : IDisposable
    {
        private FileSystemWatcher? watcher;
        private readonly FileSystemEventHandler changed;
        private readonly ErrorEventHandler error;
        private RootWatcher(FileSystemWatcher watcher, Action changed, Action error)
        {
            this.watcher = watcher;
            this.changed = (_, _) => changed(); this.error = (_, _) => error();
            watcher.Changed += this.changed; watcher.Error += this.error;
        }
        internal static IDisposable Create(string root, Action changed, Action error)
        {
            var watcher = new FileSystemWatcher(root) { NotifyFilter = NotifyFilters.Attributes, IncludeSubdirectories = true, Filter = "*" };
            var lease = new RootWatcher(watcher, changed, error);
            try { watcher.EnableRaisingEvents = true; return lease; }
            catch { lease.Dispose(); throw; }
        }
        public void Dispose()
        {
            var retired = Interlocked.Exchange(ref watcher, null);
            if (retired is null) return;
            retired.Changed -= changed; retired.Error -= error;
            retired.Dispose();
        }
    }
}
