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
    internal SelectorIndexOwnership Transfer()
    {
        lock (state.Gate) {
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
            var stream = state.Stream;
            state.Stream = null; // Dispose may have partially succeeded; never replay it.
            stream.Dispose();
        }
    }
}
