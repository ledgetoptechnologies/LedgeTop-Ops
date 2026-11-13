namespace LedgeTop.Files.Explorer;

// Experimental, unwired ownership handoff. The gate calls Dispose only after it
// has stopped admission and joined native callbacks/workers. Dispose records that
// fact; it deliberately does not close the handles needed for the session's final
// proof. On an uncertain drain the caller must retain this receipt, never reclaim it.
internal sealed class ProviderLifetimeReceipt : IProviderWorkAuthority
{
    private readonly object gate = new();
    private readonly object owner;
    private readonly Action<FileStream, ConnectedGenerationHeldObservation> verify;
    private FileStream? session;
    private ConnectedGenerationHeldObservation? observation;
    private IProviderWorkAuthority? selector;
    private bool drained;

    private ProviderLifetimeReceipt(object owner, FileStream session, ConnectedGenerationHeldObservation observation,
        IProviderWorkAuthority selector, Action<FileStream, ConnectedGenerationHeldObservation> verify)
    { this.owner = owner; this.session = session; this.observation = observation; this.selector = selector; this.verify = verify; }

    // Caller holds its session operation gate, supplies sole ownership of each
    // resource, and retains aliases to none of them. No I/O or proof occurs while
    // that gate is held. Provider admission verifies after transfer; a failed
    // proof leaves the session owning this receipt for confirmed drain/review.
    internal static ProviderLifetimeReceipt Take(object owner, ref FileStream? session,
        ref ConnectedGenerationHeldObservation? observation, ref IProviderWorkAuthority? selector,
        Action<FileStream, ConnectedGenerationHeldObservation> verify)
    {
        ArgumentNullException.ThrowIfNull(owner); ArgumentNullException.ThrowIfNull(verify);
        var s = session ?? throw new IOException("Session lease is unavailable.");
        var o = observation ?? throw new IOException("Generation observation is unavailable.");
        var a = selector ?? throw new IOException("Selector authority is unavailable.");
        var receipt = new ProviderLifetimeReceipt(owner, s, o, a, verify);
        session = null; observation = null; selector = null;
        return receipt;
    }

    public void VerifyHeld()
    {
        lock (gate) {
            if (drained || session is null || observation is null || selector is null) throw new IOException("Provider authority is unavailable.");
            verify(session, observation); selector.VerifyHeld();
        }
    }

    // Called by the provider's admission gate only after confirmed drain.
    public void Dispose() { lock (gate) { drained = true; } }

    // Caller holds the original session operation gate. Failed validation retains
    // all three resources; successful validation moves them back as one receipt.
    internal (FileStream Session, ConnectedGenerationHeldObservation Observation, IProviderWorkAuthority Selector) Reclaim(object requested)
    {
        lock (gate) {
            if (!ReferenceEquals(owner, requested) || !drained || session is null || observation is null || selector is null)
                throw new IOException("Drained provider receipt is unavailable or foreign.");
            verify(session, observation); selector.VerifyHeld();
            var result = (session, observation, selector);
            session = null; observation = null; selector = null;
            return result;
        }
    }
}
