using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Tests;

// Exercises actual ConnectedExplorerSession.RemoveAsync and InstallerMaintenance routing
// from a selector-only schema-2 restart. Root callbacks are synthetic; no native APIs run.
internal static class ConnectedExplorerRemovalTests
{
    internal sealed class Fixture : IAsyncDisposable
    {
        internal readonly string Base;
        internal readonly string OldRoot;
        internal readonly string CandidateRoot;
        internal readonly string OldMarker;
        internal readonly string CandidateMarker;
        internal readonly HashSet<Guid> Registered;
        internal readonly List<Guid> Calls = [];
        internal readonly FreshGenerationPlan.Generation Old;
        internal readonly FreshGenerationPlan.Generation Candidate;
        internal readonly FreshGenerationIndexCodec.Index Published;
        private readonly string origin = "https://removal-test.invalid";

        internal Fixture()
        {
            var artifacts = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? Path.GetTempPath();
            Base = Path.Combine(artifacts, "connected-removal-integration-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Base);
            OldRoot = Path.Combine(Base, "old-files"); CandidateRoot = Path.Combine(Base, "current-files");
            Directory.CreateDirectory(OldRoot); Directory.CreateDirectory(CandidateRoot);
            OldMarker = Path.Combine(OldRoot, "preserve.txt"); CandidateMarker = Path.Combine(CandidateRoot, "preserve.txt");
            File.WriteAllText(OldMarker, "old local bytes"); File.WriteAllText(CandidateMarker, "current local bytes");
            var scope = new FreshGenerationPlan.Scope("pilot", "employee", origin, "odqp1_" + new string('a', 64));
            Old = new(Guid.NewGuid(), scope, Path.Combine(Base, "old-profile"), OldRoot, new string('b', 64), 1, 101, 1, 1, 201, 1, 301, Guid.NewGuid());
            Candidate = new(Guid.NewGuid(), scope, Path.Combine(Base, "current-profile"), CandidateRoot, new string('c', 64), 1, 102, 1, 1, 202);
            var prepared = FreshGenerationPlan.Prepare(new(Old, null, FreshGenerationPlan.Phase.OldActive), Candidate, scope, true, true);
            var ready = new FreshGenerationPlan.RootEvidence(1, 302, Guid.NewGuid(), 2, 1, 203);
            var state = FreshGenerationPlan.Publish(FreshGenerationPlan.Ready(FreshGenerationPlan.Drained(prepared, true), scope,
                Candidate.Id, Candidate.ManifestDigest, Candidate.RootPath, ready, true), true);
            var legacy = Encoding.UTF8.GetBytes("retained schema-one test selector");
            var dir = Path.Combine(Base, "connected-explorer-pilot-employee"); Directory.CreateDirectory(dir);
            File.WriteAllBytes(Path.Combine(dir, FreshGenerationIndexStore.LegacyBackup), legacy);
            using (File.Create(Path.Combine(dir, "index.lock"))) { }
            using var identity = WindowsIdentity.GetCurrent();
            Published = new(2, FreshGenerationIndexCodec.Owner, identity.User?.Value ?? throw new IOException(), "pilot", "employee",
                Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(origin))), scope.Principal,
                Convert.ToHexStringLower(SHA256.HashData(legacy)), 3, state, Candidate.Id);
            File.WriteAllBytes(Path.Combine(dir, FreshGenerationIndexStore.Current), FreshGenerationIndexCodec.Encode(Published));
            Registered = [Old.Id, Candidate.Id];
        }

