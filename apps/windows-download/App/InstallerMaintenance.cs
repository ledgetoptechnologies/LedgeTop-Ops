using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;

namespace LedgeTop.Files;

/// <summary>Silent pilot-only owned-index maintenance. Success is not a claim that untracked Windows registrations are absent.</summary>
internal static class InstallerMaintenance
{
    internal const string CheckArgument = "--installer-check", RemoveArgument = "--installer-remove-connections";
    internal static bool Requested(IReadOnlyList<string> arguments) => arguments.Any(value => value.StartsWith("--installer", StringComparison.OrdinalIgnoreCase));

    internal static Task<int> RunAsync((bool Packaged, ReleaseChannel? Channel) compiled, IReadOnlyList<string> arguments) =>
        RunAsync(compiled, arguments, () => SingleInstance.TryOwn("pilot", () => { }), Prepare);

    // This method intentionally preserves its caller's synchronization context: Windows mutex ownership
    // must be released on the original UI thread after all async session work has drained.
    internal static async Task<int> RunAsync((bool Packaged, ReleaseChannel? Channel) compiled, IReadOnlyList<string> arguments,
        Func<IDisposable?> tryOwn, Func<AccessMode, IExplorerPreviewSession> prepare)
    {
        if (!compiled.Packaged || compiled.Channel != ReleaseChannel.Pilot || arguments.Count != 1 ||
            arguments[0] is not (CheckArgument or RemoveArgument)) return 20;
        var sessions = new List<IExplorerPreviewSession>();
        var result = 20;
        try {
            using var owner = tryOwn();
            if (owner is null) return 10;
            try {
                // Validate both sources before any removal. No helper, backend or source request exists here.
                foreach (var mode in new[] { AccessMode.Client, AccessMode.Employee }) {
                    var session = prepare(mode); sessions.Add(session);
                    if (session.State == ExplorerPreviewState.Failed) throw new IOException("Owned connection needs review.");
                }
                if (arguments[0] == RemoveArgument) foreach (var session in sessions) {
                    await session.RemoveAsync();
                    if (session.State != ExplorerPreviewState.Removed) throw new IOException("Owned removal was not confirmed.");
                }
                result = 0;
            } catch { result = 20; }
            finally {
                foreach (var session in sessions) {
                    try { await session.DisposeAsync(); } catch { result = 20; }
                }
            }
        } catch { return 20; }
        return result;
    }

    private static IExplorerPreviewSession Prepare(AccessMode mode)
    {
        var profile = ReleaseProfiles.For(ReleaseChannel.Pilot) ?? throw new IOException("Pilot profile unavailable.");
        if (profile.Channel != ReleaseChannel.Pilot || profile.StaffApplicationUrl is null) throw new IOException("Pilot sources unavailable.");
        var origin = new Uri((mode == AccessMode.Client ? profile.PortalApplicationUrl : profile.StaffApplicationUrl).GetLeftPart(UriPartial.Authority));
        var stateBase = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTop", "Files", "pilot");
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "LedgeTop Files Pilot — " + (mode == AccessMode.Client ? "Client deliveries" : "Company files"));
        var indexPath = Path.Combine(stateBase, "connected-explorer-pilot-" + AccessModes.Alias(mode), "current.json");
        if (!File.Exists(indexPath)) RefuseUntrackedRootAliases(root);
        return new ConnectedExplorerSession(() => throw new InvalidOperationException("Installer maintenance cannot create a backend."),
            "pilot", AccessModes.Alias(mode), origin, stateBase, root);
    }

    internal static void RefuseUntrackedRootAliases(string root, Func<string, int>? inspect = null)
    {
        // This context is intentionally not an ownership claim. Any registered root, even one
        // matching this value, is refused; only the exact native absence status is acceptable.
        inspect ??= candidate => NativeRootRegistration.Inspect(candidate,
            System.Text.Encoding.UTF8.GetBytes("LedgeTop.Files.InstallerMaintenance.ReadOnly/1")).Hresult;
        var parent = Path.GetDirectoryName(root)!;
        if (!Directory.Exists(parent)) throw new IOException("The local profile is unavailable.");
        var leaf = Path.GetFileName(root);
        foreach (var candidate in Directory.EnumerateFileSystemEntries(parent, leaf + "*", SearchOption.TopDirectoryOnly)) {
            var name = Path.GetFileName(candidate);
            if (name != leaf) {
                if (!name.StartsWith(leaf + " (", StringComparison.Ordinal) || !name.EndsWith(')')) continue;
                var suffix = name[(leaf.Length + 2)..^1];
                if (!int.TryParse(suffix, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var number) ||
                    number is < 2 or > 9999 || suffix != number.ToString(System.Globalization.CultureInfo.InvariantCulture)) continue;
            }
            if (inspect(candidate) != unchecked((int)0x80070186))
                throw new IOException("An untracked Explorer root has registered or unknown native state and requires ownership review.");
        }
    }
}
