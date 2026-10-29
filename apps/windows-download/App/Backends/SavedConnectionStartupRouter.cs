using LedgeTop.Files.Explorer;

namespace LedgeTop.Files.Backends;

internal sealed record StartupProfileProbe(IExplorerPreviewSession Session, SavedProfileState State);
internal enum SavedStartupRouteKind { PinnedRequest, OwnedResume, Choose, Refused }
// The caller owns Prepared after successful return and hands it directly to Settings.
// Retaining the actual prepared instance preserves its index principal across the routing handoff.
internal sealed record SavedStartupRoute(SavedStartupRouteKind Kind, AccessMode? Mode = null,
    IExplorerPreviewSession? Prepared = null)
{
    internal bool Reconnect => Kind is SavedStartupRouteKind.PinnedRequest or SavedStartupRouteKind.OwnedResume;
}
internal static class SavedConnectionStartupRouter
{
    internal static async Task<SavedStartupRoute> PrepareAsync(ExplorerResumeRequest request,
        IReadOnlyList<AccessMode> configured, Func<AccessMode, StartupProfileProbe> prepare)
    {
        if (configured.Count is < 1 or > 2 || configured.Distinct().Count() != configured.Count || configured.Any(mode => !Enum.IsDefined(mode)))
            return new(SavedStartupRouteKind.Refused);
        // Reserved update/logon requests never inspect another source or fall back to choice.
        if (request.Requested)
            return request.SourceMode is { } pinned && configured.Contains(pinned)
                ? new(SavedStartupRouteKind.PinnedRequest, pinned) : new(SavedStartupRouteKind.Refused);
        var probes = new List<(AccessMode Mode, StartupProfileProbe Probe)>();
        IExplorerPreviewSession? retained = null;
        Exception? failure = null;
        SavedStartupRoute route = new(SavedStartupRouteKind.Choose);
        try {
            foreach (var configuredMode in configured) probes.Add((configuredMode, prepare(configuredMode)));
            var decision = SavedConnectionResumePolicy.Decide(configured,
                probes.Select(item => new SavedProfileObservation(item.Mode, item.Probe.State)).ToArray());
            if (decision is { Status: SavedResumeStatus.ResumeOwned, Mode: { } mode }) {
                retained = probes.Single(item => item.Mode == mode).Probe.Session;
                route = new(SavedStartupRouteKind.OwnedResume, mode, retained);
            } else if (decision.Status == SavedResumeStatus.NeedsReview) route = new(SavedStartupRouteKind.Refused);
        } catch (Exception error) { failure = error; }
        // No probe starts/authenticates a backend or provider. Drain every unselected
        // prepared session before exposing selection or opening the explicit chooser.
        foreach (var item in probes) {
            if (ReferenceEquals(item.Probe.Session, retained)) continue;
            try { await item.Probe.Session.DisposeAsync(); } catch (Exception error) { failure ??= error; }
        }
        if (failure is not null) {
            if (retained is not null) { try { await retained.DisposeAsync(); } catch { } }
            throw new IOException("Saved connection preparation could not finish safely.", failure);
        }
        return route;
    }
}
