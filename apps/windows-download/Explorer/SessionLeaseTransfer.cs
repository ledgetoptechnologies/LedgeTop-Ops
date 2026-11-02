namespace LedgeTop.Files.Explorer;

// Internal, unwired ownership primitive. The caller must hold the session operation
// gate and validate exact profile/lock/root identity before handing in its sole stream.
// It cannot establish path identity or prevent an uncooperative holder disposing an alias.
internal sealed class SessionLeaseTransfer : IAsyncDisposable
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly AsyncLocal<bool> inDrain = new();
    private FileStream? stream;
    private bool disposed;
    private SessionLeaseTransfer(FileStream stream) => this.stream = stream;

    internal static SessionLeaseTransfer Take(ref FileStream? owner)
    {
        var held = owner ?? throw new IOException("No session lease to transfer.");
        if (held.SafeFileHandle.IsClosed || held.SafeFileHandle.IsInvalid) throw new IOException("Session lease is closed.");
        var result = new SessionLeaseTransfer(held);
        owner = null;
        return result;
    }

    // A false, cancelled, or failed drain leaves this object owning the same lease.
    // No cancellation shortcut is allowed while a drain callback is still running.
    internal async Task<SessionLeaseReceipt?> DrainAndTransferAsync(Func<CancellationToken, Task<bool>> drain, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(drain);
        if (inDrain.Value) throw new InvalidOperationException("Reentrant lease transfer is not allowed.");
        await gate.WaitAsync(token).ConfigureAwait(false);
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            var held = stream ?? throw new IOException("Session lease was already transferred.");
            token.ThrowIfCancellationRequested();
            bool drained;
            inDrain.Value = true;
            try { drained = await drain(token).ConfigureAwait(false); }
            finally { inDrain.Value = false; }
            if (!drained) return null;
            token.ThrowIfCancellationRequested();
            if (held.SafeFileHandle.IsClosed || held.SafeFileHandle.IsInvalid) throw new IOException("Session lease was closed during drain.");
            var receipt = new SessionLeaseReceipt(held);
            stream = null;
            return receipt;
        } finally { gate.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        if (inDrain.Value) throw new InvalidOperationException("Reentrant lease disposal is not allowed.");
        await gate.WaitAsync().ConfigureAwait(false);
        try { if (!disposed) { disposed = true; stream?.Dispose(); stream = null; } }
        finally { gate.Release(); }
    }
}

internal sealed class SessionLeaseReceipt : IDisposable
{
    private FileStream? stream;
    internal SessionLeaseReceipt(FileStream stream) => this.stream = stream;
    internal FileStream Inspect() => Volatile.Read(ref stream) ?? throw new ObjectDisposedException(nameof(SessionLeaseReceipt));
    internal FileStream Take() => Interlocked.Exchange(ref stream, null) ?? throw new ObjectDisposedException(nameof(SessionLeaseReceipt));
    public void Dispose() => Interlocked.Exchange(ref stream, null)?.Dispose();
}
