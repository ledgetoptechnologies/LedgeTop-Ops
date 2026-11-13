using LedgeTop.Files.Explorer;

namespace LedgeTop.Files;

// Owns the exact selector lock, not a callback or alias to a caller-owned lock.
// This is an internal handoff for the staging qualification path only.
internal sealed class StoppedGenerationSelectorAuthority : IStoppedGenerationAuthority
{
    private readonly object gate = new();
    private SelectorIndexOwnership? lease;
    private readonly FreshGenerationSelectorLease selectorLease;
    private readonly FreshGenerationIndexCodec.Index expected;
    private readonly string current, backup, sid, channel, alias, originHash;
    private readonly bool previous;

    private StoppedGenerationSelectorAuthority(SelectorIndexOwnership owned, FreshGenerationSelectorLease selectorLease,
        FreshGenerationIndexCodec.Index expected, string current, string backup,
        string sid, string channel, string alias, string originHash, bool previous)
    {
        lease=owned; this.selectorLease=selectorLease; this.expected=expected; this.current=current; this.backup=backup;
        this.sid=sid; this.channel=channel; this.alias=alias; this.originHash=originHash; this.previous=previous;
    }
    internal static StoppedGenerationSelectorAuthority Acquire(string lockPath,
        FreshGenerationIndexCodec.Index expected, string current, string backup,
        string sid, string channel, string alias, string originHash, bool previous)
    {
        SelectorIndexOwnership? owned = SelectorIndexOwnership.Acquire(lockPath);
        try { return Adopt(ref owned,lockPath,expected,current,backup,sid,channel,alias,originHash,previous); }
        finally { owned?.Dispose(); }
    }
    // Caller must serialize access to its capability variable. On failure before
    // transfer the original remains live; stale object aliases are revoked after it.
    internal static StoppedGenerationSelectorAuthority Adopt(ref SelectorIndexOwnership? owned, string lockPath,
        FreshGenerationIndexCodec.Index expected, string current, string backup,
        string sid, string channel, string alias, string originHash, bool previous)
    {
        var parent=Path.GetDirectoryName(Path.GetFullPath(current)) ?? throw new IOException("Selector directory is unavailable.");
        if (!string.Equals(Path.GetFullPath(current),Path.Combine(parent,FreshGenerationIndexStore.Current),StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFullPath(backup),Path.Combine(parent,FreshGenerationIndexStore.LegacyBackup),StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFullPath(lockPath),Path.Combine(parent,"index.lock"),StringComparison.OrdinalIgnoreCase))
            throw new IOException("Selector and lock paths differ.");
        var source=owned ?? throw new IOException("Selector index lock is unavailable.");
        if(!source.MatchesPath(lockPath)) throw new IOException("Selector lock path differs from owner.");
        FreshGenerationSelectorLease? pinned=null;
        try {
            source.VerifyHeld();
            pinned=FreshGenerationSelectorLease.Acquire(parent,expected);
            if(FreshGenerationStartup.Observe(current,backup,sid,channel,alias,originHash)!=expected)
                throw new IOException("Owned selector is unavailable or changed.");
            source.VerifyHeld(); pinned.VerifyHeld();
            var authority=new StoppedGenerationSelectorAuthority(source,pinned,expected,current,backup,sid,channel,alias,originHash,previous);
            authority.lease=source.Transfer();
            owned=null; pinned=null;
            return authority;
        } catch { pinned?.Dispose(); throw; }
    }
    public void VerifyHeld()
    {
        lock(gate) VerifySelector();
    }
    public void VerifyHeld(RestartGenerationEvidence evidence)
    {
        lock(gate) {
            VerifySelector();
            var state=expected.State;
            var generation=previous ? state.Old : state.New ?? throw new IOException("Candidate generation is unavailable.");
            var ready=state.ReadyRoot ?? throw new IOException("Ready generation evidence is unavailable.");
            if(state.Phase!=FreshGenerationPlan.Phase.Published || state.New is null || expected.ActiveGeneration!=state.New.Id ||
                !FreshGenerationColdRestart.Matches(evidence,generation,previous?generation.RootVolume:ready.Volume,
                    previous?generation.RootFileId:ready.FileId,previous?generation.NamespaceClsid:ready.NamespaceClsid,
                    previous?generation.ProfileRevision:ready.ProfileRevision,previous?generation.ProfileDocumentVolume:ready.ProfileDocumentVolume,
                    previous?generation.ProfileDocumentFileId:ready.ProfileDocumentFileId))
                throw new IOException("Stopped generation differs from the owned selector.");
            VerifySelector();
        }
    }
    private void VerifySelector()
    {
        selectorLease.VerifyHeld();
        (lease ?? throw new ObjectDisposedException(nameof(StoppedGenerationSelectorAuthority))).VerifyHeld();
        if(FreshGenerationStartup.Observe(current,backup,sid,channel,alias,originHash)!=expected)
            throw new IOException("Owned selector is unavailable or changed.");
    }
    public void Dispose() { lock(gate) { if(lease is null)return; selectorLease.Dispose(); lease.Dispose(); lease=null; } }
}
