using LedgeTop.Files.Presentation;

namespace LedgeTop.Files.Backends;

/// <summary>What the window should open with: a ready backend (demo), a choice of access (real sources), or a plain
/// reason it can't.</summary>
public sealed record StartupPlan(IFilesBackend? Backend, string? Problem, string Downloads, string? Tag, AccessChoice? Access = null);

/// <summary>
/// Real sources open one kind of files at a time. <see cref="Create"/> builds only the chosen source from the fixed,
/// trusted setup; nothing signs in until the person has chosen. The remembered choice is a convenience, not authority.
/// </summary>
public sealed record AccessChoice(Func<AccessMode, IFilesBackend> Create, IReadOnlyList<AccessMode> Modes, AccessPreference Preference);

/// <summary>
/// Chooses how this copy runs. A packaged release (channel compiled in) uses only its compiled profile and its own
/// state folder, and ignores settings files, arguments and environment variables. A developer build keeps the
/// explicit --demo mode and the developer settings file, with its own state folder. Nothing moves or deletes
/// another channel's download records.
/// </summary>
public static class Startup
{
    public const string HelperProblem = "The sign-in helper installed with Ledge Top Files is missing or has been changed, so it can't be trusted. Reinstall Ledge Top Files or ask your Ledge Top contact to check it.";
    public const string UnreviewedProblem = "This release of Ledge Top Files isn't ready to connect yet. Use a newer release or ask your Ledge Top contact.";
    public const string UnknownReleaseProblem = "This copy of Ledge Top Files has an unknown release setting, so it won't connect. Reinstall Ledge Top Files or ask your Ledge Top contact.";

    /// <summary>The pinned helper exists as a plain local file (no links on its path) with exactly the expected SHA-256.</summary>
    internal static bool HelperTrusted(string path, string sha256)
    {
        try {
            if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal)) return false;
            for (string? part = Path.GetFullPath(path); part is not null; part = Path.GetDirectoryName(part))
                if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) return false;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(stream)).Equals(sha256, StringComparison.OrdinalIgnoreCase);
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return false; }
    }

    /// <summary>The state root for one channel. Each keeps per-source and per-person folders beneath it.</summary>
    public static string StateRoot(string localAppData, string channelFolder) =>
        Path.Combine(localAppData, "LedgeTop", "Files", channelFolder, "queue");

    public static StartupPlan Choose((bool Packaged, ReleaseChannel? Channel) compiled, IReadOnlyList<string> arguments,
        string localAppData, string userProfile, string installDirectory, Func<ReleaseChannel, ReleaseProfile?> profiles)
    {
        var downloads = Path.Combine(userProfile, "Downloads", "Ledge Top");
        if (compiled.Packaged) {
            // Packaged: no argument, file or environment value is consulted.
            if (compiled.Channel is not { } channel) return new(null, UnknownReleaseProblem, downloads, null);
            var tag = channel == ReleaseChannel.Pilot ? "Pilot" : null;
            var profile = profiles(channel);
            if (profile is null || profile.Channel != channel || profile.CloudflaredSha256 is null) return new(null, UnreviewedProblem, downloads, tag);
            var helper = ReleaseProfiles.InstalledPath(installDirectory, profile.CloudflaredRelativePath);
            if (helper is null) return new(null, UnreviewedProblem, downloads, tag);
            var settings = new LiveSettings(profile.PortalApplicationUrl, profile.StaffApplicationUrl, helper, profile.CloudflaredSha256);
            var folder = channel == ReleaseChannel.Pilot ? "pilot" : "stable";
            return Choice(settings, localAppData, folder, downloads, tag) ?? new(null, HelperProblem, downloads, tag);
        }
        if (arguments.Contains("--demo") || arguments.Contains("--demo-signed-in")) {
            var root = Path.Combine(Path.GetTempPath(), "LedgeTopFilesDemo");
            var minutes = arguments.SkipWhile(value => value != "--demo-session-minutes").Skip(1).FirstOrDefault();
            return new(new DemoBackend(Path.Combine(root, "queue"), signedIn: arguments.Contains("--demo-signed-in"),
                sessionLength: double.TryParse(minutes, out var length) ? TimeSpan.FromMinutes(length) : null),
                null, Path.Combine(root, "Downloads"), "Demo data");
        }
        LiveSettings? developer;
        try { developer = LiveSettings.Load(LiveSettings.PathUnder(localAppData)); }
        catch (SettingsException error) { return new(null, error.Message, downloads, null); }
        if (developer is null) return new(null, null, downloads, null);
        return Choice(developer, localAppData, "developer", downloads, "Developer") ?? new(null, HelperProblem, downloads, null);
    }

    /// <summary>
    /// Offers client deliveries, plus company files when this setup includes the staff application. The pinned helper
    /// is checked now, so a missing or changed helper is reported before anyone is asked to choose or sign in.
    /// </summary>
    private static StartupPlan? Choice(LiveSettings settings, string localAppData, string folder, string downloads, string? tag)
    {
        var root = StateRoot(localAppData, folder);
        // Check the helper itself, without building either source: each source is only built after it is chosen,
        // and the chosen source checks the helper again before it is used.
        if (!HelperTrusted(settings.CloudflaredPath, settings.CloudflaredSha256)) return null;
        AccessMode[] modes = settings.StaffApplicationUrl is null ? [AccessMode.Client] : [AccessMode.Client, AccessMode.Employee];
        return new(null, null, downloads, tag, new AccessChoice(mode => new LiveBackend(settings, root, mode), modes, AccessPreference.For(localAppData, folder)));
    }
}
