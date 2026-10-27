using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Updates;

internal static class ExplorerResumeRequestTests
{
    internal static Task Run()
    {
        foreach (var (alias, mode) in new[] { ("portal", AccessMode.Client), ("employee", AccessMode.Employee) }) {
            var request = ExplorerResumeRequest.Parse([ExeUpdateWindowsPolicy.ResumeSavedSourceArgument, alias]);
            Require(request.Requested && request.IsValid && request.SourceMode == mode &&
                request.AllowedIn((true, ReleaseChannel.Pilot), [mode]), "exact offered pilot source coordinate is admitted");
            var other = mode == AccessMode.Client ? AccessMode.Employee : AccessMode.Client;
            Require(!request.AllowedIn((true, ReleaseChannel.Pilot), [other]) &&
                !request.AllowedIn((false, null)) && !request.AllowedIn((true, null)) &&
                !request.AllowedIn((true, ReleaseChannel.Stable)), "unoffered source and unconfigured build never fall back to another source");
        }
        foreach (var arguments in new string[][] {
            [ExeUpdateWindowsPolicy.ResumeSavedSourceArgument],
            [ExeUpdateWindowsPolicy.ResumeSavedSourceArgument, "portal", "extra"],
            [ExeUpdateWindowsPolicy.ResumeSavedSourceArgument, "Portal"],
            [ExeUpdateWindowsPolicy.ResumeSavedSourceArgument, "https://other.invalid"],
            ["--RECONNECT-SAVED-SOURCE-V1", "employee"],
            ["--reconnect-saved-source-v2", "portal"],
            ["extra", ExeUpdateWindowsPolicy.ResumeSavedSourceArgument, "employee"]
        }) {
            var request = ExplorerResumeRequest.Parse(arguments);
            Require(request.Requested && !request.IsValid && request.SourceMode is null &&
                !request.AllowedIn((true, ReleaseChannel.Pilot)), "malformed reserved launch cannot select a source");
        }
        var normal = ExplorerResumeRequest.Parse([]);
        Require(!normal.Requested && normal.IsValid && normal.SourceMode is null && normal.AllowedIn((false, null)),
            "ordinary startup retains its existing chooser and authorization flow");
        Console.WriteLine("Saved-source resume admission passed; no account, sign-in, files or native provider operation.");
        return Task.CompletedTask;
    }
    private static void Require(bool value, string message) { if (!value) throw new Exception(message); }
}
