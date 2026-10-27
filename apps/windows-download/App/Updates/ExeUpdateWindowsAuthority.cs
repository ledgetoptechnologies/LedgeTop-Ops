using System.Runtime.Versioning;
using System.Text.RegularExpressions;
using LedgeTop.Files.Backends;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Updates;

/// <summary>One narrow selected human session. Never lists files, asks for grants or calls login.
/// Creating/using this class is a real cached-helper/network operation; synthetic tests must not do so.</summary>
[SupportedOSPlatform("windows")]
internal sealed class ExeUpdateWindowsAuthority : IDisposable
{
    private readonly CloudflareAccessSession session;
    private readonly QueuedDownloadSource source;
    private readonly WindowsAppReleaseClient releases;
    private readonly string principal;
    private IDisposable? pin;

    internal ExeUpdateWindowsAuthority(ReleaseProfile profile, string root, string alias, string principal, string currentVersion)
    {
        if (principal is null || !Regex.IsMatch(principal, @"\Aodqp1_[a-f0-9]{64}\z") || alias is not ("employee" or "portal"))
            throw new IOException("Selected update account unavailable.");
        var application = alias == "portal" ? profile.PortalApplicationUrl : profile.StaffApplicationUrl ?? throw new IOException("Selected update source unavailable.");
        session = new(application, ReleaseProfiles.InstalledPath(root, profile.CloudflaredRelativePath) ?? throw new IOException("Update helper path refused."),
            profile.CloudflaredSha256 ?? throw new IOException("Update helper unconfigured."));
        source = alias == "portal" ? new PortalQueuedDownloadSource(alias, session) : new EmployeeQueuedDownloadSource(alias, session);
        releases = new(session, session.Origin, alias == "portal" ? "/api/client/app" : "/api/app", "pilot", currentVersion);
        this.principal = principal;
    }
    internal Uri Origin => session.Origin;
    internal async Task PinAsync(CancellationToken token)
    {
        if (pin is not null) throw new IOException("Update session already pinned.");
        pin = await session.PinCachedTokenAsync(token).ConfigureAwait(false);
        await CheckPrincipalAsync(token).ConfigureAwait(false);
    }
    private async Task CheckPrincipalAsync(CancellationToken token)
    {
        var selected = await source.GetSessionAsync(token).ConfigureAwait(false);
        if (selected.PrincipalId != principal || selected.ExpiresAt <= DateTimeOffset.UtcNow) throw new AccessDeniedException();
    }
    internal async Task<WindowsAppReleaseStage> StageAsync(string directory, CancellationToken token)
    {
        if (pin is null) throw new IOException("Update session not pinned.");
        await CheckPrincipalAsync(token).ConfigureAwait(false);
        var result = await releases.StageLatestAsync(directory, cancellationToken: token).ConfigureAwait(false);
        await CheckPrincipalAsync(token).ConfigureAwait(false);
        return result;
    }
    internal async Task<bool> CheckExactAsync(ExeUpdateCandidate expected, CancellationToken token)
    {
        if (pin is null || expected.Origin != session.Origin) return false;
        await CheckPrincipalAsync(token).ConfigureAwait(false);
        var current = await releases.CheckAsync(token).ConfigureAwait(false);
        await CheckPrincipalAsync(token).ConfigureAwait(false);
        return current.Status == WindowsAppReleaseStatus.Available && current.CurrentVersion == expected.CurrentVersion && current.Release == expected.Release;
    }
    public void Dispose() { pin?.Dispose(); pin = null; source.Dispose(); releases.Dispose(); }
}
