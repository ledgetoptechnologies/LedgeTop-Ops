namespace LedgeTop.Files;

// Unwired held-selector capability. Transfer revokes the sender's alias while
// retaining the same handles; it is not proof against pre-existing writable
// mappings or every ancestor replacement.
internal sealed class FreshGenerationSelectorLease : IDisposable
{
    // A failed Dispose may or may not have released a handle. Keep the exact
    // object reachable for process-lifetime review instead of guessing.
    private static readonly System.Collections.Concurrent.ConcurrentBag<IDisposable> uncertainHandles = new();
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
    internal static bool IsQuarantinedForTest(IDisposable value) => uncertainHandles.Any(item => ReferenceEquals(item, value));
#endif
    private static List<Exception> DisposeAll(params IDisposable?[] handles)
    {
        var errors = new List<Exception>();
        foreach (var handle in handles) {
            if (handle is null) continue;
            try { handle.Dispose(); }
            catch (Exception error) { uncertainHandles.Add(handle); errors.Add(error); }
        }
        return errors;
    }
    internal static void CleanupAfterFailure(Exception original, params IDisposable?[] handles)
    {
        var errors = DisposeAll(handles);
        if (errors.Count != 0) throw new AggregateException("Selector cleanup is uncertain; failed handles remain retained.", new[] { original }.Concat(errors));
        System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(original).Throw();
    }
    private sealed class State(ConnectedIndexLease indexLock, FileStream current, FileStream backup,
        string currentPath, string backupPath, FreshGenerationIndexCodec.Index expected)
    {
        internal readonly object Sync = new();
        internal ConnectedIndexLease IndexLock = indexLock;
        internal readonly FileStream Current = current, Backup = backup;
        internal readonly FreshGenerationIndexLockPin CurrentPin = new(current, currentPath), BackupPin = new(backup, backupPath);
        internal readonly string CurrentPath = Path.GetFullPath(currentPath), BackupPath = Path.GetFullPath(backupPath);
        internal readonly FreshGenerationIndexCodec.Index Expected = expected;
        internal long Epoch = 1;
        internal bool Busy, Disposed, DisposeUncertain;
    }
    private readonly State state;
    private readonly long epoch;
    private FreshGenerationSelectorLease(State state, long epoch) { this.state = state; this.epoch = epoch; }
    internal static FreshGenerationSelectorLease Acquire(string lockPath, string currentPath, string backupPath, FreshGenerationIndexCodec.Index expected)
    {
        var indexLock = ConnectedIndexLease.Acquire(lockPath, FileMode.Open);
        try { return TakeOwnership(indexLock, lockPath, currentPath, backupPath, expected); }
        catch (Exception original) { CleanupAfterFailure(original, indexLock); throw; }
    }
    internal static FreshGenerationSelectorLease TakeOwnership(ConnectedIndexLease indexLock, string lockPath,
        string currentPath, string backupPath, FreshGenerationIndexCodec.Index expected)
    {
        if (!indexLock.MatchesPath(lockPath) || !indexLock.StillHeld(indexLock)) throw new IOException("Selector lock owner differs.");
        FileStream? current = null, backup = null;
        try {
            current = new FileStream(currentPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            backup = new FileStream(backupPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            var state = new State(indexLock, current, backup, currentPath, backupPath, expected);
            var lease = new FreshGenerationSelectorLease(state, 1);
            lease.Verify();
            // No fallible work follows transfer: on earlier failure the caller
            // still owns its original index lock and can retain it for review.
            state.IndexLock = indexLock.Transfer();
            return lease;
        } catch (Exception original) { CleanupAfterFailure(original, backup, current); throw; }
    }
    private void VerifyLocked()
    {
        if (state.Disposed || state.Epoch != epoch) throw new ObjectDisposedException(nameof(FreshGenerationSelectorLease));
        if (!state.IndexLock.StillHeld(state.IndexLock) || !state.CurrentPin.StillHeld(state.Current) || !state.BackupPin.StillHeld(state.Backup) ||
            FreshGenerationStartup.Observe(state.CurrentPath, state.BackupPath, state.Expected.Sid, state.Expected.Channel, state.Expected.Source, state.Expected.OriginSha256) != state.Expected ||
            !state.IndexLock.StillHeld(state.IndexLock) || !state.CurrentPin.StillHeld(state.Current) || !state.BackupPin.StillHeld(state.Backup))
            throw new IOException("Held selector ownership changed.");
    }
    internal void Verify() { lock (state.Sync) VerifyLocked(); }
    internal FreshGenerationSelectorLease Transfer()
    {
        lock (state.Sync) {
            VerifyLocked();
            if (state.Busy) throw new IOException("Selector decision is still in progress.");
            var next = checked(state.Epoch + 1);
            var recipient = new FreshGenerationSelectorLease(state, next);
            state.Epoch = next;
            return recipient;
        }
    }
    internal Operation Begin(FreshGenerationIndexCodec.Index selector)
    {
        lock (state.Sync) {
            VerifyLocked();
            if (state.Busy || selector != state.Expected) throw new IOException("Selector ownership is busy or differs.");
            state.Busy = true; return new(this);
        }
    }
    internal sealed class Operation : IDisposable
    {
        private FreshGenerationSelectorLease? owner;
        internal Operation(FreshGenerationSelectorLease owner) => this.owner = owner;
        internal void Verify() {
            var value = owner ?? throw new ObjectDisposedException(nameof(Operation));
            lock (value.state.Sync) { if (!value.state.Busy || !ReferenceEquals(owner, value)) throw new IOException("Selector operation ended."); value.VerifyLocked(); }
        }
        public void Dispose() {
            var value = owner; if (value is null) return;
            lock (value.state.Sync) { if (!ReferenceEquals(owner, value)) return; owner = null; value.state.Busy = false; }
        }
    }
    public void Dispose()
    {
        lock (state.Sync) {
            if (state.Epoch != epoch) return;
            if (state.DisposeUncertain) throw new IOException("Selector handle disposal remains unconfirmed.");
            if (state.Disposed) return;
            if (state.Busy) throw new IOException("Selector decision is still in progress.");
            state.Disposed = true;
            var errors = DisposeAll(state.Backup, state.Current, state.IndexLock);
            if (errors.Count != 0) { state.DisposeUncertain = true; throw new AggregateException("Selector handle disposal is uncertain.", errors); }
        }
    }
}