        internal ConnectedExplorerSession Open(bool failCandidateOnce = false, bool admitted = true)
        {
            var failed = false;
            return new ConnectedExplorerSession(
                () => throw new InvalidOperationException("Removal must not construct an authenticated backend."),
                "pilot", "employee", new Uri(origin), Base, Path.Combine(Base, "fallback-files"),
                _ => throw new InvalidOperationException("Removal must not construct an engine."),
                (_, _, _, _) => throw new InvalidOperationException("Removal must not capture a catalog."),
                syntheticColdPreparationAdmission: () => admitted,
                syntheticFreshRootRemoval: (generation, selectorProof, token) => {
                    token.ThrowIfCancellationRequested();
                    if (!selectorProof()) throw new IOException("Selector changed before fake root cleanup.");
                    Calls.Add(generation.Id);
                    if (failCandidateOnce && generation.Id == Candidate.Id && !failed) { failed = true; return Task.FromResult<FreshGenerationPlan.RemovalReceipt?>(null); }
                    Registered.Remove(generation.Id);
                    if (!selectorProof()) throw new IOException("Selector changed during fake root cleanup.");
                    var documentVolume = generation.Id == Candidate.Id ? Published.State.ReadyRoot!.ProfileDocumentVolume : generation.ProfileDocumentVolume;
                    var profileRevision = generation.Id == Candidate.Id ? Published.State.ReadyRoot!.ProfileRevision : generation.ProfileRevision;
                    return Task.FromResult<FreshGenerationPlan.RemovalReceipt?>(new(generation.Id, documentVolume,
                        generation.ProfileDocumentFileId + 1000, profileRevision + 2));
                });
        }

        internal FreshGenerationIndexCodec.Index ReadCurrent() => FreshGenerationIndexCodec.Decode(
            File.ReadAllBytes(Path.Combine(Base, "connected-explorer-pilot-employee", FreshGenerationIndexStore.Current)));

        internal void AssertLocalFilesPreserved()
        {
            if (File.ReadAllText(OldMarker) != "old local bytes" || File.ReadAllText(CandidateMarker) != "current local bytes")
                throw new Exception("Removal changed local files.");
        }

