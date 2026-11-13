#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
using System.Security.Principal;
using System.Text.Json;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Real held-session orchestration and profile parser, fake provider boundary only.
// Never registers or opens a native Cloud Files root.
internal static class FencedHeldReconnectSyntheticTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    internal static async Task<int> RunAsync()
    {
        foreach (var mode in new[] { "success", "non-ready", "proof-changed", "connect-failed", "drain-failed", "cancel-during" })
            await RunCase(mode);
        Console.WriteLine("PASS held reconnect orchestration with fake Cloud Files registration/provider and real Windows filesystem handles.");
        return 0;
    }
    private static async Task RunCase(string mode)
    {
        var fixture = Path.Combine(Path.GetTempPath(), "lt-fenced-held-" + Guid.NewGuid().ToString("N"));
        var profileDir = Path.Combine(fixture, "profile"); var root = Path.Combine(fixture, "root");
        if (Directory.Exists(fixture) || File.Exists(fixture)) throw new IOException("Fixture already exists.");
        Directory.CreateDirectory(profileDir); Directory.CreateDirectory(root);
        var fake = new Source(); var scope = new ExplorerRootScope("pilot", fake.Alias, fake.Origin.GetLeftPart(UriPartial.Authority), Principal);
        var manifest = new ExplorerRootManifest(scope, new Dictionary<string, PlaceholderIdentity>());
        var id = Guid.NewGuid(); var manifestName = "manifest-" + id.ToString("N") + ".json";
        var manifestBytes = manifest.Encode();
        File.WriteAllBytes(Path.Combine(profileDir, manifestName), manifestBytes);
        using var user = WindowsIdentity.GetCurrent();
        var profile = Path.Combine(profileDir, "profile.json");
        File.WriteAllText(profile, JsonSerializer.Serialize(new {
            Schema = 3, Owner = "LedgeTop.Files.ConnectedExplorer/1", Sid = user.User!.Value, Identity = id,
            Root = root, Context = "LedgeTop.Files.ConnectedExplorer/1:" + id.ToString("N"),
            Icon = ExplorerBrandIcon.LegacyResource, RootFileId = 1, Phase = mode == "non-ready" ? "Prepared" : "Ready", Paused = false, Revision = 1,
            NamespaceClsid = Guid.NewGuid(), Binding = new { Scope = scope, File = manifestName, Digest = manifest.Digest }
        }));
        var original = File.ReadAllBytes(profile);
        var session = OwnedExplorerRootSession.CandidateForTest(profileDir, root, fake, scope, manifest,
            priorVerify: _ => true, priorDrain: _ => Task.CompletedTask);
        var lockPath = Path.Combine(profileDir, "session.lock");
        var held = new FileStream(lockPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        var handles = ConnectedGenerationHandleLease.Open(profileDir, manifestName, root);
        var snapshot = new ConnectedGenerationSnapshot(id, profileDir, root, 1, Guid.NewGuid(), manifest.Digest, scope, 1);
        session.AttachSyntheticRestartForTest(held, new ConnectedGenerationHeldObservation(snapshot, handles));
        var selector = true; var drains = 0; var failDrain = mode == "drain-failed";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.SetSyntheticFencedConnectHooksForTest(new(async () => {
            entered.TrySetResult();
            if (mode == "cancel-during") await release.Task;
            if (mode == "proof-changed") selector = false;
            if (mode is "connect-failed" or "drain-failed") throw new IOException("synthetic connect failure");
        }, () => { drains++; return failDrain ? Task.FromException(new IOException("synthetic drain failure")) : Task.CompletedTask; }));
        using var cancellation = new CancellationTokenSource();
        var passed = false;
        try {
            var attempt = session.ConnectHeldRestartFencedAsync(_ => selector, cancellation.Token);
            if (mode == "cancel-during") {
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancellation.Cancel();
                Require(!attempt.IsCompleted, "connect must settle after cancellation"); release.TrySetResult();
            }
            if (mode == "success") {
                await attempt; Require(session.State == ExplorerPreviewState.Paused && session.SyntheticFencedAttemptOwnedForTest, "success stays fenced and owned");
            } else {
                var refused = false;
                try { await attempt; }
                catch (OperationCanceledException) when (mode == "cancel-during") { refused = true; }
                catch (AggregateException) when (mode == "drain-failed") { refused = true; }
                catch (IOException) when (mode is "non-ready" or "proof-changed" or "connect-failed") { refused = true; }
                Require(refused, "failure expected");
                Require(session.State == ExplorerPreviewState.Failed && drains == (mode == "non-ready" ? 0 : 1), "failed attempt drains without selector proof");
                Require(session.SyntheticFencedAttemptOwnedForTest == (mode == "drain-failed"), "only uncertain drain retains attempt");
                if (mode == "drain-failed") {
                    var stopRefused = false;
                    try { await session.StopHeldRestartProviderAsync(_ => true); } catch (IOException) { stopRefused = true; }
                    Require(stopRefused && session.SyntheticFencedAttemptOwnedForTest, "uncertain provider cannot release the held lease");
                }
            }
            Require(fake.AuthChecks == (mode == "success" ? 2 : mode == "non-ready" ? 0 : 1), "unexpected cached-session recheck count");
            Require(original.AsSpan().SequenceEqual(File.ReadAllBytes(profile)), "profile bytes changed");
            try { using var unexpected = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("lease released"); }
            catch (IOException) { }
            passed = true;
        } finally {
            release.TrySetResult(); failDrain = false;
            if (session.SyntheticFencedAttemptOwnedForTest) await session.DrainSyntheticFencedAttemptForTestAsync();
            await session.StopHeldRestartProviderAsync(_ => true); await session.DisposeAsync();
            if (passed) {
                try { RemoveOwnedFixture(fixture, profileDir, root, id, manifestName, original, manifestBytes); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) {
                    Console.WriteLine("Synthetic fixture cleanup unconfirmed; retain remaining entries: " + fixture);
                }
            } else Console.WriteLine("Synthetic held reconnect fixture retained after failure: " + fixture);
        }
    }
    private static void RemoveOwnedFixture(string fixture, string profile, string root, Guid id, string manifestName, byte[] profileBytes, byte[] manifestBytes)
    {
        var expectedParent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        if (!string.Equals(Path.GetDirectoryName(fixture), expectedParent, StringComparison.OrdinalIgnoreCase) ||
            !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(fixture), @"\Alt-fenced-held-[a-f0-9]{32}\z"))
            throw new IOException("Unexpected fixture location.");
        void ExactChildren(string directory, params string[] expected) {
            if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("Fixture directory is an alias.");
            var entries = Directory.GetFileSystemEntries(directory);
            if (entries.Length != expected.Length || entries.Any(path => !expected.Contains(Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)))
                throw new IOException("Fixture contains unexpected entries.");
            if (entries.Any(path => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)) throw new IOException("Fixture entry is an alias.");
        }
        var cache = Path.Combine(profile, "cache"); var cacheLeaf = Path.Combine(cache, id.ToString("N"));
        var hasCache = Directory.Exists(cache);
        ExactChildren(fixture, "profile", "root"); ExactChildren(root);
        ExactChildren(profile, hasCache ? ["profile.json", manifestName, "session.lock", "cache"] : ["profile.json", manifestName, "session.lock"]);
        if (hasCache) { ExactChildren(cache, id.ToString("N")); ExactChildren(cacheLeaf); }
        var profileFile = Path.Combine(profile, "profile.json"); var manifestFile = Path.Combine(profile, manifestName); var lockFile = Path.Combine(profile, "session.lock");
        if (!File.ReadAllBytes(profileFile).AsSpan().SequenceEqual(profileBytes) || !File.ReadAllBytes(manifestFile).AsSpan().SequenceEqual(manifestBytes) || new FileInfo(lockFile).Length != 0)
            throw new IOException("Fixture files changed.");
        File.Delete(profileFile); File.Delete(manifestFile); File.Delete(lockFile);
        if (hasCache) { Directory.Delete(cacheLeaf); Directory.Delete(cache); }
        Directory.Delete(profile); Directory.Delete(root); Directory.Delete(fixture);
    }
    private static void Require(bool condition, string message) { if (!condition) throw new IOException(message); }
    private sealed class Source : IQueuedDownloadSource
    {
        internal int AuthChecks;
        public string Alias => "employee"; public Uri Origin => new("https://source.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) { AuthChecks++; return Task.FromResult(new QueuedDownloadSession(Principal, DateTimeOffset.UtcNow.AddHours(1))); }
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) => throw new InvalidOperationException();
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException();
    }
}
#endif
