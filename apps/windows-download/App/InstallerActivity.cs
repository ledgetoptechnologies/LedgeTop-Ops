using LedgeTop.Files.Backends;

namespace LedgeTop.Files;

/// <summary>New pilot builds honor the installer's session-local activity object. Older builds do not implement this protocol.</summary>
internal static class InstallerActivity
{
    internal const string ObjectName = @"Local\LedgeTopFilesPilotInstaller";

    internal static bool BlocksStartup((bool Packaged, ReleaseChannel? Channel) compiled, IReadOnlyList<string> arguments,
        Func<string, bool>? exists = null)
    {
        if (!compiled.Packaged || compiled.Channel != ReleaseChannel.Pilot || InstallerMaintenance.Requested(arguments)) return false;
        try { return (exists ?? Exists)(ObjectName); }
        catch { return true; } // An unreadable/unknown installer state must not permit new provider work.
    }

    internal static bool Exists(string name)
    {
        if (!Mutex.TryOpenExisting(name, out var activity)) return false;
        activity.Dispose(); // Observe existence only; never acquire, release or create installer ownership.
        return true;
    }
}
