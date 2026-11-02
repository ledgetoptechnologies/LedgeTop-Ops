using System.Security.Cryptography;
using System.Text;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Tests;

internal static class FreshGenerationCoordinatorTests
{
    private sealed class Fake(FreshGenerationPlan.Scope scope, FreshGenerationPlan.Generation candidate, string failure, CancellationTokenSource cancellation) : IFreshGenerationCoordinatorAdapter
    {
        internal readonly List<string> Calls = [];
        public Task<FreshGenerationCandidate> CaptureAndReserveAsync(FreshGenerationPlan.Scope expected, CancellationToken token) {
            Calls.Add("capture"); if (failure == "capture") throw new IOException("injected"); if (failure == "cancel_capture") cancellation.Cancel();
            return Task.FromResult(new FreshGenerationCandidate(candidate, scope, true));
        }
        public Task<bool> DrainPriorAsync(FreshGenerationPlan.Generation expected, CancellationToken token) {
            Calls.Add("drain"); if (failure == "cancel_drain") cancellation.Cancel(); return Task.FromResult(failure != "drain");
        }
        public Task<FreshGenerationReady> StartAndObserveAsync(FreshGenerationPlan.Generation expected, CancellationToken token) {
            Calls.Add("start"); if (failure == "start") throw new IOException("injected"); if (failure == "cancel_start") cancellation.Cancel();
            return Task.FromResult(new FreshGenerationReady(candidate.Id, candidate.ManifestDigest, candidate.RootPath, new(100, 103, Guid.NewGuid(), 4, 100, 104), true));
        }
        public Task<FreshGenerationPlan.Scope> RecheckAuthenticatedScopeAsync(CancellationToken token) {
            Calls.Add("auth"); return Task.FromResult(failure == "auth" ? scope with { Principal = "other" } : scope);
        }
    }
    private sealed class DenyingSource : IQueuedDownloadSource
    {
        public string Alias => "employee";
        public Uri Origin => new("https://example.invalid/");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) => throw new InvalidOperationException("No source access in this test.");
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) => throw new InvalidOperationException("No source access in this test.");
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException("No source access in this test.");
    }
    private sealed class PreparedSessionAdapter(OwnedExplorerRootSession session, FreshGenerationPlan.Scope scope) : IFreshGenerationCoordinatorAdapter
    {
        internal PreparedConnectedGeneration? Prepared;
        public async Task<FreshGenerationCandidate> CaptureAndReserveAsync(FreshGenerationPlan.Scope expected, CancellationToken token) {
            Prepared = await session.PrepareFreshConnectedCandidateAsync();
            var p = Prepared;
            return new(new(p.Identity, scope, p.ProfileDirectory, p.RootPath, p.ManifestDigest, p.ProfileVolume, p.ProfileFileId, p.ProfileRevision, p.ProfileDocumentVolume, p.ProfileDocumentFileId), scope,
                p.ProfileVolume != 0 && p.ProfileFileId != 0);
        }
        public Task<bool> DrainPriorAsync(FreshGenerationPlan.Generation expected, CancellationToken token) => Task.FromResult(true);
        // Intentionally fake: never starts a provider or creates/registers a root.
        public Task<FreshGenerationReady> StartAndObserveAsync(FreshGenerationPlan.Generation expected, CancellationToken token) =>
            Task.FromResult(new FreshGenerationReady(expected.Id, expected.ManifestDigest, expected.RootPath, new(100, 103, Guid.NewGuid(), expected.ProfileRevision + 1, expected.ProfileDirectoryVolume, 104), true));
        public Task<FreshGenerationPlan.Scope> RecheckAuthenticatedScopeAsync(CancellationToken token) => Task.FromResult(scope);
    }
    internal static async Task Run()
    {
        var artifact = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException();
        var scope = new FreshGenerationPlan.Scope("pilot", "employee", "https://example.invalid", "principal");
        var old = new FreshGenerationPlan.Generation(Guid.NewGuid(), scope, @"C:\pilot\old-profile", @"C:\files\old", new string('a', 64), 100, 101, 1, 100, 201, 100, 301, Guid.NewGuid());
        var next = new FreshGenerationPlan.Generation(Guid.NewGuid(), scope, @"C:\pilot\new-profile", @"C:\files\new", new string('b', 64), 100, 102, 1, 100, 202);
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(scope.Origin)));
        var binding = new FreshGenerationIndexStore.LegacyBinding(1, "S-1-5-21-test", scope.Channel, scope.Source, hash, scope.Principal, old);
        foreach (var failure in new[] { "capture", "drain", "auth", "start", "cancel_capture", "cancel_drain", "cancel_start", "none" }) {
            var parent = Path.Combine(artifact, "coordinator-" + Guid.NewGuid().ToString("N"));
            var directory = Path.Combine(parent, "connected-explorer-pilot-employee"); Directory.CreateDirectory(directory);
            var original = Encoding.UTF8.GetBytes("owned-schema-1"); File.WriteAllBytes(Path.Combine(directory, "current.json"), original);
            var localMarker = Path.Combine(parent, "old-local-marker.txt"); File.WriteAllText(localMarker, "unchanged");
            using var cancellation = new CancellationTokenSource(); var fake = new Fake(scope, next, failure, cancellation);
            try {
                var selected = await FreshGenerationCoordinator.ExecuteAsync(directory, original, binding, () => true,
                    bytes => bytes.AsSpan().SequenceEqual(original) ? binding : null, fake, true, cancellation.Token);
                if (failure != "none" || selected.State.Phase != FreshGenerationPlan.Phase.Published || selected.ActiveGeneration != next.Id)
                    throw new Exception("Unexpected successful generation switch.");
            } catch (IOException) when (failure != "none") { }
            catch (OperationCanceledException) when (failure.StartsWith("cancel_", StringComparison.Ordinal)) { }
            if (File.ReadAllText(localMarker) != "unchanged") throw new Exception("Old local data changed.");
            var current = File.ReadAllBytes(Path.Combine(directory, "current.json"));
            if (failure is "capture" or "cancel_capture") {
                if (!current.AsSpan().SequenceEqual(original) || fake.Calls.Contains("drain")) throw new Exception("Capture failure touched old selector.");
            } else {
                var saved = FreshGenerationIndexCodec.Decode(current);
                var expected = failure switch { "drain" or "cancel_drain" => FreshGenerationPlan.Phase.Prepared, "auth" or "start" or "cancel_start" => FreshGenerationPlan.Phase.OldDrained, _ => FreshGenerationPlan.Phase.Published };
                if (saved.State.Phase != expected || saved.ActiveGeneration != (failure == "none" ? next.Id : old.Id))
                    throw new Exception("Unexpected held selector after failure.");
                if (!File.ReadAllBytes(Path.Combine(directory, FreshGenerationIndexStore.LegacyBackup)).AsSpan().SequenceEqual(original))
                    throw new Exception("Original selector was not retained.");
            }
        }
        // The candidate reservation uses the real OwnedExplorerRootSession, but start/ready is
        // faked: this exercises no Cloud Files registration, provider, credentials or network.
        var fixture = Path.Combine(artifact, "real-reservation-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(fixture);
        var lockPath = Path.Combine(fixture, "index.lock");
        using (var lockFile = new FileStream(lockPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None)) {
            var pin = new FreshGenerationIndexLockPin(lockFile, lockPath);
            if (!pin.StillHeld(lockFile) || pin.StillHeld(null)) throw new Exception("Index lock pin did not bind the exact handle.");
            try { _ = new FreshGenerationIndexLockPin(lockFile, Path.Combine(fixture, "other.lock")); throw new Exception("Wrong lock path accepted."); }
            catch (IOException) { }
            lockFile.Dispose();
            if (pin.StillHeld(lockFile)) throw new Exception("Closed index lock accepted.");
        }
        var profile = Path.Combine(fixture, "candidate-profile"); var files = Path.Combine(fixture, "candidate-files");
        var actualScope = new ExplorerRootScope("pilot", "employee", "https://example.invalid", "odqp1_" + new string('a', 64));
        var planScope = new FreshGenerationPlan.Scope(actualScope.Channel, actualScope.Alias, actualScope.Origin, actualScope.PrincipalId);
        var manifest = new ExplorerRootManifest(actualScope, new Dictionary<string, PlaceholderIdentity>());
        var unusedProfile = Path.Combine(fixture, "unused-profile"); var unusedRoot = Path.Combine(fixture, "unused-root");
        var adapter = ConnectedExplorerSession.DefaultEngine(new(unusedProfile, unusedRoot, new DenyingSource(), actualScope, manifest));
        if (adapter.ObserveConnectedGeneration is null || adapter.PrepareFreshCandidate is null)
            throw new Exception("Owned-session adapter hooks were not installed.");
        await adapter.Session.DisposeAsync();
        if (Directory.Exists(unusedProfile) || Directory.Exists(unusedRoot)) throw new Exception("Constructing adapter touched files.");
        await using var actualSession = OwnedExplorerRootSession.CandidateForTest(profile, files, new DenyingSource(), actualScope, manifest);
        var actualAdapter = new PreparedSessionAdapter(actualSession, planScope);
        var oldScope = old with { Scope = planScope };
        var owned = binding with { Principal = actualScope.PrincipalId, Old = oldScope };
        var actualDir = Path.Combine(fixture, "connected-explorer-pilot-employee"); Directory.CreateDirectory(actualDir);
        var actualLegacy = Encoding.UTF8.GetBytes("owned-schema-1-actual-reservation"); File.WriteAllBytes(Path.Combine(actualDir, "current.json"), actualLegacy);
        var disabledPriorDir = Path.Combine(fixture, "disabled-prior-profile"); var disabledPriorRoot = Path.Combine(fixture, "disabled-prior-root");
        var disabledNewDir = Path.Combine(fixture, "disabled-new-profile"); var disabledNewRoot = Path.Combine(fixture, "disabled-new-root");
        await using (var disabledPrior = new OwnedExplorerRootSession(disabledPriorDir, disabledPriorRoot, new DenyingSource(), actualScope, manifest))
        await using (var disabledCandidate = new OwnedExplorerRootSession(disabledNewDir, disabledNewRoot, new DenyingSource(), actualScope, manifest)) {
            var authCalled = false;
            var disabled = FreshGenerationOwnedAdapter.CreateDisabled(disabledPrior, disabledCandidate, oldScope,
                _ => { authCalled = true; return Task.FromResult(planScope); });
            try { await disabled.CaptureAndReserveAsync(planScope, CancellationToken.None); throw new Exception("Disabled adapter ran."); }
            catch (IOException) { }
            if (authCalled || Directory.Exists(disabledPriorDir) || Directory.Exists(disabledNewDir))
                throw new Exception("Disabled adapter touched source or session files.");
        }
        var actualResult = await FreshGenerationCoordinator.ExecuteAsync(actualDir, actualLegacy, owned, () => true,
            bytes => bytes.AsSpan().SequenceEqual(actualLegacy) ? owned : null, actualAdapter, true, CancellationToken.None);
        if (actualAdapter.Prepared is null || actualResult.ActiveGeneration != actualAdapter.Prepared.Identity ||
            !File.Exists(Path.Combine(profile, "profile.json")) || Directory.Exists(files))
            throw new Exception("Real candidate reservation was not retained as the selected fake generation.");
    }
}
