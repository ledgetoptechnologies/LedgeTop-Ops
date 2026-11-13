using System.Windows;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;
using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;

internal static class SavedConnectionStartupRouterTests
{
    internal static async Task Run()
    {
        var configured = new[] { AccessMode.Client, AccessMode.Employee };
        foreach (var mode in configured) {
            var sessions = new Dictionary<AccessMode, ProbeSession>();
            var otherDisposed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var routing = SavedConnectionStartupRouter.PrepareAsync(new(false, null), configured, selected => {
                var session = new ProbeSession { DisposeGate = selected == mode ? null : otherDisposed.Task };
                sessions.Add(selected, session);
                return new(session, selected == mode ? SavedProfileState.OwnedReady : SavedProfileState.Absent);
            });
            Need(!routing.IsCompleted && sessions[mode].Disposals == 0,
                "unselected preparation must drain before owned resume can be exposed");
            otherDisposed.SetResult(); var route = await routing;
            Need(route.Kind == SavedStartupRouteKind.OwnedResume && route.Mode == mode && route.Reconnect &&
                ReferenceEquals(route.Prepared, sessions[mode]) && sessions[mode].Disposals == 0 && sessions.Where(item => item.Key != mode).All(item => item.Value.Disposals == 1),
                "only exactly-one owned ready profile bypasses chooser; retain that precise instance/index identity for fresh cached principal verification");
            await route.Prepared!.DisposeAsync();
        }
        foreach (var states in new[] {
            new[] { SavedProfileState.Absent, SavedProfileState.Absent },
            new[] { SavedProfileState.OwnedReady, SavedProfileState.OwnedReady },
            new[] { SavedProfileState.NeedsReview, SavedProfileState.OwnedReady },
            new[] { SavedProfileState.Removed, SavedProfileState.NeedsReview }
        }) {
            var sessions = new List<ProbeSession>();
            var route = await SavedConnectionStartupRouter.PrepareAsync(new(false, null), configured, mode => {
                var session = new ProbeSession(); sessions.Add(session); return new(session, states[Array.IndexOf(configured, mode)]);
            });
            Need(route.Kind == SavedStartupRouteKind.Choose && !route.Reconnect && route.Prepared is null && sessions.All(item => item.Disposals == 1),
                "none, multiple, removed or damaged ownership preserves current explicit chooser and disposes all local-only probes without source work");
        }
        foreach (var requested in configured) {
            var route = await SavedConnectionStartupRouter.PrepareAsync(new(true, requested), configured,
                _ => throw new Exception("Pinned requests must not probe any source."));
            Need(route == new SavedStartupRoute(SavedStartupRouteKind.PinnedRequest, requested) && route.Reconnect,
                "explicit update/logon request stays pinned and requests fresh cached reconnect even if no local route can be inferred");
        }
        foreach (var request in new[] { new ExplorerResumeRequest(true, null), new(true, (AccessMode)99), new(true, AccessMode.Employee) }) {
            var route = await SavedConnectionStartupRouter.PrepareAsync(request, [AccessMode.Client], _ => throw new Exception("Refusal cannot probe or fallback."));
            Need(route.Kind == SavedStartupRouteKind.Refused && !route.Reconnect && route.Mode is null,
                "malformed/unoffered reserved coordinate refuses without chooser, other-source probe, browser or fallback");
        }
        var earlier = new ProbeSession(); var refused = false;
        try {
            await SavedConnectionStartupRouter.PrepareAsync(new(false, null), configured, mode => mode == AccessMode.Client
                ? new(earlier, SavedProfileState.OwnedReady) : throw new IOException("Synthetic unreadable source profile."));
        } catch (IOException) { refused = true; }
        Need(refused && earlier.Disposals == 1, "later local preparation failure drains earlier candidate and exposes no automatic resume");
        var keep = new ProbeSession(); var failed = new ProbeSession { FailDispose = true }; refused = false;
        try {
            await SavedConnectionStartupRouter.PrepareAsync(new(false, null), configured, mode => mode == AccessMode.Client
                ? new(keep, SavedProfileState.OwnedReady) : new(failed, SavedProfileState.Absent));
        } catch (IOException) { refused = true; }
        Need(refused && keep.Disposals == 1 && failed.Disposals == 1, "unconfirmed probe drain never returns a selected connection or falls through to chooser");
        var malformed = await SavedConnectionStartupRouter.PrepareAsync(new(false, null), configured,
            _ => new(new ProbeSession(), (SavedProfileState)99));
        Need(malformed.Kind == SavedStartupRouteKind.Refused, "malformed local state blocks setup instead of making a routing guess");
        await CachedRejectionStaysPinned();
        Console.WriteLine("Saved connection startup routing: fake passive probes, exact retained identity, chooser fallback, reserved-source isolation and async drain passed. No native, backend, auth, registry or root operations.");
    }
    private static async Task CachedRejectionStaysPinned()
    {
        var selected = new ProbeSession { CanReconnectCached = true, RejectReconnect = true };
        var other = new ProbeSession();
        var route = await SavedConnectionStartupRouter.PrepareAsync(new(false, null), [AccessMode.Client, AccessMode.Employee], mode =>
            mode == AccessMode.Employee ? new(selected, SavedProfileState.OwnedReady) : new(other, SavedProfileState.Absent));
        var newSources = 0;
        var window = new ExplorerPreviewWindow(() => { newSources++; throw new Exception("Cached rejection must not create or sign into another source."); },
            _ => new FakeTrayIcon(), ExplorerWindowContent.Connected("Test", route.Mode!.Value), route.Prepared)
            { ShowInTaskbar = false, Left = -20000, Top = -20000, WindowStartupLocation = WindowStartupLocation.Manual };
        window.Show();
        try {
            await window.ReconnectPreviewAsync();
            Need(selected.Reconnects == 1 && newSources == 0 && selected.Disposals == 0 && other.Disposals == 1,
                "fresh cached principal rejection remains on selected Settings with the retained index identity; no browser, new source, chooser or routing fallback");
        } finally {
            var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            window.Closed += (_, _) => closed.TrySetResult(); window.Quit();
            await closed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Need(selected.Disposals == 1, "normal Quit drains retained rejected connection without touching its files");
    }
    private static void Need(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    private sealed class ProbeSession : IExplorerPreviewSession, ICachedExplorerReconnect
    {
        internal int Disposals, Reconnects;
        public bool CanReconnectCached { get; set; }
        internal bool RejectReconnect;
        public Task ReconnectCachedAsync() { Reconnects++; if (RejectReconnect) throw new AccessDeniedException(); return Task.CompletedTask; }
        internal Task? DisposeGate;
        internal bool FailDispose;
        public string RootPath => "synthetic-no-root";
        public ExplorerPreviewState State => ExplorerPreviewState.NotStarted;
        public IReadOnlyList<string> Activity => [];
        public event EventHandler? Changed { add { } remove { } }
        public Task StartAsync() => throw new InvalidOperationException("Startup routing cannot start or authenticate a source.");
        public Task PauseAsync() => throw new InvalidOperationException();
        public Task ResumeAsync() => throw new InvalidOperationException();
        public Task RemoveAsync() => throw new InvalidOperationException("Startup routing cannot mutate roots.");
        public async ValueTask DisposeAsync() { Disposals++; if (DisposeGate is not null) await DisposeGate; if (FailDispose) throw new IOException("Synthetic passive probe drain failure."); }
    }
}
