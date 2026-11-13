namespace LedgeTop.Files;

// Unwired held-selector capability. It coordinates cooperating app operations
// and denies new write/delete opens on the selected files while held; it is not
// proof against pre-existing writable mappings or every ancestor replacement.
internal sealed class FreshGenerationSelectorLease : IDisposable
{
    private readonly object sync = new();
    private readonly FileStream indexLock, current, backup;
    private readonly FreshGenerationIndexLockPin lockPin, currentPin, backupPin;
    private readonly string currentPath, backupPath;
    private readonly FreshGenerationIndexCodec.Index expected;
    private bool busy, disposed;

    private FreshGenerationSelectorLease(FileStream indexLock, FileStream current, FileStream backup,
        string lockPath, string currentPath, string backupPath, FreshGenerationIndexCodec.Index expected)
    {
        this.indexLock = indexLock; this.current = current; this.backup = backup;
        this.currentPath = Path.GetFullPath(currentPath); this.backupPath = Path.GetFullPath(backupPath); this.expected = expected;
        lockPin = new(indexLock, lockPath); currentPin = new(current, currentPath); backupPin = new(backup, backupPath);
    }
    internal static FreshGenerationSelectorLease Acquire(string lockPath, string currentPath, string backupPath, FreshGenerationIndexCodec.Index expected)
    {
        FileStream? indexLock = null, current = null, backup = null;
        try {
            indexLock = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            current = new FileStream(currentPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            backup = new FileStream(backupPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            var lease = new FreshGenerationSelectorLease(indexLock, current, backup, lockPath, currentPath, backupPath, expected);
            lease.Verify(); return lease;
        } catch { backup?.Dispose(); current?.Dispose(); indexLock?.Dispose(); throw; }
    }
    private void VerifyLocked()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (!lockPin.StillHeld(indexLock) || !currentPin.StillHeld(current) || !backupPin.StillHeld(backup) ||
            FreshGenerationStartup.Observe(currentPath, backupPath, expected.Sid, expected.Channel, expected.Source, expected.OriginSha256) != expected ||
            !lockPin.StillHeld(indexLock) || !currentPin.StillHeld(current) || !backupPin.StillHeld(backup))
            throw new IOException("Held selector ownership changed.");
    }
    internal void Verify() { lock (sync) VerifyLocked(); }
    internal Operation Begin(FreshGenerationIndexCodec.Index selector)
    {
        lock (sync) {
            VerifyLocked();
            if (busy || selector != expected) throw new IOException("Selector ownership is busy or differs.");
            busy = true; return new(this);
        }
    }
    internal sealed class Operation : IDisposable
    {
        private FreshGenerationSelectorLease? owner;
        internal Operation(FreshGenerationSelectorLease owner) => this.owner = owner;
        internal void Verify() {
            var value = owner ?? throw new ObjectDisposedException(nameof(Operation));
            lock (value.sync) { if (!value.busy || !ReferenceEquals(owner, value)) throw new IOException("Selector operation ended."); value.VerifyLocked(); }
        }
        public void Dispose() {
            var value = owner; if (value is null) return;
            lock (value.sync) { if (!ReferenceEquals(owner, value)) return; owner = null; value.busy = false; }
        }
    }
    public void Dispose()
    {
        lock (sync) {
            if (disposed) return;
            if (busy) throw new IOException("Selector decision is still in progress.");
            disposed = true;
            try { backup.Dispose(); } finally { try { current.Dispose(); } finally { indexLock.Dispose(); } }
        }
    }
}
