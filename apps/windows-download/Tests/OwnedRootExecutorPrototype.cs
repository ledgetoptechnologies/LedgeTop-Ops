// Test-only prototype. It is not referenced by the provider or packaged app.
// Work owns its resources inside its delegate and returns true only with an
// explicit safe-cleanup receipt. Faults or a false receipt quarantine the root.
internal sealed class OwnedRootExecutorPrototype
{
    private sealed class Item(Func<Task<bool>> work)
    {
        internal readonly Func<Task<bool>> Work = work;
        internal readonly TaskCompletionSource Done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal LinkedListNode<Item>? Node;
        internal bool Running;
    }
    private sealed class Root
    {
        internal readonly LinkedList<Item> Queue = new();
        internal Item? Running;
        internal bool Quarantined;
    }
    private readonly object sync = new();
    private readonly Dictionary<string, Root> roots = new(StringComparer.Ordinal);
    private readonly int maximumRoots, maximumQueuedPerRoot;
    internal OwnedRootExecutorPrototype(int maximumRoots, int maximumQueuedPerRoot)
    {
        if (maximumRoots < 1 || maximumQueuedPerRoot < 1) throw new ArgumentOutOfRangeException();
        this.maximumRoots = maximumRoots; this.maximumQueuedPerRoot = maximumQueuedPerRoot;
    }

    internal async Task RunAsync(string key, Func<Task<bool>> work, TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(key); ArgumentNullException.ThrowIfNull(work);
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromMinutes(10)) throw new ArgumentOutOfRangeException(nameof(timeout));
        cancellationToken.ThrowIfCancellationRequested();
        var item = new Item(work); Root root;
        lock (sync) {
            if (!roots.TryGetValue(key, out root!)) {
                if (roots.Count >= maximumRoots) throw new InvalidOperationException("Root capacity reached.");
                roots.Add(key, root = new());
            }
            if (root.Quarantined) throw new InvalidOperationException("Root is quarantined.");
            if (root.Queue.Count >= maximumQueuedPerRoot) throw new InvalidOperationException("Queue capacity reached.");
            item.Node = root.Queue.AddLast(item);
            StartNextLocked(key, root);
        }
        try { await item.Done.Task.WaitAsync(timeout, cancellationToken).ConfigureAwait(false); }
        catch (Exception e) when (e is TimeoutException or OperationCanceledException) {
            var completed = false;
            lock (sync) {
                // A completed operation wins a simultaneous timeout/cancellation.
                completed = item.Done.Task.IsCompleted;
                if (!completed) {
                    if (item.Node is not null) { root.Queue.Remove(item.Node); item.Node = null; item.Done.TrySetCanceled(); }
                    else if (item.Running) {
                        root.Quarantined = true;
                        while (root.Queue.First is { } node) {
                            root.Queue.RemoveFirst(); node.Value.Node = null;
                            node.Value.Done.TrySetException(new InvalidOperationException("Root is quarantined."));
                        }
                    }
                }
            }
            if (completed) { await item.Done.Task.ConfigureAwait(false); return; }
            // Observe a fault that occurs after its caller has timed out.
            _ = item.Done.Task.ContinueWith(t => _ = t.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            throw;
        }
    }
    private void StartNextLocked(string key, Root root)
    {
        if (root.Running is not null || root.Queue.First is not { } node) return;
        root.Queue.RemoveFirst(); var item = node.Value; item.Node = null; item.Running = true; root.Running = item;
        _ = Task.Run(async () => {
            Exception? failure = null; var cleaned = false;
            try { cleaned = await item.Work().ConfigureAwait(false); } catch (Exception error) { failure = error; }
            lock (sync) {
                item.Running = false; root.Running = null;
                if (!cleaned) {
                    root.Quarantined = true;
                    while (root.Queue.First is { } node) {
                        root.Queue.RemoveFirst(); node.Value.Node = null;
                        node.Value.Done.TrySetException(new InvalidOperationException("Root cleanup is unverified."));
                    }
                }
                // A quarantined root is retired only with explicit evidence that
                // the operation and resource cleanup both completed safely.
                if (cleaned && (root.Quarantined || root.Queue.Count == 0)) roots.Remove(key);
                else if (!root.Quarantined) StartNextLocked(key, root);
                if (!cleaned && failure is null) failure = new InvalidOperationException("Root cleanup is unverified.");
                if (failure is null) item.Done.TrySetResult(); else item.Done.TrySetException(failure);
            }
        });
    }
}
