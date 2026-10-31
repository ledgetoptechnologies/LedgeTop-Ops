namespace LedgeTop.Files.Backends;

// Native-only seam pending the owner's HTTP and audience-bootstrap contract. This is
// deliberately not a wire DTO and is not connected to Startup or the live backend.
// A verified adapter mints one opaque binding per authenticated account/session generation;
// no email, domain, local Windows identity, credential or locally decoded claim is authority.
internal sealed class UnifiedAccountBinding;
internal enum UnifiedDiscoveryStatus { Complete, LoginRequired, Denied, Disabled, Unavailable, Invalid }
internal sealed record UnifiedDiscoveryObservation(Guid Attempt, UnifiedAccountBinding Account,
    UnifiedDiscoveryStatus Status, bool? ClientEligible = null, bool? EmployeeEligible = null, AccessMode? SelectedSource = null);
internal enum UnifiedSignInStatus { Selected, NoAccess, Ambiguous, LoginRequired, Denied, Disabled, Unavailable, Invalid, Stale }
internal sealed record UnifiedSignInDecision(UnifiedSignInStatus Status, AccessMode? Mode = null);

internal static class UnifiedSignInPolicy
{
    internal static UnifiedSignInDecision Decide(Guid attempt, UnifiedAccountBinding account, UnifiedDiscoveryObservation observation)
    {
        if (attempt == Guid.Empty || observation.Attempt != attempt || !ReferenceEquals(account, observation.Account))
            return new(UnifiedSignInStatus.Stale);
        if (!Enum.IsDefined(observation.Status)) return new(UnifiedSignInStatus.Invalid);
        if (observation.Status != UnifiedDiscoveryStatus.Complete) {
            if (observation.ClientEligible is not null || observation.EmployeeEligible is not null || observation.SelectedSource is not null)
                return new(UnifiedSignInStatus.Invalid);
            return new(observation.Status switch {
                UnifiedDiscoveryStatus.LoginRequired => UnifiedSignInStatus.LoginRequired,
                UnifiedDiscoveryStatus.Denied => UnifiedSignInStatus.Denied,
                UnifiedDiscoveryStatus.Disabled => UnifiedSignInStatus.Disabled,
                UnifiedDiscoveryStatus.Unavailable => UnifiedSignInStatus.Unavailable,
                _ => UnifiedSignInStatus.Invalid
            });
        }
        if (observation.ClientEligible is not { } client || observation.EmployeeEligible is not { } employee)
            return new(UnifiedSignInStatus.Invalid);
        if (!client && !employee)
            return new(observation.SelectedSource is null ? UnifiedSignInStatus.NoAccess : UnifiedSignInStatus.Invalid);
        if (observation.SelectedSource is not { } selected)
            return new(client && employee ? UnifiedSignInStatus.Ambiguous : UnifiedSignInStatus.Invalid);
        // Routing must be explicit in the authoritative response. Windows neither chooses
        // by boolean order nor tests a different audience after a rejection/error.
        if (selected != AccessMode.Client && selected != AccessMode.Employee ||
            selected == AccessMode.Client && !client || selected == AccessMode.Employee && !employee)
            return new(UnifiedSignInStatus.Invalid);
        return new(UnifiedSignInStatus.Selected, selected);
    }
}
