using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;
using LedgeTop.Files.Updates;

internal static class EmployeeFirstReleaseTests
{
    internal static async Task Run()
    {
        var modes = Startup.InstalledModes;
        Need(modes.SequenceEqual([AccessMode.Employee]), "installed entry has one source, so App opens Settings without a source chooser");
        var content = ExplorerWindowContent.Connected("Pilot", AccessMode.Employee, employeeOnly: true);
        Need(content.Badge == "Pilot" && !content.Generated && content.Account == "Company files" &&
            content.AccountDetail.Contains(Startup.ClientUnavailableProblem, StringComparison.Ordinal),
            "employee settings retain Pilot and clearly explain unavailable client access before sign-in");
        var refusedPresentation = false;
        try { _ = ExplorerWindowContent.Connected("Pilot", AccessMode.Client, employeeOnly: true); }
        catch (ArgumentException) { refusedPresentation = true; }
        Need(refusedPresentation, "an accidentally supplied client coordinate cannot be shown as an employee connection");

        // The same offered list is consumed by real startup admission and passive saved-profile routing.
        // A pre-existing client profile is deliberately not prepared, authenticated, disposed or removed.
        var probes = new List<AccessMode>(); var employee = new PassiveSession();
        var first = await SavedConnectionStartupRouter.PrepareAsync(new(false, null), modes, mode => {
            probes.Add(mode); if (mode != AccessMode.Employee) throw new Exception("Client state must remain untouched.");
            return new(employee, SavedProfileState.Absent);
        });
        Need(first.Kind == SavedStartupRouteKind.Choose && first.Mode is null && probes.SequenceEqual([AccessMode.Employee]) && employee.Disposals == 1,
            "new employee connection inspects only employee state; the single offered source bypasses the UI chooser");
        probes.Clear(); employee = new PassiveSession();
        var saved = await SavedConnectionStartupRouter.PrepareAsync(new(false, null), modes, mode => {
            probes.Add(mode); return new(employee, SavedProfileState.OwnedReady);
        });
        Need(saved.Kind == SavedStartupRouteKind.OwnedResume && saved.Mode == AccessMode.Employee && saved.Reconnect &&
            ReferenceEquals(saved.Prepared, employee) && employee.Disposals == 0 && probes.SequenceEqual([AccessMode.Employee]),
            "saved employee startup retains the precise owned session for fresh authorization; it does not inspect client state");
        await saved.Prepared!.DisposeAsync();
        foreach (var argument in new[] { ExplorerResumeRequest.StartupSavedSourceArgument, ExeUpdateWindowsPolicy.ResumeSavedSourceArgument }) {
            var client = ExplorerResumeRequest.Parse([argument, "portal"]);
            Need(!client.AllowedIn((true, ReleaseChannel.Pilot), modes), "old client logon/update resume is refused rather than switched");
            var route = await SavedConnectionStartupRouter.PrepareAsync(client, modes, _ => throw new Exception("Rejected client must not probe employee or client."));
            Need(route.Kind == SavedStartupRouteKind.Refused && route.Mode is null && !route.Reconnect, "reserved client refusal has no source fallback");
            var staff = ExplorerResumeRequest.Parse([argument, "employee"]);
            Need(staff.AllowedIn((true, ReleaseChannel.Pilot), modes), "exact employee coordinate remains eligible for existing fresh cached checks");
        }
        Console.WriteLine("Employee first-release entry: one installed source, client-unavailable presentation/factory contract, passive saved-source isolation and pinned resume passed. No account-role inference, authentication, registry or provider calls.");
    }
    private static void Need(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
    private sealed class PassiveSession : IExplorerPreviewSession
    {
        internal int Disposals;
        public string RootPath => "synthetic-no-root";
        public ExplorerPreviewState State => ExplorerPreviewState.NotStarted;
        public IReadOnlyList<string> Activity => [];
        public event EventHandler? Changed { add { } remove { } }
        public Task StartAsync() => throw new InvalidOperationException("Passive startup cannot authenticate or open a provider.");
        public Task PauseAsync() => throw new InvalidOperationException();
        public Task ResumeAsync() => throw new InvalidOperationException();
        public Task RemoveAsync() => throw new InvalidOperationException("Client/local files must remain untouched.");
        public ValueTask DisposeAsync() { Disposals++; return ValueTask.CompletedTask; }
    }
}
