namespace LedgeTop.Files;

// An exclusive selector lock that never exposes its underlying stream. Transfer
// revokes the old capability while retaining the exact same kernel handle.
// This primitive is not yet wired into ConnectedExplorerSession.
internal sealed class SelectorIndexOwnership : IDisposable
{
    private sealed class State(FileStream stream, string path)
    {
        internal readonly object Gate = new();
        internal FileStream? Stream = stream;
        internal readonly FreshGenerationIndexLockPin Pin = new(stream, path);
        internal long Epoch = 1;
        internal bool Busy;
        internal bool ReentrantMutation;
    }
    private readonly State state;
    private readonly long epoch;
    private readonly string path;
    private SelectorIndexOwnership(State state, long epoch, string path) { this.state = state; this.epoch = epoch; this.path = path; }

    internal static SelectorIndexOwnership Acquire(string path, FileMode mode = FileMode.Open)
    {
        path = Path.GetFullPath(path);
        var stream = new FileStream(path, mode, FileAccess.ReadWrite, FileShare.None);
        try { return new(new State(stream, path), 1, path); }
        catch { stream.Dispose(); throw; }
    }
    internal bool IsHeld { get { try { VerifyHeld(); return true; } catch (IOException) { return false; } catch (ObjectDisposedException) { return false; } } }
    internal bool MatchesPath(string candidate) => string.Equals(path, Path.GetFullPath(candidate), StringComparison.OrdinalIgnoreCase);
    internal void VerifyHeld()
    {
        lock (state.Gate) {
            if (state.Epoch != epoch || state.Stream is null) throw new ObjectDisposedException(nameof(SelectorIndexOwnership));
            if (!state.Pin.StillHeld(state.Stream)) throw new IOException("Selector index lock ownership changed.");
        }
    }
    // Keep the same kernel handle and epoch pinned across a synchronous,
    // bounded operation; transfer/dispose cannot interleave in this process.
    internal T WithHeld<T>(string expectedPath, Func<T> action)
    {
        ArgumentNullException.ThrowIfNull(action);
        lock (state.Gate) {
            if (!MatchesPath(expectedPath)) throw new IOException("Selector index lock path differs.");
            VerifyHeld();
            if (state.Busy) { state.ReentrantMutation = true; throw new IOException("Selector lock operation is already active."); }
            state.Busy = true; state.ReentrantMutation = false;
            try {
                var result = action();
                if (state.ReentrantMutation) throw new IOException("Selector lock operation was reentered; outcome requires review.");
                return result;
            } finally { state.Busy = false; }
        }
    }
    internal void AssertHeldOperationHealthy()
    {
        lock (state.Gate) {
            if (!state.Busy || state.ReentrantMutation) throw new IOException("Selector lock operation requires review.");
            VerifyHeld();
        }
    }
    internal SelectorIndexOwnership Transfer()
    {
        lock (state.Gate) {
            if (state.Busy) { state.ReentrantMutation = true; throw new IOException("Selector lock cannot transfer during an active operation."); }
            VerifyHeld();
            long next = checked(state.Epoch + 1);
            var receiver = new SelectorIndexOwnership(state, next, path);
            state.Epoch = next;
            return receiver;
        }
    }
    public void Dispose()
    {
        lock (state.Gate) {
            if (state.Epoch != epoch || state.Stream is null) return;
            if (state.Busy) { state.ReentrantMutation = true; throw new IOException("Selector lock cannot close during an active operation."); }
            var stream = state.Stream;
            state.Stream = null; // Dispose may have partially succeeded; never replay it.
            stream.Dispose();
        }
    }
}
