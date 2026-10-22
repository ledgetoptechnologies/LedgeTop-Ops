using LedgeTop.Files.Presentation;

namespace LedgeTop.Files.Backends;

/// <summary>What the window should open with: a backend, or a plain reason it can't.</summary>
public sealed record StartupPlan(IFilesBackend? Backend, string? Problem, string Downloads, string? Tag);

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
            try { return new(new LiveBackend(settings, StateRoot(localAppData, channel == ReleaseChannel.Pilot ? "pilot" : "stable")), null, downloads, tag); }
            catch (Exception) { return new(null, HelperProblem, downloads, tag); }
        }
        if (arguments.Contains("--demo") || arguments.Contains("--demo-signed-in")) {
            var root = Path.Combine(Path.GetTempPath(), "LedgeTopFilesDemo");
            var minutes = arguments.SkipWhile(value => value != "--demo-session-minutes").Skip(1).FirstOrDefault();
            return new(new DemoBackend(Path.Combine(root, "queue"), signedIn: arguments.Contains("--demo-signed-in"),
                sessionLength: double.TryParse(minutes, out var length) ? TimeSpan.FromMinutes(length) : null),
                null, Path.Combine(root, "Downloads"), "Demo data");
        }
        var (live, problem) = LiveBackend.Open(LiveSettings.PathUnder(localAppData), StateRoot(localAppData, "developer"));
        return new(live, problem, downloads, live is null ? null : "Developer");
    }
}
