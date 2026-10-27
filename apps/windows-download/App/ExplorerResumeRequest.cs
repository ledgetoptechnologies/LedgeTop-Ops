using LedgeTop.Files.Backends;
using LedgeTop.Files.Updates;

namespace LedgeTop.Files;

// A source coordinate only. Cached reconnect must still prove the existing owned profile and account.
internal sealed record ExplorerResumeRequest(bool Requested, AccessMode? SourceMode)
{
    internal bool IsValid => !Requested || SourceMode is not null;

    internal static ExplorerResumeRequest Parse(IReadOnlyList<string> arguments)
    {
        ArgumentNullException.ThrowIfNull(arguments);
        if (!arguments.Any(value => value.StartsWith("--reconnect-saved-source", StringComparison.OrdinalIgnoreCase)))
            return new(false, null);
        if (arguments.Count != 2 || arguments[0] != ExeUpdateWindowsPolicy.ResumeSavedSourceArgument)
            return new(true, null);
        return new(true, arguments[1] switch { "portal" => AccessMode.Client, "employee" => AccessMode.Employee, _ => null });
    }

    internal bool AllowedIn((bool Packaged, ReleaseChannel? Channel) compiled, IReadOnlyList<AccessMode>? offeredModes = null) =>
        !Requested || compiled.Packaged && compiled.Channel == ReleaseChannel.Pilot && SourceMode is { } mode &&
        (offeredModes is null || offeredModes.Contains(mode));
}
