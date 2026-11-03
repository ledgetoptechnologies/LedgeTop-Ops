using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

// Explicit opt-in only: these checks retain synthetic fixtures under the
// dedicated artifact directory, because this test does not establish the
// physical identities needed to authorize recursive cleanup.
internal static class PreparationOwnershipTests {
    private static readonly byte[] Bytes = Enumerable.Range(0, 8192).Select(i => (byte)(i % 251)).ToArray();
    private static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Bytes));
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static PlaceholderIdentity Identity => new("pilot", "portal", "https://source.example.invalid", Principal,
        "odqr1_synthetic", "ondf1_" + new string('b', 64), "v1", "sample.bin", Bytes.Length, "\"v1\"", Sha);
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("prepared stream and entry remain owned through authorization and transfer", Success),
        ("denied or cancelled post-authorization disposes input and leases before settlement", DeniedAndCancelled),
        ("transfer cancellation and terminal completion preserve ownership and settle once", TransferBoundaries),
        ("failed cache validation preserves outer fresh owner until failure settlement", FailedPreparation),
        ("preparation fixtures retain synthetic data rather than guessing cleanup ownership", Retention),
        ("preparation artifact bases refuse aliases and unsafe paths", ArtifactBaseRefusal)
    ];
    private static void Check(bool value) { if (!value) throw new InvalidOperationException("Preparation ownership assertion failed."); }
    private static string CacheRoot(string root) => Path.Combine(root, "verified-hydration-v1");
    private static string LockPath(string root) => Path.Combine(CacheRoot(root), Identity.ScopeKey, Identity.CacheKey, ".hydration.lock");
    private static bool EntryBusy(string root) {
        try { using var held = new FileStream(LockPath(root), FileMode.Open, FileAccess.ReadWrite, FileShare.None); return false; }
        catch (IOException) { return true; }
    }
    private static async Task AssertAdmissionFree(string root) {
        using var lease = await HydrationCacheConcurrency.AcquireAsync(CacheRoot(root), Identity.ScopeKey + Identity.CacheKey,
            default, testTimeout: TimeSpan.FromSeconds(2));
    }
    private static async Task AssertAdmissionHeld(string root) {
        using var stop = new CancellationTokenSource();
        var waiting = HydrationCacheConcurrency.AcquireAsync(CacheRoot(root), Identity.ScopeKey + Identity.CacheKey, stop.Token);
        if (waiting.IsCompleted) { using var unexpected = await waiting; throw new InvalidOperationException("Admission released during transfer."); }
        stop.Cancel();
        try { using var unexpected = await waiting; throw new InvalidOperationException("Cancelled admission was acquired."); }
        catch (OperationCanceledException) { }
    }
    private static async Task Success() {
        using var f = new Fixture("normal");
        f.Source.OnSecondResolve = () => { Check(f.Source.Stream is { CanRead: true } && EntryBusy(f.Root)); f.Source.ObservedSecondResolve = true; };
        var sink = new Sink { OnComplete = async () => {
            Check(f.Source.Stream is { CanRead: true } && EntryBusy(f.Root));
            await AssertAdmissionHeld(f.Root); f.Source.Events.Add("complete");
        } };
        await f.Core.HydrateAsync(Identity, 0, Bytes.Length, sink);
        Check(f.Source.ObservedSecondResolve && sink.Bytes == Bytes.Length && sink.Complete == 1 && sink.Failed == 0);
        Check(f.Source.Stream is { DisposeCalls: 2, CanRead: false });
        Check(f.Source.Events.SequenceEqual(new[] { "complete", "dispose-1", "dispose-2" }));
        Check(!EntryBusy(f.Root)); await AssertAdmissionFree(f.Root);
    }
    private static async Task DeniedAndCancelled() {
        foreach (var mode in new[] { "deny", "cancel", "corrupt" }) {
            using var f = new Fixture(mode); var checkedFailure = false;
            if (mode != "corrupt") f.Source.OnSecondResolve = () => { Check(f.Source.Stream is { CanRead: true } && EntryBusy(f.Root)); f.Source.ObservedSecondResolve = true; };
            var sink = new Sink { OnFailure = async () => {
                Check(f.Source.Stream is { DisposeCalls: 1, CanRead: false } && !EntryBusy(f.Root));
                await AssertAdmissionFree(f.Root); f.Source.Events.Add("failure"); checkedFailure = true;
            } };
            try { await f.Core.HydrateAsync(Identity, 0, Bytes.Length, sink, f.Source.Stop.Token); throw new InvalidOperationException("Failure expected."); }
            catch (TransferException) when (mode != "cancel") { }
            catch (OperationCanceledException) when (mode == "cancel") { }
            Check(checkedFailure && sink.Bytes == 0 && sink.Failed == 1 && sink.Complete == 0);
            Check(f.Source.Stream is { DisposeCalls: 2, CanRead: false });
            Check(f.Source.Events.SequenceEqual(new[] { "dispose-1", "failure", "dispose-2" }));
            Check(mode == "corrupt" ? f.Source.Resolves == 1 : f.Source.Resolves == 2 && f.Source.ObservedSecondResolve);
        }
    }
    private static async Task FailedPreparation() {
        using var f = new Fixture("wrongpath"); var checkedFailure = false;
        var sink = new Sink { OnFailure = async () => {
            // The input scope was never entered. Its fresh owner still owns
            // the stream through failure settlement; the entry lease is gone.
            Check(f.Source.Stream is { DisposeCalls: 0, CanRead: true } && !EntryBusy(f.Root));
            await AssertAdmissionFree(f.Root); f.Source.Events.Add("failure"); checkedFailure = true;
        } };
        try { await f.Core.HydrateAsync(Identity, 0, Bytes.Length, sink); throw new InvalidOperationException("Failure expected."); }
        catch (TransferException) { }
        Check(checkedFailure && sink.Bytes == 0 && sink.Failed == 1 && sink.Complete == 0);
        Check(f.Source.Stream is { DisposeCalls: 1, CanRead: false });
        Check(f.Source.Events.SequenceEqual(new[] { "failure", "dispose-1" }));
    }
    private static async Task TransferBoundaries() {
        using (var f = new Fixture("normal")) {
            var failureChecked = false;
            var sink = new Sink { OnWrite = () => f.Source.Stop.Cancel(), OnFailure = async () => {
                Check(f.Source.Stream is { DisposeCalls: 1, CanRead: false } && !EntryBusy(f.Root));
                await AssertAdmissionFree(f.Root); f.Source.Events.Add("failure"); failureChecked = true;
            } };
            try { await f.Core.HydrateAsync(Identity, 0, Bytes.Length, sink, f.Source.Stop.Token); throw new InvalidOperationException("Cancellation expected."); }
            catch (OperationCanceledException) { }
            Check(failureChecked && sink.Bytes == Bytes.Length && sink.Failed == 1 && sink.Complete == 0);
            Check(f.Source.Events.SequenceEqual(new[] { "dispose-1", "failure", "dispose-2" }));
        }
        using (var f = new Fixture("normal")) {
            var sink = new Sink { OnComplete = () => { f.Source.Stop.Cancel(); return Task.CompletedTask; } };
            await f.Core.HydrateAsync(Identity, 0, Bytes.Length, sink, f.Source.Stop.Token);
            Check(sink.Complete == 1 && sink.Failed == 0 && sink.Bytes == Bytes.Length);
            Check(f.Source.Stream is { DisposeCalls: 2, CanRead: false } && !EntryBusy(f.Root));
            await AssertAdmissionFree(f.Root);
        }
    }
    private static Task ArtifactBaseRefusal() {
        var synthetic = Path.Combine(Path.GetTempPath(), "ltfiles-synthetic-alias-check");
        try {
            Fixture.ValidateArtifactBase(synthetic, path => string.Equals(path, synthetic, StringComparison.OrdinalIgnoreCase)
                ? FileAttributes.Directory | FileAttributes.ReparsePoint : FileAttributes.Directory);
            throw new InvalidOperationException("Alias artifact base was accepted.");
        } catch (IOException) { }
        foreach (var invalid in new[] { "relative", @"\\server\share", Path.GetPathRoot(synthetic)! }) {
            try { Fixture.ValidateArtifactBase(invalid, _ => FileAttributes.Directory); throw new InvalidOperationException("Invalid artifact base was accepted."); }
            catch (IOException) { }
        }
        try {
            Fixture.ValidateArtifactBase(synthetic, path => string.Equals(path, synthetic, StringComparison.OrdinalIgnoreCase)
                ? FileAttributes.Normal : FileAttributes.Directory);
            throw new InvalidOperationException("File artifact base was accepted.");
        } catch (IOException) { }
        return Task.CompletedTask;
    }
    private static Task Retention() {
        var fixture = new Fixture("normal");
        var sentinel = Path.Combine(fixture.Root, "synthetic-retention-sentinel.txt");
        File.WriteAllText(sentinel, "synthetic only"); fixture.Dispose();
        Check(File.ReadAllText(sentinel) == "synthetic only" && Directory.Exists(fixture.Root));
        return Task.CompletedTask;
    }
    private sealed class Sink : IPlaceholderTransferSink {
        internal int Bytes, Complete, Failed; internal Func<Task>? OnComplete, OnFailure; internal Action? OnWrite;
        public Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) { token.ThrowIfCancellationRequested(); Bytes += bytes.Length; OnWrite?.Invoke(); return Task.CompletedTask; }
        public async Task CompleteAsync(CancellationToken token) { Complete++; if (OnComplete is not null) await OnComplete(); }
        public async Task FailAsync(string code) { Failed++; if (OnFailure is not null) await OnFailure(); }
    }
    private sealed class TrackedFile(string path, List<string> events) : FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous) {
        internal int DisposeCalls;
        public override async ValueTask DisposeAsync() { events.Add("dispose-" + ++DisposeCalls); await base.DisposeAsync(); }
    }
    private sealed class Source(string mode) : IQueuedDownloadSource, IVerifiedHydrationDownloadSource, IHydrationMutationAwareSource, IDisposable {
        internal readonly List<string> Events = []; internal readonly CancellationTokenSource Stop = new();
        internal TrackedFile? Stream; internal int Resolves; internal Action? OnSecondResolve; internal bool ObservedSecondResolve;
        bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => true;
        public string Alias => "portal"; public Uri Origin => new("https://source.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) => Task.FromResult(new QueuedDownloadSession(Principal, DateTimeOffset.UtcNow.AddHours(1)));
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) {
            if (++Resolves == 2) {
                OnSecondResolve?.Invoke();
                if (mode == "deny") throw new AccessDeniedException();
                if (mode == "cancel") { Stop.Cancel(); token.ThrowIfCancellationRequested(); }
            }
            var id = Identity;
            return Task.FromResult(new ResolvedQueuedDownload(Principal, id.LogicalFileId, id.RemoteVersion,
                new DownloadSpec(id.LogicalFileId + ":" + id.RemoteVersion, new Uri(Origin, "/synthetic"), id.FileName, id.Length, id.ETag, id.Sha256)));
        }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException("Unexpected source path.");
        public Task<VerifiedHydrationDownload> DownloadForHydrationAsync(DownloadSpec spec, string destination, CancellationToken token = default) {
            token.ThrowIfCancellationRequested(); var path = Path.Combine(destination, spec.FileName); var data = Bytes.ToArray();
            if (mode == "corrupt") data[0] ^= 1;
            File.WriteAllBytes(path, data); Stream = new TrackedFile(path, Events);
            return Task.FromResult(new VerifiedHydrationDownload(mode == "wrongpath" ? Path.Combine(destination, "wrong.bin") : path, Stream, mode != "corrupt"));
        }
        public void Dispose() => Stop.Dispose();
    }
    private sealed class Fixture : IDisposable {
        internal readonly string Root;
        internal readonly Source Source; internal readonly PlaceholderHydrationCoordinator Core;
        internal Fixture(string mode) {
            var selected = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ??
                Path.Combine(AppContext.BaseDirectory, "test-artifacts", "preparation-ownership");
            var parent = ValidateArtifactBase(selected, Attributes);
            Directory.CreateDirectory(parent); ValidateArtifactBase(parent, Attributes);
            Root = Path.Combine(parent, "prep-ownership-" + Guid.NewGuid().ToString("N"));
            if (Directory.Exists(Root) || File.Exists(Root)) throw new IOException("A fresh synthetic fixture is required.");
            Directory.CreateDirectory(Root); Source = new(mode); Core = new(Source, "pilot", Root, expectedPrincipal: Principal);
        }
        internal static string ValidateArtifactBase(string selected, Func<string, FileAttributes?> attributes) {
            if (!Path.IsPathFullyQualified(selected) || selected.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("A dedicated local artifact base is required.");
            var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(selected));
            if (full == Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full)!)) throw new IOException("A dedicated artifact base is required.");
            for (string? path = full; path is not null; path = Path.GetDirectoryName(path)) {
                var value = attributes(path);
                if (value is { } actual && ((actual & FileAttributes.ReparsePoint) != 0 || (actual & FileAttributes.Directory) == 0))
                    throw new IOException("Artifact base cannot pass through aliases or files.");
            }
            return full;
        }
        private static FileAttributes? Attributes(string path) {
            try { return File.GetAttributes(path); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
        }
        public void Dispose() {
            Core.Dispose(); Source.Dispose();
            // No delete or path-based cleanup is safe without physical root and
            // descendant identity evidence. Report retained synthetic evidence.
            Console.WriteLine("Retained synthetic preparation fixture: " + Root);
        }
    }
}
