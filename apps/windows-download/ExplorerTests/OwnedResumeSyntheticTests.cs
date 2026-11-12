using System.Reflection;
using System.Security.Principal;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Exercises the real owned-session operation around a deliberately unconnected provider.
// Reflection is confined to this synthetic harness; it creates no Cloud Files registration.
internal static class OwnedResumeSyntheticTests
{
    private const string Person = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    internal static async Task<int> RunAsync()
    {
        foreach (var mode in new[] { "network", "denied", "save", "pause-throws" }) await RunOne(mode);
        Console.WriteLine("PASS owned resume: transient paused, denial/save/callback failures drain provider; fake source/registration, no native connection.");
        return 0;
    }
    private static async Task RunOne(string mode)
    {
        var basePath = Path.Combine(Path.GetTempPath(), "lt-owned-resume-" + Guid.NewGuid().ToString("N"));
        var profileDir = Path.Combine(basePath, "profile"); var root = Path.Combine(basePath, "root"); var cache = Path.Combine(basePath, "cache");
        Directory.CreateDirectory(profileDir); Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        var fake = new Source(); var scope = new ExplorerRootScope("pilot", "employee", fake.Origin.GetLeftPart(UriPartial.Authority), Person);
        var gate = new ExplorerSourceGate(fake, scope);
        var owned = new OwnedExplorerRootSession(profileDir, root, fake, scope);
        var provider = new NativePlaceholderProvider(new NoNative(root), cache, gate, "pilot", Person, new Dictionary<string, PlaceholderIdentity>());
        var type = typeof(OwnedExplorerRootSession);
        void Set(string name, object? value) => (type.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic) ?? throw new IOException(name)).SetValue(owned, value);
        object? Get(string name) => (type.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic) ?? throw new IOException(name)).GetValue(owned);
        var profileType = type.GetNestedType("Profile", BindingFlags.NonPublic) ?? throw new IOException("profile type");
        var phaseType = type.GetNestedType("Phase", BindingFlags.NonPublic) ?? throw new IOException("phase type");
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new IOException("sid");
        var profile = Activator.CreateInstance(profileType, [4, "synthetic", sid, Guid.NewGuid(), root, "synthetic", "synthetic", 1L,
            Enum.Parse(phaseType, "Ready"), true, 1L, Guid.Empty, null, null]) ?? throw new IOException("profile");
        Set("profile", profile); Set("source", gate); Set("provider", provider); Set("state", ExplorerPreviewState.Paused);
        Set("lease", new FileStream(Path.Combine(profileDir, "session.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None));
        var stopped = false;
        try {
            fake.Failure = mode switch { "network" => new TransferException("synthetic", TransferFailureReason.Network), "denied" => new AccessDeniedException(), _ => null };
            if (mode == "pause-throws") {
                await gate.ResumeAsync();
                var epoch = (CancellationTokenSource)(typeof(ExplorerSourceGate).GetField("epoch", BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(gate) ?? throw new IOException("epoch"));
                epoch.Token.Register(() => throw new InvalidOperationException("synthetic callback"));
            }
            if (mode == "save") Directory.CreateDirectory(Path.Combine(profileDir, "profile.json"));
            try { await owned.ResumeAsync(); throw new IOException("resume unexpectedly succeeded"); }
            catch (Exception error) when (mode == "network" && error is TransferException || mode == "denied" && error is AccessDeniedException || mode == "save" && error is UnauthorizedAccessException || mode == "pause-throws" && error is IOException && error.Message == "The paused provider could not be confirmed.") { }
            if (mode == "network") {
                if (owned.State != ExplorerPreviewState.Paused || !gate.IsPaused || !ReferenceEquals(Get("provider"), provider)) throw new IOException("transient did not retain paused provider");
                fake.Failure = null; await owned.ResumeAsync();
                if (owned.State != ExplorerPreviewState.Running || gate.IsPaused || !ReferenceEquals(Get("provider"), provider)) throw new IOException("healthy resume did not succeed");
            } else if (owned.State != ExplorerPreviewState.Failed || !gate.IsPaused || Get("provider") is not null)
                throw new IOException("nontransient or save failure did not drain provider and close gate");
            if (mode == "pause-throws" && !owned.Activity.Any(x => x.Contains("cancellation reported an error", StringComparison.Ordinal)))
                throw new IOException("callback failure was not reported");
        } finally {
            await owned.DisposeAsync(); stopped = true;
            if (stopped) {
                foreach (var file in Directory.GetFiles(profileDir)) File.Delete(file);
                var collision = Path.Combine(profileDir, "profile.json"); if (Directory.Exists(collision)) Directory.Delete(collision);
                Directory.Delete(profileDir); Directory.Delete(cache); Directory.Delete(root); Directory.Delete(basePath);
            }
        }
    }
    private sealed class NoNative(string root) : IPreviewRootRegistration { public string Root => root; public void VerifyOwned() { } public void Unregister() => throw new InvalidOperationException(); }
    private sealed class Source : IQueuedDownloadSource {
        internal Exception? Failure;
        public string Alias => "employee";
        public Uri Origin => new("https://source.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) => Failure is { } error ? Task.FromException<QueuedDownloadSession>(error) : Task.FromResult(new QueuedDownloadSession(Person, DateTimeOffset.UtcNow.AddHours(1)));
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken token = default) => throw new InvalidOperationException();
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken token = default) => throw new InvalidOperationException();
    }
}
