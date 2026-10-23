using System.Reflection;
using System.Text.RegularExpressions;

namespace LedgeTop.Files.Backends;

public enum ReleaseChannel { Pilot, Stable }

/// <summary>
/// The reviewed connection details compiled into a packaged release. Nothing here can be changed after the
/// build: not by a settings file, a command-line argument or an environment variable. The sign-in helper is
/// found relative to the installation folder and must match <see cref="CloudflaredSha256"/>.
/// A null hash means the helper hasn't been reviewed yet, and the release refuses to start.
/// </summary>
public sealed record ReleaseProfile(ReleaseChannel Channel, Uri PortalApplicationUrl, Uri? StaffApplicationUrl,
    string CloudflaredRelativePath, string? CloudflaredSha256);

public static class ReleaseProfiles
{
    /// <summary>The assembly metadata key the build sets for packaged releases (MSBuild property LedgeTopReleaseChannel).</summary>
    public const string ChannelKey = "LedgeTop.ReleaseChannel";
    /// <summary>Set to "developer" only by an explicit developer build (MSBuild property LedgeTopDeveloperBuild=true).</summary>
    public const string BuildModeKey = "LedgeTop.BuildMode";

    /// <summary>
    /// Pilot uses the existing staging hosts (docs/portal-origin-migration.md, docs/windows-files-staging-acceptance.md):
    /// the portal's Access application is path-scoped at /portal, and staff files are the Ops /api/staff/files routes.
    /// The helper is the qualified vendor candidate in docs/windows-download-release-plan.md: official cloudflared
    /// 2026.10.3 windows-amd64, Authenticode-signed by Cloudflare. That is build provenance, not live sign-in acceptance.
    /// Stable stays unconfigured until production origins and the helper are reviewed; ledgetop.app is not used until
    /// that domain migration is accepted.
    /// </summary>
    public static ReleaseProfile? For(ReleaseChannel channel) => channel switch {
        ReleaseChannel.Pilot => new(ReleaseChannel.Pilot,
            new Uri("https://portal-staging.ledgetopdroneservices.com/portal"),
            new Uri("https://ops-staging.ledgetopdroneservices.com/api/staff/files"),
            @"helper\cloudflared.exe", "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2"),
        _ => null,
    };

    /// <summary>
    /// What this build is. Packaged with a channel; a developer build only when it was built explicitly as one
    /// (and has no channel); otherwise packaged with an unknown channel, which refuses to start. So a plain Release
    /// build, a mistyped channel or a mixed build never quietly behaves like a developer build or shows demo data.
    /// </summary>
    public static (bool Packaged, ReleaseChannel? Channel) Compiled(Assembly assembly) =>
        Compiled(assembly.GetCustomAttributes<AssemblyMetadataAttribute>());

    public static (bool Packaged, ReleaseChannel? Channel) Compiled(IEnumerable<AssemblyMetadataAttribute> metadata)
    {
        var items = metadata.ToList();
        var values = items.Where(item => item.Key == ChannelKey).Select(item => item.Value).ToList();
        var modes = items.Where(item => item.Key == BuildModeKey).Select(item => item.Value).ToList();
        if (values.Count == 0 && modes is ["developer"]) return (false, null);
        if (modes.Count != 0) return (true, null);
        return (true, values is ["pilot"] ? ReleaseChannel.Pilot : values is ["stable"] ? ReleaseChannel.Stable : null);
    }

    /// <summary>A plain relative path inside the installation folder: no drive, root, "..", or alternate stream.</summary>
    internal static string? InstalledPath(string installDirectory, string relative)
    {
        if (relative.Length is 0 or > 200 || Path.IsPathRooted(relative) || !Regex.IsMatch(relative, @"\A[A-Za-z0-9_.-]+(\\[A-Za-z0-9_.-]+)*\z")
            || relative.Split('\\').Any(part => part is "." or "..")) return null;
        var root = Path.GetFullPath(installDirectory);
        var full = Path.GetFullPath(Path.Combine(root, relative));
        return full.StartsWith(Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ? full : null;
    }
}
