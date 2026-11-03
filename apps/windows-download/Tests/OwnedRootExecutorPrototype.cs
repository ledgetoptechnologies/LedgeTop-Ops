// Test-only prototype. It is not referenced by the provider or packaged app.
// Work owns its resources inside its delegate and returns true only with an
// explicit safe-cleanup receipt. Faults or a false receipt quarantine the root.
internal sealed class OwnedRootExecutorPrototype
{
    internal sealed class Item(Func<SyntheticCommitScope, Task<bool>> work)
    {
        internal readonly Func<SyntheticCommitScope, Task<bool>> Work = work;
        internal readonly TaskCompletionSource Done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal LinkedListNode<Item>? Node;
        internal bool Running;
        internal bool Abandoned;
    }
    internal sealed class Root
    {
        internal readonly LinkedList<Item> Queue = new();
        internal Item? Running;
        internal bool Quarantined;
    }
    // Explicitly shared by executor instances. This models one in-process
    // registry only; it does not prove filesystem or cross-process identity.
    internal sealed class Registry
    {
        internal readonly object sync = new();
        internal readonly Dictionary<string, Root> roots = new(StringComparer.OrdinalIgnoreCase);
        internal readonly int maximumRoots, maximumQueuedPerRoot;
        internal Registry(int maximumRoots, int maximumQueuedPerRoot) {
            if (maximumRoots < 1 || maximumQueuedPerRoot < 1) throw new ArgumentOutOfRangeException();
            this.maximumRoots = maximumRoots; this.maximumQueuedPerRoot = maximumQueuedPerRoot;
        }
        internal OwnedRootExecutorPrototype Create() => new(this);
    }
    internal sealed class SyntheticCounter { internal int Value; }
    internal sealed class SyntheticCommitScope(Func<SyntheticCounter, bool> commit) {
        // Only a fake in-memory effect is permitted. Never execute arbitrary I/O
        // or native calls while holding the prototype's registry lock.
        internal bool TryCommit(SyntheticCounter counter) => commit(counter);
    }
    private readonly Registry registry;
    private OwnedRootExecutorPrototype(Registry registry) => this.registry = registry;
    private static string CanonicalRoot(string root) {
        if (string.IsNullOrWhiteSpace(root) || !Path.IsPathFullyQualified(root) || root.StartsWith("\\\\", StringComparison.Ordinal))
            throw new ArgumentException("A fully qualified local synthetic root is required.", nameof(root));
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
    }

    internal async Task RunAsync(string key, Func<SyntheticCommitScope, Task<bool>> work, TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(key); ArgumentNullException.ThrowIfNull(work);
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromMinutes(10)) throw new ArgumentOutOfRangeException(nameof(timeout));
        key = CanonicalRoot(key);
        cancellationToken.ThrowIfCancellationRequested();
        var item = new Item(work); Root root;
        lock (registry.sync) {
            if (!registry.roots.TryGetValue(key, out root!)) {
                if (registry.roots.Count >= registry.maximumRoots) throw new InvalidOperationException("Root capacity reached.");
                registry.roots.Add(key, root = new());
            }
            if (root.Quarantined) throw new InvalidOperationException("Root is quarantined.");
            if (root.Queue.Count >= registry.maximumQueuedPerRoot) throw new InvalidOperationException("Queue capacity reached.");
            item.Node = root.Queue.AddLast(item);
            StartNextLocked(key, root);
        }
        try { await item.Done.Task.WaitAsync(timeout, cancellationToken).ConfigureAwait(false); }
        catch (Exception e) when (e is TimeoutException or OperationCanceledException) {
            var completed = false;
            lock (registry.sync) {
                // A completed operation wins a simultaneous timeout/cancellation.
                completed = item.Done.Task.IsCompleted;
                if (!completed) {
                    if (item.Node is not null) { root.Queue.Remove(item.Node); item.Node = null; item.Done.TrySetCanceled(); }
                    else if (item.Running) {
                        item.Abandoned = true;
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
            var scope = new SyntheticCommitScope(counter => {
                lock (registry.sync) {
                    if (counter is null || !item.Running || item.Abandoned || root.Quarantined ||
                        !registry.roots.TryGetValue(key, out var current) || !ReferenceEquals(root, current) || !ReferenceEquals(root.Running, item)) return false;
                    checked { counter.Value++; }
                    return true;
                }
            });
            try { cleaned = await item.Work(scope).ConfigureAwait(false); } catch (Exception error) { failure = error; }
            lock (registry.sync) {
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
                if (cleaned && (root.Quarantined || root.Queue.Count == 0)) registry.roots.Remove(key);
                else if (!root.Quarantined) StartNextLocked(key, root);
                if (!cleaned && failure is null) failure = new InvalidOperationException("Root cleanup is unverified.");
                if (failure is null) item.Done.TrySetResult(); else item.Done.TrySetException(failure);
            }
        });
    }
}
