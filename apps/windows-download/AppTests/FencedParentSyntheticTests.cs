#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
using System.Security.Principal;
using System.Text.Json;
using LedgeTop.Files;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class FencedParentSyntheticTests
{
    internal static async Task Run()
    {
        CleanupFailures();
        foreach (var mode in new[] { "success", "selector", "old", "account", "abort-failed", "commit", "owner-cancel", "commit-denied", "uncancellable", "cancel-precommit", "cancel-postcommit" }) await Case(mode);
        Console.WriteLine("PASS parent fenced orchestration with synthetic provider and held Windows filesystem handles; no CFAPI registration.");
    }
    private static void CleanupFailures()
    {
        var original = new IOException("original acquisition failure");
        var firstError = new IOException("first disposal failure"); var secondError = new IOException("second disposal failure");
        var calls = new List<string>();
        var first = new TrackedDisposable("first", calls, firstError); var middle = new TrackedDisposable("middle", calls, null);
        var last = new TrackedDisposable("last", calls, secondError);
        AggregateException? observed = null;
        try { FreshGenerationSelectorLease.CleanupAfterFailure(original, first, middle, last); }
        catch (AggregateException error) { observed = error; }
        Require(calls.SequenceEqual(["first", "middle", "last"]) && observed is not null && observed.InnerExceptions.Count == 3 &&
            ReferenceEquals(observed.InnerExceptions[0], original) && ReferenceEquals(observed.InnerExceptions[1], firstError) &&
            ReferenceEquals(observed.InnerExceptions[2], secondError) && FreshGenerationSelectorLease.IsQuarantinedForTest(first) &&
            !FreshGenerationSelectorLease.IsQuarantinedForTest(middle) && FreshGenerationSelectorLease.IsQuarantinedForTest(last),
            "every cleanup is attempted, original failure retained and uncertain handles quarantined");
        var ordinary = new IOException("ordinary acquisition failure"); Exception? rethrown = null;
        try { FreshGenerationSelectorLease.CleanupAfterFailure(ordinary, new TrackedDisposable("ok", calls, null)); }
        catch (Exception error) { rethrown = error; }
        Require(ReferenceEquals(rethrown, ordinary), "successful cleanup preserves original exception");
    }
    private sealed class TrackedDisposable(string name, List<string> calls, Exception? error) : IDisposable
    {
        public void Dispose() { calls.Add(name); if (error is not null) throw error; }
    }
    private static async Task Case(string mode)
    {
        var folder = Path.Combine(Path.GetTempPath(), "lt-fenced-parent-" + Guid.NewGuid().ToString("N"));
        if (Directory.Exists(folder) || File.Exists(folder)) throw new IOException("Fixture exists.");
        Directory.CreateDirectory(folder);
        using var source = new ExplorerDemoSource(signedIn: true, chunkDelay: TimeSpan.Zero);
        var origin = source.Origin.GetLeftPart(UriPartial.Authority);
        var scope = new FreshGenerationPlan.Scope("pilot", source.Alias, origin, source.PrincipalId);
        var nativeScope = new ExplorerRootScope(scope.Channel, scope.Source, scope.Origin, scope.Principal);
        var manifest = new ExplorerRootManifest(nativeScope, new Dictionary<string, PlaceholderIdentity>());
        var oldValid = true; var lockRejected = false;
        (OwnedExplorerRootSession Session, RestartGenerationEvidence Evidence) Prepare(string name, Func<bool> proof) {
            var profileDir = Path.Combine(folder, name + "-profile"); var root = Path.Combine(folder, name + "-root");
            Directory.CreateDirectory(profileDir); Directory.CreateDirectory(root);
            var id = Guid.NewGuid(); var manifestName = "manifest-" + id.ToString("N") + ".json";
            File.WriteAllBytes(Path.Combine(profileDir, manifestName), manifest.Encode());
            using var identity = WindowsIdentity.GetCurrent();
            File.WriteAllText(Path.Combine(profileDir, "profile.json"), JsonSerializer.Serialize(new {
                Schema = 3, Owner = "LedgeTop.Files.ConnectedExplorer/1", Sid = identity.User!.Value, Identity = id,
                Root = root, Context = "LedgeTop.Files.ConnectedExplorer/1:" + id.ToString("N"),
                Icon = ExplorerBrandIcon.LegacyResource, RootFileId = 1, Phase = "Ready", Paused = false, Revision = 2,
                NamespaceClsid = Guid.NewGuid(), Binding = new { Scope = nativeScope, File = manifestName, Digest = manifest.Digest }
            }));
            var session = OwnedExplorerRootSession.CandidateForTest(profileDir, root, source, nativeScope, manifest,
                priorVerify: _ => proof(), priorDrain: _ => Task.CompletedTask);
            var stream = new FileStream(Path.Combine(profileDir, "session.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            var handles = ConnectedGenerationHandleLease.Open(profileDir, manifestName, root);
            var snapshot = new ConnectedGenerationSnapshot(id, profileDir, root, unchecked((long)handles.RootFileId), Guid.NewGuid(), manifest.Digest, nativeScope, 2);
            var evidence = new RestartGenerationEvidence(snapshot, handles.ProfileDirectoryVolume, handles.ProfileDirectoryFileId, handles.ProfileVolume, handles.ProfileFileId, handles.RootVolume, handles.RootFileId);
            session.AttachSyntheticRestartForTest(stream, new ConnectedGenerationHeldObservation(snapshot, handles)); return (session, evidence);
        }
        var prior = Prepare("old", () => oldValid); var current = Prepare("new", () => true); var p = prior.Evidence; var c = current.Evidence;
        var old = new FreshGenerationPlan.Generation(p.Snapshot.Identity, scope, p.Snapshot.ProfileDirectory, p.Snapshot.RootPath, p.Snapshot.ManifestDigest, p.ProfileDirectoryVolume, p.ProfileDirectoryFileId, p.Snapshot.ProfileRevision, p.ProfileDocumentVolume, p.ProfileDocumentFileId, p.RootVolume, p.RootFileId, p.Snapshot.NamespaceClsid);
        var next = new FreshGenerationPlan.Generation(c.Snapshot.Identity, scope, c.Snapshot.ProfileDirectory, c.Snapshot.RootPath, c.Snapshot.ManifestDigest, c.ProfileDirectoryVolume, c.ProfileDirectoryFileId, 1, c.ProfileDocumentVolume, c.ProfileDocumentFileId);
        var prepared = FreshGenerationPlan.Prepare(new(old, null, FreshGenerationPlan.Phase.OldActive), next, scope, true, true);
        var ready = FreshGenerationPlan.Ready(FreshGenerationPlan.Drained(prepared, true), scope, next.Id, next.ManifestDigest, next.RootPath,
            new(c.RootVolume, c.RootFileId, c.Snapshot.NamespaceClsid, c.Snapshot.ProfileRevision, c.ProfileDocumentVolume, c.ProfileDocumentFileId), true);
        using var user = WindowsIdentity.GetCurrent();
        var backupBytes = System.Text.Encoding.UTF8.GetBytes("synthetic legacy index");
        var selector = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, user.User!.Value, "pilot", scope.Source,
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(origin))), scope.Principal,
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(backupBytes)), 4, FreshGenerationPlan.Publish(ready, true), next.Id);
        var stateDir = Path.Combine(folder, "state"); Directory.CreateDirectory(stateDir);
        var currentPath = Path.Combine(stateDir, "current.json"); var backupPath = Path.Combine(stateDir, "backup.json"); var lockPath = Path.Combine(stateDir, "index.lock");
        var selectorBytes = FreshGenerationIndexCodec.Encode(selector); File.WriteAllBytes(currentPath, selectorBytes); File.WriteAllBytes(backupPath, backupBytes); using (File.Create(lockPath)) { }
        if (mode == "selector") {
            File.WriteAllText(backupPath, "different"); var refused = false;
            try { using var invalid = FreshGenerationSelectorLease.Acquire(lockPath, currentPath, backupPath, selector); } catch (IOException) { refused = true; }
            Require(refused, "changed backup was accepted");
            using (new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            File.WriteAllBytes(backupPath, backupBytes);
        }
        var selectorLease = FreshGenerationSelectorLease.Acquire(lockPath, currentPath, backupPath, selector);
        var auth = 0; var drains = 0; var failDrain = mode == "abort-failed"; Task? stickyFailure = null;
        using var owner = new CancellationTokenSource();
        if (mode == "cancel-postcommit") current.Session.SetSyntheticAfterFencedCommitForTest(owner.Cancel);
        FreshGenerationColdRestart? restart = null;
        current.Session.SetSyntheticFencedConnectHooksForTest(new(async () => {
            if (mode == "selector") {
                var reentrant = 0;
                try { restart!.DisposeSelectorForTest(); } catch (IOException) { reentrant++; }
                try { restart!.TransferSelectorForTest(); } catch (IOException) { reentrant++; }
                await Task.Run(() => {
                var refusals = 0;
                try { using var conflict = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); } catch (IOException) { refusals++; }
                try { File.WriteAllText(currentPath, "changed"); } catch (IOException) { refusals++; }
                try { File.WriteAllText(backupPath, "changed"); } catch (IOException) { refusals++; }
                selectorLease.Dispose(); // Old alias must not close the transferred handles.
                try { restart!.DisposeSelectorForTest(); } catch (IOException) { refusals++; }
                try { restart!.TransferSelectorForTest(); } catch (IOException) { refusals++; }
                lockRejected = refusals == 5 && reentrant == 2;
                });
            }
            if (mode == "old") oldValid = false;
        }, () => {
            drains++;
            if (stickyFailure is not null) return stickyFailure;
            if (failDrain) return stickyFailure = Task.FromException(new IOException("synthetic sticky drain"));
            return Task.CompletedTask;
        }));
        restart = FreshGenerationColdRestart.CreateSyntheticFencedForTest(prior.Session, current.Session, selector,
            _ => Task.FromResult((++auth == 2 && mode is "account" or "abort-failed") || (auth == 3 && mode == "commit-denied") ? scope with { Principal = "different" } : scope), selectorLease);
        var oldBytes = File.ReadAllBytes(Path.Combine(p.Snapshot.ProfileDirectory, "profile.json"));
        var newBytes = File.ReadAllBytes(Path.Combine(c.Snapshot.ProfileDirectory, "profile.json"));
        var passed = false;
        try {
            var failed = false;
            try {
                await restart.VerifyAndConnectFencedAsync(CancellationToken.None);
                if (mode is "commit" or "owner-cancel" or "commit-denied" or "uncancellable" or "cancel-precommit" or "cancel-postcommit") {
                    if (mode == "cancel-precommit") owner.Cancel();
                    await restart.CommitFencedAsync(mode == "uncancellable" ? CancellationToken.None : owner.Token, CancellationToken.None);
                    _ = await current.Session.ReadSyntheticFencedSourceForTest();
                    if (mode == "owner-cancel") {
                        owner.Cancel(); var denied = false;
                        try { _ = await current.Session.ReadSyntheticFencedSourceForTest(); } catch (DownloadsPausedException) { denied = true; }
                        Require(denied, "owner cancellation did not revoke further source leases");
                    }
                }
            }
            catch (IOException) when (mode is "old" or "account") { failed = true; }
            catch (IOException) when (mode == "commit-denied") { failed = true; }
            catch (IOException) when (mode == "uncancellable") { failed = true; }
            catch (OperationCanceledException) when (mode == "cancel-precommit") { failed = true; }
            catch (OperationCanceledException) when (mode == "cancel-postcommit") { failed = true; }
            catch (AggregateException) when (mode == "abort-failed") { failed = true; }
            Require(failed == (mode is "old" or "account" or "abort-failed" or "commit-denied" or "uncancellable" or "cancel-precommit" or "cancel-postcommit"), "unexpected parent outcome");
            Require(mode != "selector" || lockRejected && File.ReadAllBytes(currentPath).AsSpan().SequenceEqual(selectorBytes) && File.ReadAllBytes(backupPath).AsSpan().SequenceEqual(backupBytes), "selector lease failed to block competing changes");
            selectorLease.Dispose(); // A stale alias cannot release ownership after the decision returns.
            var stillHeld = false;
            try { using var conflict = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); } catch (IOException) { stillHeld = true; }
            Require(stillHeld, "stale selector alias released the parent's lock");
            Require(current.Session.SyntheticFencedAttemptOwnedForTest == (mode is "success" or "selector" or "abort-failed" or "commit" or "owner-cancel"), "attempt retention differs");
            if (mode is "commit-denied" or "uncancellable" or "cancel-precommit" or "cancel-postcommit") Require(drains == 1, "commit failure did not drain the exact attempt");
            Require(File.ReadAllBytes(Path.Combine(p.Snapshot.ProfileDirectory, "profile.json")).AsSpan().SequenceEqual(oldBytes) &&
                File.ReadAllBytes(Path.Combine(c.Snapshot.ProfileDirectory, "profile.json")).AsSpan().SequenceEqual(newBytes), "profile changed");
            foreach (var path in new[] { p.Snapshot.ProfileDirectory, c.Snapshot.ProfileDirectory }) {
                try { using var unexpected = new FileStream(Path.Combine(path, "session.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("lease released"); }
                catch (IOException) { }
            }
            if (mode == "abort-failed") {
                var stillFailed = false; try { await restart.AbortFencedAsync(); } catch (IOException) { stillFailed = true; }
                Require(stillFailed && current.Session.SyntheticFencedAttemptOwnedForTest && drains == 2, "sticky drain failure must retain ownership");
            }
            passed = true;
        } finally {
            oldValid = true; failDrain = false; stickyFailure = null; // Synthetic teardown only.
            if (current.Session.SyntheticFencedAttemptOwnedForTest) await restart.AbortFencedAsync();
            await restart.StopHeldAsync(); await restart.DisposeStoppedSessionsAsync();
            using (new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            if (passed) {
                try { RemoveFixture(folder, p.Snapshot, c.Snapshot, oldBytes, newBytes, manifest.Encode(), selectorBytes, backupBytes); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) { Console.WriteLine("Synthetic parent cleanup unconfirmed: " + folder); }
            } else Console.WriteLine("Synthetic parent fixture retained after failure: " + folder);
        }
    }
    private static void RemoveFixture(string folder, ConnectedGenerationSnapshot old, ConnectedGenerationSnapshot next, byte[] oldBytes, byte[] nextBytes, byte[] manifest, byte[] selector, byte[] backup)
    {
        if (!string.Equals(Path.GetDirectoryName(folder), Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) ||
            !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(folder), @"\Alt-fenced-parent-[a-f0-9]{32}\z")) throw new IOException("Invalid fixture location.");
        void Exact(string path, params string[] names) {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Alias in fixture.");
            var items = Directory.GetFileSystemEntries(path);
            if (items.Length != names.Length || items.Any(x => !names.Contains(Path.GetFileName(x), StringComparer.OrdinalIgnoreCase) || (File.GetAttributes(x) & FileAttributes.ReparsePoint) != 0))
                throw new IOException("Unexpected fixture contents.");
        }
        Exact(folder, "old-profile", "new-profile", "old-root", "new-root", "state");
        var state = Path.Combine(folder, "state"); Exact(state, "current.json", "backup.json", "index.lock");
        if (!File.ReadAllBytes(Path.Combine(state, "current.json")).AsSpan().SequenceEqual(selector) || !File.ReadAllBytes(Path.Combine(state, "backup.json")).AsSpan().SequenceEqual(backup) || new FileInfo(Path.Combine(state, "index.lock")).Length != 0) throw new IOException("Selector fixture changed.");
        void Profile(ConnectedGenerationSnapshot snapshot, byte[] bytes) {
            var profile = snapshot.ProfileDirectory; var name = "manifest-" + snapshot.Identity.ToString("N") + ".json";
            var cache = Path.Combine(profile, "cache"); var leaf = Path.Combine(cache, snapshot.Identity.ToString("N")); var hasCache = Directory.Exists(cache);
            Exact(profile, hasCache ? ["profile.json", name, "session.lock", "cache"] : ["profile.json", name, "session.lock"]);
            if (hasCache) { Exact(cache, snapshot.Identity.ToString("N")); Exact(leaf); }
            if (!File.ReadAllBytes(Path.Combine(profile, "profile.json")).AsSpan().SequenceEqual(bytes) ||
                !File.ReadAllBytes(Path.Combine(profile, name)).AsSpan().SequenceEqual(manifest) || new FileInfo(Path.Combine(profile, "session.lock")).Length != 0)
                throw new IOException("Fixture bytes changed.");
        }
        Exact(old.RootPath); Exact(next.RootPath); Profile(old, oldBytes); Profile(next, nextBytes);
        void DeleteProfile(ConnectedGenerationSnapshot snapshot) {
            var profile = snapshot.ProfileDirectory; var cache = Path.Combine(profile, "cache");
            File.Delete(Path.Combine(profile, "profile.json")); File.Delete(Path.Combine(profile, "manifest-" + snapshot.Identity.ToString("N") + ".json")); File.Delete(Path.Combine(profile, "session.lock"));
            if (Directory.Exists(cache)) { Directory.Delete(Path.Combine(cache, snapshot.Identity.ToString("N"))); Directory.Delete(cache); }
            Directory.Delete(profile);
        }
        DeleteProfile(old); DeleteProfile(next); Directory.Delete(old.RootPath); Directory.Delete(next.RootPath);
        File.Delete(Path.Combine(state, "current.json")); File.Delete(Path.Combine(state, "backup.json")); File.Delete(Path.Combine(state, "index.lock")); Directory.Delete(state); Directory.Delete(folder);
    }
    private static void Require(bool value, string message) { if (!value) throw new IOException(message); }
}
#endif
