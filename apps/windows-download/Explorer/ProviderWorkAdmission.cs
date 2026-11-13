namespace LedgeTop.Files.Explorer;

// Internal composition contract. The provider assumes exclusive ownership of the
// authority after Activate succeeds; its owner must not dispose it independently.
// A real authority must retain and verify the selector and physical root through drain.
internal interface IProviderWorkAuthority : IDisposable { void VerifyHeld(); }

// Optional fail-closed admission for a fresh generation. No production composition
// enables this yet: activation requires a separately reviewed physical authority.
internal sealed class ProviderWorkAdmission
{
    private readonly object sync = new();
    private IProviderWorkAuthority? authority;
    private bool activated, stopping;
    private int count;
    private TaskCompletionSource? drained;

    internal void Activate(IProviderWorkAuthority ownedAuthority)
    {
        ArgumentNullException.ThrowIfNull(ownedAuthority);
        lock (sync) {
            if (activated || stopping) throw new IOException("Provider admission cannot be activated.");
            ownedAuthority.VerifyHeld();
            authority = ownedAuthority; activated = true;
        }
    }

    internal IDisposable Enter()
    {
        IProviderWorkAuthority held;
        lock (sync) {
            if (!activated || stopping || authority is null) throw new IOException("Provider admission is unavailable.");
            checked { count++; }
            held = authority;
        }
        try {
            // The reserved count keeps authority alive, but slow proof must not
            // hold the admission lock and prevent StopAdmission closing the gate.
            held.VerifyHeld();
            lock (sync) { if (stopping) throw new IOException("Provider admission is unavailable."); }
            return new Ticket(this);
        } catch {
            Leave(); throw;
        }
    }

    internal void StopAdmission()
    {
        lock (sync) { stopping = true; if (count == 0) drained?.TrySetResult(); }
    }

    // Call only after native disconnection and all provider workers have drained.
    // A failed native drain must retain this object and its authority for review.
    internal async Task ReleaseAfterDrainAsync()
    {
        Task wait;
        lock (sync) {
            if (!stopping) throw new InvalidOperationException("Provider admission is still open.");
            drained ??= new(TaskCreationOptions.RunContinuationsAsynchronously);
            if (count == 0) drained.TrySetResult();
            wait = drained.Task;
        }
        await wait.ConfigureAwait(false);
        IProviderWorkAuthority? released;
        lock (sync) { released = authority; authority = null; }
        released?.Dispose();
    }

    private void Leave()
    {
        lock (sync) { count--; if (stopping && count == 0) drained?.TrySetResult(); }
    }
    private sealed class Ticket(ProviderWorkAdmission owner) : IDisposable
    {
        private ProviderWorkAdmission? owner = owner;
        public void Dispose() => Interlocked.Exchange(ref owner, null)?.Leave();
    }
}
