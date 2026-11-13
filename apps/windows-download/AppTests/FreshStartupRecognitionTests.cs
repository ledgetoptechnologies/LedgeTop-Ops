using System.Security.Cryptography;
using System.Text;
using LedgeTop.Files.Explorer;

namespace LedgeTop.Files.Tests;

// Exercises existing read-only recognition only: no provider adoption or native root.
internal static class FreshStartupRecognitionTests
{
    internal static async Task Run()
    {
        for (var failed = -1; failed < 5; failed++) {
            var log = new List<string>(); var stage = 0;
            bool Observe() { var n = stage++; if (n == failed) throw new IOException("Synthetic observation failure."); return true; }
            void Release(string name) => log.Add(name);
            ValueTask Dispose(string name) { log.Add(name); return ValueTask.CompletedTask; }
            try {
                var ok = await ConnectedExplorerSession.RunReadOnlyInstallObservationAsync(Observe, Observe, Observe, Observe, Observe,
                    () => Release("current"), () => Release("old"), () => Dispose("dispose-current"), () => Dispose("dispose-old"));
                Require(failed == -1 && ok, "only the fully observed sequence succeeds");
            } catch (IOException) { Require(failed >= 0, "only injected observation failure may throw"); }
            Require(log.SequenceEqual(new[] { "current", "old", "dispose-current", "dispose-old" }),
                "both observations and sessions release after every success or failure stage");
        }
        {
            var log = new List<string>();
            try {
                await ConnectedExplorerSession.RunReadOnlyInstallObservationAsync(() => true, () => true, () => true, () => true, () => true,
                    () => { log.Add("current"); throw new IOException(); }, () => log.Add("old"),
                    () => { log.Add("dispose-current"); return ValueTask.CompletedTask; },
                    () => { log.Add("dispose-old"); return ValueTask.CompletedTask; });
                throw new Exception("Release failure was ignored.");
            } catch (IOException) { }
            Require(log.SequenceEqual(new[] { "current", "old", "dispose-current", "dispose-old" }), "release failure still drains remaining resources");
        }
        var parent = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Synthetic artifact root required.");
        var dir = Path.Combine(parent, "startup-recognition-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var current = Path.Combine(dir, "current.json"); var backup = Path.Combine(dir, "legacy.json");
        var origin = "https://example.invalid"; var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(origin)));
        var scope = new FreshGenerationPlan.Scope("pilot", "employee", origin, "odqp1_" + new string('a', 64));
        var old = new FreshGenerationPlan.Generation(Guid.NewGuid(), scope, Path.Combine(dir, "old-profile"), Path.Combine(dir, "old-root"), new string('b', 64), 1, 2, 1, 1, 3, 1, 6, Guid.NewGuid());
        var next = new FreshGenerationPlan.Generation(Guid.NewGuid(), scope, Path.Combine(dir, "new-profile"), Path.Combine(dir, "new-root"), new string('c', 64), 1, 4, 1, 1, 5);
        var prepared = FreshGenerationPlan.Prepare(new(old, null, FreshGenerationPlan.Phase.OldActive), next, scope, true, true);
        var legacy = Encoding.UTF8.GetBytes("{\"Schema\":1}"); File.WriteAllBytes(backup, legacy);
        var selector = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, "S-1-5-test", scope.Channel, scope.Source, hash,
            scope.Principal, Convert.ToHexStringLower(SHA256.HashData(legacy)), 2, prepared, old.Id);
        var ready = new FreshGenerationPlan.RootEvidence(1, 10, Guid.NewGuid(), 2, 1, 11);
        var published = selector with { State = prepared with { Phase = FreshGenerationPlan.Phase.Published, ReadyRoot = ready }, ActiveGeneration = next.Id };
        Require(ConnectedExplorerSession.PublishedSelectorEligibleForInstall(published, false, true), "published qualified selector reaches ownership checks");
        Require(!ConnectedExplorerSession.PublishedSelectorEligibleForInstall(null, false, true) &&
            !ConnectedExplorerSession.PublishedSelectorEligibleForInstall(published, true, true) &&
            !ConnectedExplorerSession.PublishedSelectorEligibleForInstall(published, false, false) &&
            !ConnectedExplorerSession.PublishedSelectorEligibleForInstall(selector, false, true) &&
            !ConnectedExplorerSession.PublishedSelectorEligibleForInstall(published with { ActiveGeneration = old.Id }, false, true) &&
            !ConnectedExplorerSession.PublishedSelectorEligibleForInstall(published with { State = published.State with { ReadyRoot = null } }, false, true),
            "missing, invalid, unqualified, partial, and mismatched selectors refuse installation");
        var observedScope = new ExplorerRootScope(scope.Channel, scope.Source, scope.Origin, scope.Principal);
        var snapshot = new ConnectedGenerationSnapshot(old.Id, old.ProfileDirectory, old.RootPath, (long)old.RootFileId,
            old.NamespaceClsid, old.ManifestDigest, observedScope, old.ProfileRevision);
        var evidence = new RestartGenerationEvidence(snapshot, old.ProfileDirectoryVolume, old.ProfileDirectoryFileId,
            old.ProfileDocumentVolume, old.ProfileDocumentFileId, old.RootVolume, old.RootFileId);
        bool Matches(RestartGenerationEvidence value) => FreshGenerationColdRestart.Matches(value, old, old.RootVolume, old.RootFileId,
            old.NamespaceClsid, old.ProfileRevision, old.ProfileDocumentVolume, old.ProfileDocumentFileId);
        Require(Matches(evidence) && !Matches(evidence with { RootFileId = old.RootFileId + 1 }) &&
            !Matches(evidence with { ProfileDocumentFileId = old.ProfileDocumentFileId + 1 }) &&
            !Matches(evidence with { Snapshot = snapshot with { NamespaceClsid = Guid.NewGuid() } }) &&
            !Matches(evidence with { Snapshot = snapshot with { ManifestDigest = new string('d', 64) } }),
            "fresh install proof requires matching root, profile, namespace and manifest identities");
        var encoded = FreshGenerationIndexCodec.Encode(selector); File.WriteAllBytes(current, encoded);
        FreshGenerationIndexCodec.Index? Read(string sid = "S-1-5-test", string channel = "pilot", string source = "employee", string? originHash = null) =>
            FreshGenerationStartup.Observe(current, backup, sid, channel, source, originHash ?? hash);
        Require(Read() == selector, "valid schema2 recognized");
        Refuse(() => Read(sid: "S-1-5-other")); Refuse(() => Read(channel: "stable"));
        Refuse(() => Read(source: "portal")); Refuse(() => Read(originHash: new string('0', 64)));
        File.WriteAllText(backup, "changed"); Refuse(() => Read()); File.WriteAllBytes(backup, legacy);
        File.Delete(backup); Refuse(() => Read());
        Require(File.ReadAllBytes(current).AsSpan().SequenceEqual(encoded), "rejections do not rewrite selector");
        File.WriteAllBytes(current, legacy);
        Require(Read() is null && File.ReadAllBytes(current).AsSpan().SequenceEqual(legacy), "schema1 falls through unchanged without backup");
        var authCalls = 0;
        var disabled = FreshGenerationColdRestart.CreateDisabled(null!, null!, selector, _ => { authCalls++; throw new Exception("Disabled restart reached auth"); });
        try { await disabled.VerifyAndStartAsync(CancellationToken.None); throw new Exception("Disabled restart was admitted"); }
        catch (IOException) { }
        Require(authCalls == 0 && File.ReadAllBytes(current).AsSpan().SequenceEqual(legacy) && !Directory.Exists(old.RootPath) && !Directory.Exists(next.RootPath),
            "disabled restart does not authenticate, modify selector, or create roots");
    }
    private static void Refuse(Action action) { try { action(); } catch (IOException) { return; } throw new Exception("Invalid selector was accepted."); }
    private static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
}
