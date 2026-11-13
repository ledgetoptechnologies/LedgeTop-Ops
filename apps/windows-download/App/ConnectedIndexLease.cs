namespace LedgeTop.Files;

// Single in-process owner for a session's index-lock handle. Callers can pin
// the owner identity, but cannot close or transfer its underlying FileStream.
internal sealed class ConnectedIndexLease : IDisposable
{
    private static readonly System.Collections.Concurrent.ConcurrentBag<FileStream> uncertainHandles = new();
    private readonly object sync = new();
    private readonly FileStream stream;
    private readonly FreshGenerationIndexLockPin pin;
    private bool disposalAttempted, disposalConfirmed;
    private ConnectedIndexLease(FileStream stream, string path)
    { this.stream = stream; pin = new(stream, path); }
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
        lock (sync) return !disposalAttempted && pin.StillHeld(stream);
    }
    public void Dispose()
    {
        lock (sync) {
            if (disposalConfirmed) return;
            if (disposalAttempted) throw new IOException("Index lease disposal is unconfirmed.");
            disposalAttempted = true;
            try { stream.Dispose(); } catch { uncertainHandles.Add(stream); throw; }
            disposalConfirmed = true;
        }
    }
}
