namespace LedgeTop.Files;

// Single in-process owner for a session's index-lock handle. Callers can pin
// the owner identity, but cannot close or transfer its underlying FileStream.
internal sealed class ConnectedIndexLease : IDisposable
{
    private static readonly System.Collections.Concurrent.ConcurrentBag<FileStream> uncertainHandles = new();
    private sealed class State(FileStream stream, string path)
    {
        internal readonly object Sync = new();
        internal readonly FileStream Stream = stream;
        internal readonly string Path = System.IO.Path.GetFullPath(path);
        internal readonly FreshGenerationIndexLockPin Pin = new(stream, path);
        internal long Epoch = 1;
        internal bool DisposalAttempted, DisposalConfirmed;
    }
    private readonly State state;
    private readonly long epoch;
    private ConnectedIndexLease(FileStream stream, string path)
    { state = new(stream, path); epoch = 1; }
    private ConnectedIndexLease(State state, long epoch) { this.state = state; this.epoch = epoch; }
    internal static ConnectedIndexLease Acquire(string path, FileMode mode)
    {
        var stream = new FileStream(path, mode, FileAccess.ReadWrite, FileShare.None);
        try { return new(stream, path); }
        catch (Exception original) {
            try { stream.Dispose(); } catch (Exception close) { uncertainHandles.Add(stream); throw new AggregateException("Index lease creation and cleanup failed.", original, close); }
            throw;
        }
    }
    internal bool StillHeld(ConnectedIndexLease? candidate)
    {
        if (!ReferenceEquals(this, candidate)) return false;
        lock (state.Sync) return state.Epoch == epoch && !state.DisposalAttempted && state.Pin.StillHeld(state.Stream);
    }
    internal ConnectedIndexLease Transfer()
    {
        lock (state.Sync) {
            if (state.Epoch != epoch || state.DisposalAttempted || !state.Pin.StillHeld(state.Stream)) throw new IOException("Index lease is not available for transfer.");
            var next = checked(state.Epoch + 1); var owner = new ConnectedIndexLease(state, next);
            state.Epoch = next; return owner;
        }
    }
    internal bool MatchesPath(string path) => string.Equals(state.Path, System.IO.Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase);
    public void Dispose()
    {
        lock (state.Sync) {
            if (state.Epoch != epoch) return;
            if (state.DisposalConfirmed) return;
            if (state.DisposalAttempted) throw new IOException("Index lease disposal is unconfirmed.");
            state.DisposalAttempted = true;
            try { state.Stream.Dispose(); } catch { uncertainHandles.Add(state.Stream); throw; }
            state.DisposalConfirmed = true;
        }
    }
}
