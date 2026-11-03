// Test-only prototype. It is not referenced by the provider or packaged app.
// Work owns its resources inside its delegate and returns true only with an
// explicit safe-cleanup receipt. Faults or a false receipt quarantine the root.
internal sealed class OwnedRootExecutorPrototype
{
    internal sealed class Item(Func<SyntheticCommitScope, Task<bool>> work)
    {
        internal readonly Func<SyntheticCommitScope, Task<bool>> Work = work;
        internal readonly TaskCompletionSource<Observation> Done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal LinkedListNode<Item>? Node;
        internal bool Running;
        internal bool Abandoned;
        internal bool Committed;
        internal SyntheticGeneration? AuthorizedGeneration;
        internal long AuthorizedVersion;
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
        internal bool stopping;
        internal readonly TaskCompletionSource drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal Registry(int maximumRoots, int maximumQueuedPerRoot) {
            if (maximumRoots < 1 || maximumQueuedPerRoot < 1) throw new ArgumentOutOfRangeException();
            this.maximumRoots = maximumRoots; this.maximumQueuedPerRoot = maximumQueuedPerRoot;
        }
        internal OwnedRootExecutorPrototype Create() => new(this);
        internal SyntheticGeneration CreateGeneration() => new(this);
        internal long ReadGeneration(SyntheticGeneration generation) {
            lock (sync) { if (!ReferenceEquals(generation.Owner, this)) throw new ArgumentException("Foreign generation."); return generation.Value; }
        }
        internal void AdvanceGeneration(SyntheticGeneration generation) {
            lock (sync) { if (!ReferenceEquals(generation.Owner, this)) throw new ArgumentException("Foreign generation."); checked { generation.Value++; } }
        }
        internal void BeginStop() {
            lock (sync) {
                stopping = true;
                foreach (var root in roots.Values) while (root.Queue.First is { } node) {
                    root.Queue.RemoveFirst(); node.Value.Node = null;
                    node.Value.Done.TrySetException(new InvalidOperationException("Executor is stopping."));
                }
                if (roots.Count == 0) drained.TrySetResult();
            }
        }
        internal Task WaitForDrainAsync(TimeSpan timeout) {
            if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromMinutes(10)) throw new ArgumentOutOfRangeException(nameof(timeout));
            lock (sync) { if (!stopping) throw new InvalidOperationException("Stop has not begun."); }
            return drained.Task.WaitAsync(timeout);
        }
    }
    internal sealed class SyntheticGeneration(Registry owner) { internal readonly Registry Owner = owner; internal long Value; }
    internal sealed class SyntheticCounter { internal int Value; }
    // Completed means only that the fake delegate returned with its asserted
    // cleanup receipt; it is not proof that bytes were transferred. Pending is
    // neither cleanup success nor definitive failure. No Cloud Files mapping.
    internal enum Observation { Completed, CommittedPending, CommittedCleanupUnverified }
    internal sealed class SyntheticCommitScope(Func<SyntheticCounter, SyntheticGeneration?, long, bool> commit, Func<SyntheticGeneration, long, bool> authorize) {
        // Only a fake in-memory effect is permitted. Never execute arbitrary I/O
        // or native calls while holding the prototype's registry lock.
        internal bool TryCommit(SyntheticCounter counter) => commit(counter, null, 0);
        internal bool TryAuthorize(SyntheticGeneration generation, long version) => authorize(generation, version);
        internal bool TryCommitAuthorized(SyntheticCounter counter, SyntheticGeneration generation, long version) => commit(counter, generation, version);
    }
    private readonly Registry registry;
    private OwnedRootExecutorPrototype(Registry registry) => this.registry = registry;
    private static string CanonicalRoot(string root) {
        if (string.IsNullOrWhiteSpace(root) || !Path.IsPathFullyQualified(root) || root.StartsWith("\\\\", StringComparison.Ordinal))
            throw new ArgumentException("A fully qualified local synthetic root is required.", nameof(root));
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
    }

    internal async Task<Observation> RunAsync(string key, Func<SyntheticCommitScope, Task<bool>> work, TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(key); ArgumentNullException.ThrowIfNull(work);
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromMinutes(10)) throw new ArgumentOutOfRangeException(nameof(timeout));
        key = CanonicalRoot(key);
        cancellationToken.ThrowIfCancellationRequested();
        var item = new Item(work); Root root;
        lock (registry.sync) {
            if (registry.stopping) throw new InvalidOperationException("Executor is stopping.");
            if (!registry.roots.TryGetValue(key, out root!)) {
                if (registry.roots.Count >= registry.maximumRoots) throw new InvalidOperationException("Root capacity reached.");
                registry.roots.Add(key, root = new());
            }
            if (root.Quarantined) throw new InvalidOperationException("Root is quarantined.");
            if (root.Queue.Count >= registry.maximumQueuedPerRoot) throw new InvalidOperationException("Queue capacity reached.");
            item.Node = root.Queue.AddLast(item);
            StartNextLocked(key, root);
        }
        try { return await item.Done.Task.WaitAsync(timeout, cancellationToken).ConfigureAwait(false); }
        catch (Exception e) when (e is TimeoutException or OperationCanceledException) {
            var completed = false;
            var committed = false;
            lock (registry.sync) {
                // A completed operation wins a simultaneous timeout/cancellation.
                completed = item.Done.Task.IsCompleted;
                if (!completed) {
                    if (item.Node is not null) { root.Queue.Remove(item.Node); item.Node = null; item.Done.TrySetCanceled(); }
                    else if (item.Running) {
                        item.Abandoned = true;
                        committed = item.Committed;
                        root.Quarantined = true;
                        while (root.Queue.First is { } node) {
                            root.Queue.RemoveFirst(); node.Value.Node = null;
                            node.Value.Done.TrySetException(new InvalidOperationException("Root is quarantined."));
                        }
                    }
                }
            }
            if (completed) return await item.Done.Task.ConfigureAwait(false);
            // Observe a fault that occurs after its caller has timed out.
            _ = item.Done.Task.ContinueWith(t => _ = t.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            if (committed) return Observation.CommittedPending;
            throw;
        }
    }
    private void StartNextLocked(string key, Root root)
    {
        if (root.Running is not null || root.Queue.First is not { } node) return;
        root.Queue.RemoveFirst(); var item = node.Value; item.Node = null; item.Running = true; root.Running = item;
        _ = Task.Run(async () => {
            Exception? failure = null; var cleaned = false;
            bool Active() => item.Running && !item.Abandoned && !item.Committed && !root.Quarantined && !registry.stopping &&
                registry.roots.TryGetValue(key, out var current) && ReferenceEquals(root, current) && ReferenceEquals(root.Running, item);
            var scope = new SyntheticCommitScope((counter, generation, version) => {
                lock (registry.sync) {
                    if (counter is null || !Active() || (generation is not null && (!ReferenceEquals(generation.Owner, registry) ||
                        !ReferenceEquals(item.AuthorizedGeneration, generation) || item.AuthorizedVersion != version || generation.Value != version))) return false;
                    checked { counter.Value++; }
                    item.Committed = true;
                    return true;
                }
            }, (generation, version) => {
                lock (registry.sync) {
                    // A failed new authorization cannot reuse a previously
                    // accepted synthetic authorization observation.
                    item.AuthorizedGeneration = null;
                    if (generation is null || !Active() || !ReferenceEquals(generation.Owner, registry) || generation.Value != version) return false;
                    item.AuthorizedGeneration = generation; item.AuthorizedVersion = version; return true;
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
                if (registry.stopping && registry.roots.Count == 0) registry.drained.TrySetResult();
                if (!cleaned && failure is null) failure = new InvalidOperationException("Root cleanup is unverified.");
                if (item.Committed && !cleaned) item.Done.TrySetResult(Observation.CommittedCleanupUnverified);
                else if (failure is null) item.Done.TrySetResult(Observation.Completed); else item.Done.TrySetException(failure);
            }
        });
    }
}
