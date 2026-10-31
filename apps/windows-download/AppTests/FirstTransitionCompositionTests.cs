using LedgeTop.Files;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Generated ordinary files and fake provider start only. No Windows sync registration.
internal static class FirstTransitionCompositionTests
{
    internal static async Task Run()
    {
        await Scenario("success"); await Scenario("auth-failure"); await Scenario("configure-failure"); await Scenario("cleanup-failure-once");
#if DEBUG
        await Scenario("shutdown-queued");
#endif
    }
    private static async Task Scenario(string mode)
    {
        await using var fixture = new ConnectedExplorerSessionTests.Fixture { Alias = "employee" };
        OwnedExplorerRootSession? candidate = null; var disposeCalls = 0;
        var hooks = new SyntheticFirstTransitionHooks((profile, root, source, scope, manifest) => {
            candidate = OwnedExplorerRootSession.CandidateForTest(profile, root, source, scope, manifest,
                phase => { if (phase == "before-dispose" && ++disposeCalls == 1 && mode == "cleanup-failure-once") throw new IOException("synthetic cleanup failure"); },
                priorVerify: _ => true, priorDrain: _ => Task.CompletedTask);
            return candidate;
        }, (adapter, current) => {
            if (mode != "success") throw new IOException("synthetic configuration failure");
            adapter.SetSyntheticStartForTest(prepared => {
                Directory.CreateDirectory(prepared.RootPath);
                var profile = Path.Combine(prepared.ProfileDirectory, "profile.json"); var replacement = Path.Combine(prepared.ProfileDirectory, "fake-ready-profile.tmp");
                File.WriteAllBytes(replacement, File.ReadAllBytes(profile)); File.Move(replacement, profile, overwrite: true);
                current.MarkSyntheticFreshRunningForTest();
                var handles = ConnectedGenerationHandleLease.Open(prepared.ProfileDirectory, "manifest-" + prepared.Identity.ToString("N") + ".json", prepared.RootPath);
                var nativeScope = new ExplorerRootScope("pilot", "employee", fixture.StartedSources.Single().Origin.GetLeftPart(UriPartial.Authority), ConnectedExplorerSessionTests.Fixture.PersonA);
                var snapshot = new ConnectedGenerationSnapshot(prepared.Identity, prepared.ProfileDirectory, prepared.RootPath,
                    unchecked((long)handles.RootFileId), Guid.NewGuid(), prepared.ManifestDigest, nativeScope, prepared.ProfileRevision + 1);
                return Task.FromResult(new ConnectedGenerationHeldObservation(snapshot, handles));
            });
        });
        var session = fixture.Create(transition: hooks); await session.StartAsync();
        var before = File.ReadAllBytes(fixture.IndexPath); var source = fixture.StartedSources.Single();
        var scope = new ExplorerRootScope("pilot", "employee", source.Origin.GetLeftPart(UriPartial.Authority), ConnectedExplorerSessionTests.Fixture.PersonA);
        var manifest = new ExplorerRootManifest(scope, new Dictionary<string, PlaceholderIdentity>());
        var profileDir = Path.Combine(fixture.TestRoot, "prior-profile"); var priorRoot = Path.Combine(fixture.TestRoot, "prior-root");
        Directory.CreateDirectory(profileDir); Directory.CreateDirectory(priorRoot); File.WriteAllText(Path.Combine(profileDir, "profile.json"), "synthetic profile"); File.WriteAllText(Path.Combine(profileDir, "manifest.json"), "synthetic manifest");
        var sentinel = Path.Combine(priorRoot, "keep.txt"); File.WriteAllText(sentinel, "keep original");
        var prior = OwnedExplorerRootSession.CandidateForTest(profileDir, priorRoot, source, scope, manifest, priorVerify: _ => true, priorDrain: _ => Task.CompletedTask);
        prior.AttachSyntheticPriorLeaseForTest(new FileStream(Path.Combine(profileDir, "session.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None));
        using var initial = ConnectedGenerationHandleLease.Open(profileDir, "manifest.json", priorRoot);
        var snapshot = new ConnectedGenerationSnapshot(Guid.NewGuid(), profileDir, priorRoot, unchecked((long)initial.RootFileId), Guid.NewGuid(), manifest.Digest, scope, 1);
        prior.ConfigureSyntheticPriorForTest(() => new ConnectedGenerationHeldObservation(snapshot, ConnectedGenerationHandleLease.Open(profileDir, "manifest.json", priorRoot)), priorRoot);
        await session.InstallSyntheticPriorForTestAsync(prior);
        Require(session.CanStartFreshReadOnlyConnection, "running employee session with its retained index lease offers the transition");
#if DEBUG
        if (mode == "shutdown-queued") {
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var failureEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            session.SetTimingBarrierForTest(() => { entered.TrySetResult(); return release.Task; });
            session.SetFailureBarrierForTest(() => { failureEntered.TrySetResult(); return release.Task; });
            var pending = session.ObserveHydrationTimingForTestAsync(prior, HydrationTimingDiagnosticStoreTests.Sample);
            var failed = session.ObserveHydrationFailureForTestAsync(prior, new(HydrationStage.Download,HydrationFailureCategory.Transfer,TransferFailureReason.UnexpectedHttpStatus,503));
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await failureEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await session.DisposeAsync(); release.TrySetResult(); await pending.WaitAsync(TimeSpan.FromSeconds(10)); await failed.WaitAsync(TimeSpan.FromSeconds(10));
            Require(!File.Exists(Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, HydrationTimingDiagnosticStore.Leaf)), "queued callback is discarded on shutdown");
            Require(!File.Exists(Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, HydrationFailureDiagnosticStore.Leaf)), "queued failure is discarded on shutdown");
            return;
        }
        if (mode == "success") {
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            session.SetTimingBarrierForTest(() => { entered.TrySetResult(); return release.Task; });
            var pending = session.ObserveHydrationTimingForTestAsync(prior, HydrationTimingDiagnosticStoreTests.Sample);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            for (var i = 41; i <= 70; i++) _ = session.ObserveHydrationTimingForTestAsync(prior, HydrationTimingDiagnosticStoreTests.Sample.Replace("downloadMs=40", "downloadMs=" + i));
            release.TrySetResult(); await pending.WaitAsync(TimeSpan.FromSeconds(10));
            var timingPath = Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, HydrationTimingDiagnosticStore.Leaf);
            var bytesBeforeStale = File.ReadAllBytes(timingPath);
            using (var timing = System.Text.Json.JsonDocument.Parse(bytesBeforeStale))
                Require(timing.RootElement.GetProperty("values").GetArrayLength() == 17 && timing.RootElement.GetProperty("values")[5].GetInt64() == 70, "rapid samples coalesce to latest owned observation");
            await using var other = OwnedExplorerRootSession.CandidateForTest(profileDir, priorRoot, source, scope, manifest, priorVerify: _ => true, priorDrain: _ => Task.CompletedTask);
            await session.ObserveHydrationTimingForTestAsync(other, HydrationTimingDiagnosticStoreTests.Sample.Replace("downloadMs=40", "downloadMs=99"));
            Require(File.ReadAllBytes(timingPath).AsSpan().SequenceEqual(bytesBeforeStale), "callback from a noncurrent engine is ignored");
            var first = new HydrationFailureDiagnosticStore.Observation(HydrationStage.Download,HydrationFailureCategory.Transfer,TransferFailureReason.UnexpectedHttpStatus,503);
            var latest = first with { Stage=HydrationStage.AuthorizationBefore, Category=HydrationFailureCategory.LoginRequired, Reason=TransferFailureReason.Unknown, HttpStatus=null };
            var failureEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var failureRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            session.SetFailureBarrierForTest(() => { failureEntered.TrySetResult(); return failureRelease.Task; });
            var failurePending = session.ObserveHydrationFailureForTestAsync(prior,first);
            await failureEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            _ = session.ObserveHydrationFailureForTestAsync(prior,latest);
            _ = session.ObserveHydrationFailureForTestAsync(other,first);
            failureRelease.TrySetResult(); await failurePending.WaitAsync(TimeSpan.FromSeconds(10));
            var failurePath=Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!,HydrationFailureDiagnosticStore.Leaf);
            var failureBytes=File.ReadAllBytes(failurePath);
            using (var failure=System.Text.Json.JsonDocument.Parse(failureBytes)) Require(failure.RootElement.GetProperty("stage").GetString()=="AuthorizationBefore", "stale callback cannot displace current pending failure");
            await session.ObserveHydrationFailureForTestAsync(other,first);
            Require(File.ReadAllBytes(failurePath).AsSpan().SequenceEqual(failureBytes),"failure from noncurrent owner ignored");
        }
#endif
        if (mode == "auth-failure") fixture.AccessDenied = true;
        if (mode == "success") {
            await session.StartFreshReadOnlyConnectionAsync(CancellationToken.None);
            Require(session.FreshReadOnlyActive && session.State == ExplorerPreviewState.Running && session.RootPath != priorRoot && Directory.Exists(session.RootPath), "new synthetic current root becomes read-only active");
            var statusPath = Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, ConnectionStatusStore.Leaf);
            using (var status = System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(statusPath)))
                Require(status.RootElement.GetProperty("state").GetString() == "Running" && status.RootElement.GetProperty("freshReadOnly").GetBoolean() && status.RootElement.GetProperty("freshAction").GetString() == "Completed", "published fresh connection records completed action");
            Require(FreshGenerationIndexCodec.Decode(File.ReadAllBytes(fixture.IndexPath)).State.Phase == FreshGenerationPlan.Phase.Published, "published selector records transition");
            Require(File.ReadAllText(sentinel) == "keep original", "prior local bytes remain");
            await session.DisposeAsync();
            using (var status = System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(statusPath)))
                Require(status.RootElement.GetProperty("state").GetString() == "NotStarted", "published fresh connection records orderly stop");
        } else {
            try { await session.StartFreshReadOnlyConnectionAsync(CancellationToken.None); throw new Exception("Expected transition failure"); }
            catch (Exception error) when (error is IOException or AccessDeniedException) { }
            Require(File.ReadAllBytes(fixture.IndexPath).AsSpan().SequenceEqual(before) && File.ReadAllText(sentinel) == "keep original", "failed preparation preserves prior selector and root");
            Require(fixture.BackendDisposals == 0, "failed candidate cleanup does not dispose existing backend");
            if (mode == "auth-failure") {
                Require(candidate is null && disposeCalls == 0, "failed authentication cannot create candidate");
                using var status = System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, ConnectionStatusStore.Leaf)));
                Require(status.RootElement.GetProperty("state").GetString() == "Running" && status.RootElement.GetProperty("freshAction").GetString() == "Failed", "early failure is recorded while old provider remains running");
            }
            else if (mode == "cleanup-failure-once") {
                Require(candidate is not null && session.RequiresOwnershipReview && disposeCalls == 1, "failed cleanup retains review state");
                using var status = System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, ConnectionStatusStore.Leaf)));
                Require(status.RootElement.GetProperty("freshAction").GetString() == "NeedsReview", "uncertain cleanup records a review outcome while selector is owned");
            }
            else Require(candidate is not null && !session.RequiresOwnershipReview && disposeCalls == 1, "clean failure leaves existing session usable");
            fixture.AccessDenied = false;
            await session.DisposeAsync();
            if (mode == "cleanup-failure-once") Require(disposeCalls == 2, "quit retries retained candidate cleanup once");
        }
    }
    private static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
}