        public ValueTask DisposeAsync() { Directory.Delete(Base, true); return ValueTask.CompletedTask; }
    }

    internal static async Task Run()
    {
        // This is the formerly false-success path: process restart has only the selector,
        // no engine/index receipt. A failed exact-root result must not mark Removed.
        await using (var failed = new Fixture())
        {
            await using (var session = failed.Open(failCandidateOnce: true)) {
                if (session.State != ExplorerPreviewState.Failed || !session.CanRemovePublishedFreshForInstaller)
                    throw new Exception("Selector-only restart did not expose the safe removal route.");
                try { await session.RemoveAsync(); throw new Exception("Unconfirmed selector-only removal reported success."); }
                catch (IOException) { }
                if (session.FreshRemovalComplete || session.State == ExplorerPreviewState.Removed || failed.ReadCurrent().State.Removal != FreshGenerationPlan.RemovalPhase.CandidateIntent ||
                    failed.Registered.Count != 2 || session.RootPath != "")
                    throw new Exception("Selector-only removal falsely reported Removed or advanced its intent.");
            }
            await using var retry = failed.Open();
            await retry.RemoveAsync();
            if (retry.State != ExplorerPreviewState.Removed || failed.Registered.Count != 0 ||
                failed.ReadCurrent().State.Removal != FreshGenerationPlan.RemovalPhase.Complete)
                throw new Exception("Selector-only retry did not resume the saved removal intent.");
            failed.AssertLocalFilesPreserved();
        }

        // The real session wiring resumes candidate/prior cleanup from persisted selector
        // phases, then a second process verifies the completed receipt without touching roots.
        await using (var f = new Fixture())
        {
            var session = f.Open();
            if (session.FreshRemovalComplete) throw new Exception("An unremoved published selector reported completed removal.");
            await session.RemoveAsync();
            if (!session.FreshRemovalComplete || session.State != ExplorerPreviewState.Removed || f.Registered.Count != 0 ||
                f.ReadCurrent().State.Removal != FreshGenerationPlan.RemovalPhase.Complete)
                throw new Exception("ConnectedExplorerSession did not complete both selector-only removals.");
            if (session.RootPath != f.CandidateRoot) throw new Exception("Completed removal did not expose the kept current folder.");
            await session.DisposeAsync();
            await using var restarted = f.Open();
            if (restarted.State != ExplorerPreviewState.Removed || restarted.CanStartPublishedFresh || !restarted.CanRemovePublishedFreshForInstaller ||
                !restarted.FreshRemovalComplete)
                throw new Exception("Completed removal was not safely recognized on restart.");
            if (restarted.RootPath != f.CandidateRoot) throw new Exception("Restart did not expose the kept current folder.");
            var selectorPath = Path.Combine(f.Base, "connected-explorer-pilot-employee", FreshGenerationIndexStore.Current);
            var savedSelector = File.ReadAllBytes(selectorPath);
            var shellCalls = 0;
            using (var entered = new ManualResetEventSlim())
            using (var release = new ManualResetEventSlim())
            using (var launcher = new LedgeTop.Files.BackgroundFolderLauncher(_ => Interlocked.Increment(ref shellCalls))) {
                var completed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                if (!launcher.TryOpen(f.CandidateRoot, result => completed.TrySetResult(result), () => {
                    entered.Set();
                    if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException();
                    return restarted.RootPath == f.CandidateRoot;
                }) || !entered.Wait(TimeSpan.FromSeconds(5))) throw new Exception("Queued launch did not reach its guard.");
                try {
                    File.WriteAllText(selectorPath, "malformed selector");
                } finally { release.Set(); }
                if (await completed.Task.WaitAsync(TimeSpan.FromSeconds(5)) || shellCalls != 0) throw new Exception("Changed selector was launched.");
            }
            File.WriteAllText(selectorPath, "malformed selector");
            if (restarted.RootPath != "") throw new Exception("Changed removal selector exposed a folder.");
            File.WriteAllBytes(selectorPath, savedSelector);
            if (restarted.RootPath != f.CandidateRoot) throw new Exception("Restored exact selector did not expose the kept folder.");
            if (!restarted.Activity.Contains("The Explorer connection was removed. Both files folders were kept.") ||
                restarted.Activity.Contains("The current files connection is ready to reconnect."))
                throw new Exception("Completed removal presented misleading reconnect activity.");
            await restarted.RemoveAsync();
            await using var unqualified = f.Open(admitted: false);
            if (unqualified.RootPath != f.CandidateRoot || unqualified.CanStartPublishedFresh)
                throw new Exception("Unqualified completed removal did not expose only its kept folder.");
            f.AssertLocalFilesPreserved();
        }

        // Installer preflight must admit only this exact schema-2 removal receipt and
        // then route through ConnectedExplorerSession.RemoveAsync.
        await using (var f = new Fixture())
        {
            var prepared = new List<ConnectedExplorerSession>();
            ConnectedExplorerSession Prepare(AccessMode mode)
            {
                if (mode == AccessMode.Employee) { var employee = f.Open(); prepared.Add(employee); return employee; }
                var client = new ConnectedExplorerSession(() => throw new InvalidOperationException(), "pilot", "portal",
                    new Uri("https://portal-test.invalid"), Path.Combine(f.Base, "client-state"), Path.Combine(f.Base, "client-files"),
                    _ => throw new InvalidOperationException(), (_, _, _, _) => throw new InvalidOperationException(),
                    syntheticColdPreparationAdmission: () => true);
                prepared.Add(client); return client;
            }
            var result = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RemoveArgument],
                () => new NoopLease(), Prepare, _ => Task.FromResult(LegacyExplorerPreviewCleanupResult.NoKnownReceipt));
            if (result != 12 || f.Registered.Count != 0 || f.ReadCurrent().State.Removal != FreshGenerationPlan.RemovalPhase.Complete)
                throw new Exception("Installer maintenance did not route schema-2 cleanup through the session remover.");
            foreach (var item in prepared) await item.DisposeAsync();
            f.AssertLocalFilesPreserved();
        }
    }

    private sealed class NoopLease : IDisposable { public void Dispose() { } }
}
