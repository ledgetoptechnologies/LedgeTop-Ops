using System.Security.Cryptography;
using System.Text;

namespace LedgeTop.Files.Tests;

internal static class FreshGenerationPlanTests
{
    internal static async Task Run()
    {
        var scope = new FreshGenerationPlan.Scope("pilot", "employee", "https://example.invalid", "principal");
        var old = new FreshGenerationPlan.Generation(Guid.NewGuid(), scope, @"C:\pilot\old-profile", @"C:\files\old", new string('a', 64), 100, 101, 1, 100, 201, 100, 301, Guid.NewGuid());
        var next = new FreshGenerationPlan.Generation(Guid.NewGuid(), scope, @"C:\pilot\new-profile", @"C:\files\new", new string('b', 64), 100, 102, 1, 100, 202);
        var initial = new FreshGenerationPlan.State(old, null, FreshGenerationPlan.Phase.OldActive);
        Refuse(() => FreshGenerationPlan.Prepare(initial, next, scope, false, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next, scope, true, false));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { Id = old.Id }, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial with { Old = old with { RootFileId = 0 } }, next, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial with { Old = old with { NamespaceClsid = Guid.Empty } }, next, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { RootFileId = 301 }, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { Scope = scope with { Principal = "other" } }, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { RootPath = old.RootPath + @"\child" }, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { ProfileDirectory = old.ProfileDirectory }, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { ProfileDirectoryVolume = 0 }, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { ProfileDirectoryFileId = 0 }, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { ProfileDocumentFileId = 0 }, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { ProfileDocumentVolume = 999 }, scope, true, true));
        Refuse(() => FreshGenerationPlan.Prepare(initial, next with { RootPath = next.ProfileDirectory }, scope, true, true));
        var prepared = FreshGenerationPlan.Prepare(initial, next, scope, true, true);
        Refuse(() => FreshGenerationPlan.Drained(prepared, false));
        Refuse(() => FreshGenerationPlan.Publish(prepared, true));
        var drained = FreshGenerationPlan.Drained(prepared, true);
        var rootEvidence = new FreshGenerationPlan.RootEvidence(100, 103, Guid.NewGuid(), 4, 100, 204);
        Refuse(() => FreshGenerationPlan.Ready(drained, scope with { Principal = "other" }, next.Id, next.ManifestDigest, next.RootPath, rootEvidence, true));
        Refuse(() => FreshGenerationPlan.Ready(drained, scope, next.Id, next.ManifestDigest, next.RootPath, rootEvidence, false));
        Refuse(() => FreshGenerationPlan.Ready(drained, scope, next.Id, next.ManifestDigest, next.RootPath, rootEvidence with { FileId = 0 }, true));
        Refuse(() => FreshGenerationPlan.Ready(drained, scope, next.Id, next.ManifestDigest, next.RootPath, rootEvidence with { NamespaceClsid = Guid.Empty }, true));
        Refuse(() => FreshGenerationPlan.Ready(drained, scope, next.Id, next.ManifestDigest, next.RootPath, rootEvidence with { ProfileDocumentFileId = 0 }, true));
        Refuse(() => FreshGenerationPlan.Ready(drained, scope, next.Id, next.ManifestDigest, next.RootPath, rootEvidence with { ProfileRevision = next.ProfileRevision }, true));
        Refuse(() => FreshGenerationPlan.Ready(drained, scope, next.Id, next.ManifestDigest, next.RootPath, rootEvidence with { ProfileDocumentVolume = 999 }, true));
        Refuse(() => FreshGenerationPlan.Ready(drained, scope, next.Id, new string('c', 64), next.RootPath, rootEvidence, true));
        var ready = FreshGenerationPlan.Ready(drained, scope, next.Id, next.ManifestDigest, next.RootPath, rootEvidence, true);
        if (ready.ReadyRoot?.ProfileDocumentFileId == next.ProfileDocumentFileId) throw new Exception("Prepared and replacement profile identities were conflated.");
        Refuse(() => FreshGenerationPlan.Publish(ready, false));
        var published = FreshGenerationPlan.Publish(ready, true);
        if (published.Old != old || published.New != next || published.Phase != FreshGenerationPlan.Phase.Published)
            throw new Exception("Published planning state lost a generation.");
        Refuse(() => FreshGenerationPlan.Prepare(published, next with { Id = Guid.NewGuid() }, scope, true, true));
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(scope.Origin)));
        var selector = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, "S-1-5-21-test", scope.Channel,
            scope.Source, hash, scope.Principal, new string('d', 64), 1, prepared, old.Id);
        if (FreshGenerationIndexCodec.Decode(FreshGenerationIndexCodec.Encode(selector)) != selector)
            throw new Exception("Prepared selector did not round trip.");
        Refuse(() => FreshGenerationIndexCodec.Encode(selector with { ActiveGeneration = next.Id }));
        Refuse(() => FreshGenerationIndexCodec.Encode(selector with { OriginSha256 = new string('0', 64) }));
        var active = selector with { State = published, ActiveGeneration = next.Id, Revision = 2 };
        if (FreshGenerationIndexCodec.Decode(FreshGenerationIndexCodec.Encode(active)) != active)
            throw new Exception("Published selector did not retain both generations.");
        Refuse(() => FreshGenerationIndexCodec.Encode(active with { ActiveGeneration = old.Id }));
        var json = Encoding.UTF8.GetString(FreshGenerationIndexCodec.Encode(active));
        try { FreshGenerationIndexCodec.Decode(Encoding.UTF8.GetBytes(json.Replace("ProfileDirectoryFileId", "ProfileFileId", StringComparison.Ordinal))); throw new Exception("Ambiguous old selector property accepted."); }
        catch (System.Text.Json.JsonException) { }
        Refuse(() => FreshGenerationIndexCodec.Decode(Encoding.UTF8.GetBytes(json.Replace("{\"Schema\":2", "{\"Schema\":2,\"Schema\":2", StringComparison.Ordinal))));
        var artifact = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Synthetic artifact root required.");
        var indexDir = Path.Combine(artifact, "fresh-selector-" + Guid.NewGuid().ToString("N"), "connected-explorer-pilot-employee");
        Directory.CreateDirectory(indexDir);
        var legacy = Encoding.UTF8.GetBytes("synthetic-owned-schema-1");
        File.WriteAllBytes(Path.Combine(indexDir, FreshGenerationIndexStore.Current), legacy);
        var preparedIndex = selector with { Revision = 2, LegacyBackupSha256 = Convert.ToHexStringLower(SHA256.HashData(legacy)) };
        try {
            await FreshGenerationIndexStore.PublishAsync(indexDir, legacy, preparedIndex, () => true,
                _ => new FreshGenerationIndexStore.LegacyBinding(1, "other-sid", scope.Channel, scope.Source, hash, scope.Principal, old));
            throw new Exception("Foreign legacy SID accepted.");
        } catch (IOException) { }
        try {
            await FreshGenerationIndexStore.PublishAsync(indexDir, legacy, preparedIndex, () => true,
                _ => new FreshGenerationIndexStore.LegacyBinding(1, selector.Sid, scope.Channel, scope.Source, hash, scope.Principal, old with { Id = Guid.NewGuid() }));
            throw new Exception("Different old generation accepted.");
        } catch (IOException) { }
        try {
            await FreshGenerationIndexStore.PublishAsync(indexDir, legacy, preparedIndex, () => true,
                _ => new FreshGenerationIndexStore.LegacyBinding(1, selector.Sid, scope.Channel, scope.Source, hash, scope.Principal, old with { RootFileId = old.RootFileId + 1 }));
            throw new Exception("Different prior root identity accepted.");
        } catch (IOException) { }
        if (File.Exists(Path.Combine(indexDir, FreshGenerationIndexStore.LegacyBackup))) throw new Exception("Rejected legacy proof wrote a backup.");
        var written = await FreshGenerationIndexStore.PublishAsync(indexDir, legacy, preparedIndex, () => true,
            bytes => bytes.AsSpan().SequenceEqual(legacy) ? new FreshGenerationIndexStore.LegacyBinding(1, selector.Sid, scope.Channel, scope.Source, hash, scope.Principal, old) : null);
        if (!File.ReadAllBytes(Path.Combine(indexDir, FreshGenerationIndexStore.LegacyBackup)).AsSpan().SequenceEqual(legacy) ||
            !written.AsSpan().SequenceEqual(File.ReadAllBytes(Path.Combine(indexDir, FreshGenerationIndexStore.Current))))
            throw new Exception("Selector publication lost its original index bytes.");
        var drainedIndex = preparedIndex with { Revision = 3, State = drained };
        var afterDrain = await FreshGenerationIndexStore.PublishAsync(indexDir, written, drainedIndex, () => true, _ => null);
        if (FreshGenerationIndexCodec.Decode(afterDrain) != drainedIndex) throw new Exception("Drained selector did not persist.");
        var tamperedPreparedFile = ready with { New = next with { ProfileDocumentFileId = next.ProfileDocumentFileId + 1 } };
        try { await FreshGenerationIndexStore.PublishAsync(indexDir, afterDrain, drainedIndex with { Revision = 4, State = tamperedPreparedFile }, () => true, _ => null); throw new Exception("Changed prepared profile file identity accepted."); }
        catch (IOException) { }
        try { await FreshGenerationIndexStore.PublishAsync(indexDir, written, drainedIndex, () => true, _ => null); throw new Exception("Stale selector accepted."); }
        catch (IOException) { }
        try { await FreshGenerationIndexStore.PublishAsync(indexDir, afterDrain, active with { Revision = 4 }, () => true, _ => null); throw new Exception("Skipped phase accepted."); }
        catch (IOException) { }
        try { await FreshGenerationIndexStore.PublishAsync(indexDir, afterDrain, drainedIndex, () => false, _ => null); throw new Exception("Unowned lease accepted."); }
        catch (IOException) { }
        var readyIndex = drainedIndex with { Revision = 4, State = ready };
        var afterReady = await FreshGenerationIndexStore.PublishAsync(indexDir, afterDrain, readyIndex, () => true, _ => null);
        var tamperedReady = published with { ReadyRoot = rootEvidence with { ProfileDocumentFileId = rootEvidence.ProfileDocumentFileId + 1 } };
        try { await FreshGenerationIndexStore.PublishAsync(indexDir, afterReady, readyIndex with { Revision = 5, State = tamperedReady, ActiveGeneration = next.Id }, () => true, _ => null); throw new Exception("Changed ready profile identity accepted."); }
        catch (IOException) { }
        File.WriteAllText(Path.Combine(indexDir, FreshGenerationIndexStore.LegacyBackup), "tampered");
        try { await FreshGenerationIndexStore.PublishAsync(indexDir, afterReady, readyIndex with { Revision = 5, State = published, ActiveGeneration = next.Id }, () => true, _ => null); throw new Exception("Changed legacy backup accepted."); }
        catch (IOException) { }
        if (!File.ReadAllBytes(Path.Combine(indexDir, FreshGenerationIndexStore.Current)).AsSpan().SequenceEqual(afterReady))
            throw new Exception("Changed backup advanced selector.");
        var principal = "odqp1_" + new string('a', 64); var boundScope = scope with { Principal = principal };
        var boundOld = old with { Scope = boundScope }; var boundNext = next with { Scope = boundScope };
        var boundPrepared = FreshGenerationPlan.Prepare(new(boundOld, null, FreshGenerationPlan.Phase.OldActive), boundNext, boundScope, true, true);
        var boundDrained = FreshGenerationPlan.Drained(boundPrepared, true);
        var boundReady = FreshGenerationPlan.Ready(boundDrained, boundScope, boundNext.Id, boundNext.ManifestDigest, boundNext.RootPath, rootEvidence, true);
        var phases = new[] { boundPrepared, boundDrained, boundReady, FreshGenerationPlan.Publish(boundReady, true) };
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value ?? throw new IOException(); var savedLegacy = Encoding.UTF8.GetBytes("retained legacy selector");
        foreach (var phase in phases) {
            var startupBase = Path.Combine(artifact, "fresh-startup-" + Guid.NewGuid().ToString("N"));
            var startupDir = Path.Combine(startupBase, "connected-explorer-pilot-employee"); Directory.CreateDirectory(startupDir);
            var startupSelector = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, sid, "pilot", "employee",
                hash, principal, Convert.ToHexStringLower(SHA256.HashData(savedLegacy)), 2, phase,
                phase.Phase == FreshGenerationPlan.Phase.Published ? boundNext.Id : boundOld.Id);
            var startupBytes = FreshGenerationIndexCodec.Encode(startupSelector);
            File.WriteAllBytes(Path.Combine(startupDir, FreshGenerationIndexStore.Current), startupBytes);
            File.WriteAllBytes(Path.Combine(startupDir, FreshGenerationIndexStore.LegacyBackup), savedLegacy);
            await using (var startup = new ConnectedExplorerSession(() => throw new Exception("Backend must not be constructed."),
                "pilot", "employee", new Uri(scope.Origin), startupBase, @"C:\files\old")) {
                if (!startup.FreshGenerationRecoveryRequired || !startup.RequiresOwnershipReview || startup.StartupProfileState != LedgeTop.Files.Backends.SavedProfileState.NeedsReview || startup.CanReconnectCached)
                    throw new Exception("Schema-2 startup was not safely held.");
                try { await startup.RemoveAsync(); throw new Exception("Held selector allowed removal."); } catch (IOException) { }
                if (!startup.Activity.Any(line => line.Contains("fresh-files transition needs ownership review", StringComparison.Ordinal)) ||
                    startup.Activity.Any(line => line.Contains("Try Remove", StringComparison.Ordinal)))
                    throw new Exception("Held selector suggested unavailable removal.");
            }
            if (!File.ReadAllBytes(Path.Combine(startupDir, FreshGenerationIndexStore.Current)).AsSpan().SequenceEqual(startupBytes) ||
                !File.ReadAllBytes(Path.Combine(startupDir, FreshGenerationIndexStore.LegacyBackup)).AsSpan().SequenceEqual(savedLegacy))
                throw new Exception("Startup hold changed retained selector files.");
        }
        var malformedBase = Path.Combine(artifact, "fresh-invalid-" + Guid.NewGuid().ToString("N"));
        var malformedDir = Path.Combine(malformedBase, "connected-explorer-pilot-employee"); Directory.CreateDirectory(malformedDir);
        var malformedBytes = Encoding.UTF8.GetBytes("{invalid selector");
        File.WriteAllBytes(Path.Combine(malformedDir, FreshGenerationIndexStore.Current), malformedBytes);
        await using (var malformed = new ConnectedExplorerSession(() => throw new Exception("Backend must remain untouched."),
            "pilot", "employee", new Uri(scope.Origin), malformedBase, @"C:\files\old")) {
            if (!malformed.RequiresOwnershipReview || malformed.FreshGenerationRecoveryRequired || malformed.CanReconnectCached)
                throw new Exception("Malformed selector ownership review was not exposed.");
        }
        if (!File.ReadAllBytes(Path.Combine(malformedDir, FreshGenerationIndexStore.Current)).AsSpan().SequenceEqual(malformedBytes))
            throw new Exception("Malformed selector was changed.");
        var missingBase = Path.Combine(artifact, "fresh-missing-backup-" + Guid.NewGuid().ToString("N"));
        var missingDir = Path.Combine(missingBase, "connected-explorer-pilot-employee"); Directory.CreateDirectory(missingDir);
        var missingSelector = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, sid, "pilot", "employee",
            hash, principal, Convert.ToHexStringLower(SHA256.HashData(savedLegacy)), 2, boundPrepared, boundOld.Id);
        var missingBytes = FreshGenerationIndexCodec.Encode(missingSelector);
        File.WriteAllBytes(Path.Combine(missingDir, FreshGenerationIndexStore.Current), missingBytes);
        await using (var missing = new ConnectedExplorerSession(() => throw new Exception("Backend must remain untouched."),
            "pilot", "employee", new Uri(scope.Origin), missingBase, @"C:\files\old")) {
            if (!missing.RequiresOwnershipReview || missing.FreshGenerationRecoveryRequired || missing.CanReconnectCached)
                throw new Exception("Missing backup ownership review was not exposed.");
        }
        if (!File.ReadAllBytes(Path.Combine(missingDir, FreshGenerationIndexStore.Current)).AsSpan().SequenceEqual(missingBytes) ||
            File.Exists(Path.Combine(missingDir, FreshGenerationIndexStore.LegacyBackup)))
            throw new Exception("Missing backup hold changed files.");
    }
    private static void Refuse(Action action)
    {
        try { action(); } catch (IOException) { return; }
        throw new Exception("Unsafe fresh-generation planning was accepted.");
    }
}
