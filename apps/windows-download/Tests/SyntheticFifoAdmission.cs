// Isolated model only: no native, filesystem, authentication or product call sites.
// One live lease per opaque synthetic root; each distinct request owns its own ticket.
internal sealed class SyntheticFifoAdmission : IDisposable
{
    private enum State { Queued, Granted, Retired }
    private sealed class Root
    {
        internal readonly LinkedList<Ticket> Waiting = [];
        internal readonly HashSet<Guid> Ids = [];
        internal Ticket? Active;
    }
    private sealed class Ticket(string root, Guid id, long timestamp)
    {
        internal readonly string RootName = root;
        internal readonly Guid Id = id;
        internal readonly long Timestamp = timestamp;
        internal readonly TaskCompletionSource<Lease> Result = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal State State;
        internal LinkedListNode<Ticket>? Node;
        internal Lease? Lease;
    }
    internal sealed class Lease : IDisposable
    {
        private Action? release;
        internal Lease(Action release) => this.release = release;
        public void Dispose() => Interlocked.Exchange(ref release, null)?.Invoke();
    }
    private readonly object sync = new();
    private readonly Dictionary<string, Root> roots = new(StringComparer.OrdinalIgnoreCase);
    private readonly int maxRoots, maxWaiting;
    private readonly TimeProvider clock;
    private bool stopped;
    internal SyntheticFifoAdmission(int maxRoots, int maxWaiting, TimeProvider? clock = null)
    {
        if (maxRoots <= 0 || maxWaiting <= 0) throw new ArgumentOutOfRangeException();
        this.maxRoots = maxRoots; this.maxWaiting = maxWaiting; this.clock = clock ?? TimeProvider.System;
    }
    internal async Task<Lease> AcquireAsync(string rootName, Guid id, CancellationToken token = default)
    {
        if (string.IsNullOrWhiteSpace(rootName) || id == Guid.Empty) throw new ArgumentException("Synthetic identity required.");
        token.ThrowIfCancellationRequested();
        Ticket ticket; Ticket? grant;
        lock (sync) {
            if (stopped) throw new ObjectDisposedException(nameof(SyntheticFifoAdmission));
            if (!roots.TryGetValue(rootName, out var root)) {
                if (roots.Count >= maxRoots) throw new InvalidOperationException("Synthetic root capacity reached.");
                roots.Add(rootName, root = new());
            }
            if (root.Ids.Contains(id)) throw new InvalidOperationException("Duplicate synthetic request.");
            if (root.Active is not null && root.Waiting.Count >= maxWaiting) throw new InvalidOperationException("Synthetic queue is full.");
            ticket = new(rootName, id, clock.GetTimestamp()); root.Ids.Add(id);
            ticket.Node = root.Waiting.AddLast(ticket);
            grant = GrantLocked(root);
        }
        CompleteGrant(grant);
        try {
            var lease = await ticket.Result.Task.WaitAsync(token).ConfigureAwait(false);
            // Callers must check again at the mutation boundary after this method returns.
            if (token.IsCancellationRequested) { lease.Dispose(); token.ThrowIfCancellationRequested(); }
            return lease;
        } catch {
            CancelUnclaimed(ticket);
            throw;
        }
    }
    internal TimeSpan WaitingAge(string rootName, Guid id)
    {
        lock (sync) {
            if (!roots.TryGetValue(rootName, out var root)) throw new InvalidOperationException();
            var ticket = root.Waiting.FirstOrDefault(value => value.Id == id) ?? throw new InvalidOperationException();
            return clock.GetElapsedTime(ticket.Timestamp);
        }
    }
    private Ticket? GrantLocked(Root root)
    {
        if (stopped || root.Active is not null || root.Waiting.First is not { } node) return null;
        root.Waiting.RemoveFirst(); var ticket = node.Value; ticket.Node = null;
        ticket.State = State.Granted; root.Active = ticket;
        ticket.Lease = new(() => Release(ticket)); return ticket;
    }
    private static void CompleteGrant(Ticket? ticket)
    { if (ticket is not null) ticket.Result.TrySetResult(ticket.Lease!); }
    private void CancelUnclaimed(Ticket ticket)
    {
        Lease? revoke = null;
        lock (sync) {
            if (!roots.TryGetValue(ticket.RootName, out var root) || ticket.State == State.Retired) return;
            if (ticket.State == State.Granted) revoke = ticket.Lease;
            else {
                root.Waiting.Remove(ticket.Node!); ticket.Node = null; ticket.State = State.Retired;
                root.Ids.Remove(ticket.Id); RetireRootLocked(ticket.RootName, root);
            }
        }
        revoke?.Dispose();
    }
    private void Release(Ticket ticket)
    {
        Ticket? grant;
        lock (sync) {
            if (!roots.TryGetValue(ticket.RootName, out var root) || ticket.State != State.Granted || !ReferenceEquals(root.Active, ticket))
                throw new InvalidOperationException("Synthetic lease ownership changed.");
            ticket.State = State.Retired; root.Active = null; root.Ids.Remove(ticket.Id);
            grant = GrantLocked(root); RetireRootLocked(ticket.RootName, root);
        }
        CompleteGrant(grant);
    }
    private void RetireRootLocked(string name, Root root)
    { if (root.Active is null && root.Waiting.Count == 0) roots.Remove(name); }
    public void Dispose()
    {
        List<Ticket> reject = [];
        lock (sync) {
            if (stopped) return;
            stopped = true;
            foreach (var (name, root) in roots.ToArray()) {
                foreach (var ticket in root.Waiting) { ticket.State = State.Retired; root.Ids.Remove(ticket.Id); reject.Add(ticket); }
                root.Waiting.Clear(); RetireRootLocked(name, root);
            }
        }
        foreach (var ticket in reject) ticket.Result.TrySetException(new ObjectDisposedException(nameof(SyntheticFifoAdmission)));
    }
}
