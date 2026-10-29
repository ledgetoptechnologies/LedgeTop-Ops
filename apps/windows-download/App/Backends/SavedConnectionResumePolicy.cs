namespace LedgeTop.Files.Backends;

// Local routing coordinates only. OwnedReady must come from a prepared session's
// CanReconnectCached proof (index + exact profile receipt + frozen manifest scope).
// The consumer must still use ReconnectCachedAsync to verify that profile's pinned
// source and principal; a failure never falls through to another profile or new login.
internal enum SavedProfileState { Absent, Removed, OwnedReady, NeedsReview }
internal sealed record SavedProfileObservation(AccessMode Mode, SavedProfileState State);
internal enum SavedResumeStatus { ResumeOwned, DiscoverAccount, NeedsReview }
internal sealed record SavedResumeDecision(SavedResumeStatus Status, AccessMode? Mode = null);
internal static class SavedConnectionResumePolicy
{
    internal static SavedResumeDecision Decide(IReadOnlyList<AccessMode> configured, IReadOnlyList<SavedProfileObservation> profiles)
    {
        if (configured.Count is < 1 or > 2 || configured.Distinct().Count() != configured.Count ||
            configured.Any(mode => !Enum.IsDefined(mode)) || profiles.Count != configured.Count ||
            profiles.Select(item => item.Mode).Distinct().Count() != profiles.Count ||
            profiles.Any(item => !configured.Contains(item.Mode) || !Enum.IsDefined(item.State)))
            return new(SavedResumeStatus.NeedsReview);
        // A well-formed damaged profile is not an eligibility decision. Preserve all roots
        // and let authoritative discovery identify the account; selected-root admission
        // must still refuse that root's ownership conflict without adopting it or falling back.
        if (profiles.Any(item => item.State == SavedProfileState.NeedsReview))
            return new(SavedResumeStatus.DiscoverAccount);
        var ready = profiles.Where(item => item.State == SavedProfileState.OwnedReady).ToArray();
        return ready.Length == 1 ? new(SavedResumeStatus.ResumeOwned, ready[0].Mode)
            : new(SavedResumeStatus.DiscoverAccount);
    }
}
