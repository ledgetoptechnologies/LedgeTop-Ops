using LedgeTop.Files.Backends;

namespace LedgeTop.Files;

/// <summary>Product copy distinguishes generated fixtures from an explicitly selected real source.</summary>
internal sealed record ExplorerWindowContent(bool Generated, string Badge, string Account, string AccountDetail)
{
    internal static ExplorerWindowContent Demo { get; } = new(true, "Demo data", "Demo account · simulated sign-in",
        "This preview uses generated sample files. It does not sign in to Operations or connect to your real files.");
    internal static ExplorerWindowContent Connected(string channelLabel, AccessMode mode, bool employeeOnly = false)
    {
        if (employeeOnly && mode != AccessMode.Employee) throw new ArgumentException("This release supports employee files only.", nameof(mode));
        return new(false, channelLabel, FilesSession.Label(mode), FilesSession.SignInDetail(mode) +
            (employeeOnly ? " " + Startup.ClientUnavailableProblem : ""));
    }
}
