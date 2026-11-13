using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

internal static class ConnectedExplorerSessionTests
{
    internal static async Task Run()
    {
        var count = 0;
        await SelectionAndFrozenReopen(); count++;
        await AvailabilityRetryDelegation(); count++;
#if DEBUG
        await SyntheticHeldProviderDrain(); count++;
        await SyntheticDeferredRestartReceipt(false, false); count++;
        await SyntheticDeferredRestartReceipt(true, false); count++;
        await SyntheticDeferredRestartReceipt(false, true); count++;
        foreach (var stage in new[] { "held-cleanup-observation", "held-cleanup-selector", "held-cleanup-session" }) { await SyntheticDeferredRestartReceipt(false, false, stage); count++; }
#endif
        await ActivityAcrossEngineAndConnection(); count++;
        await ForeignPersonAndOfflineRemoval(); count++;
        await OwnershipRefusals(); count++;
        await FailedStartRetainsCleanup(); count++;
        await CancelLogin(); count++;
        await CancelCapture(); count++;
        await LateLoginNeverActivates(); count++;
        await RuntimeRevalidation(); count++;
        await CancelEngineDefaultTokenRead(); count++;
        await DurableRemovalBeforeProfileCreation(); count++;
        await CachedReconnect(); count++;
        await UpdateIdentityBinding(); count++;
        await CaptureDiagnostics(); count++;
        await ExplicitEmptyRefresh(); count++;
        await ReadOnlyCatalogCheck(); count++;
        await EmployeeAdmission(); count++;
        await RecheckDiagnosticsAndRecovery(); count++;
        await TransientRecheckRecovery(); count++;
        await TransientResumeGateRecovery(); count++;
        await TransientRecoveryHolds(); count++;
        await TransientRecoveryTimerAndQuit(); count++;
        await RecoveryViewPublicationRaces(); count++;
        await LocalFailureDiagnosticIntegration(); count++;
        await SavedCapabilityObservationRaces(); count++;
        await FreshTransitionSessionRetention(); count++;
        await FreshTransitionRetainsDrainedPrior(false); count++;
        await FreshTransitionRetainsDrainedPrior(true); count++;
        await FreshTransitionRetainsDrainedPrior(true, true); count++;
        await FreshRestartPartialStop(); count++;
        await FreshProductTransitionGate(); count++;
#if DEBUG
        await EngineStatusQueueRaces();
#endif
        Console.WriteLine($"Connected Explorer coordinator: {count} isolated cases passed; fake sources/engines only, no browser, HTTP or native registration.");
    }

    internal static async Task ReadOnlyCatalogCheck()
    {
        foreach (var mode in new[] { "unchanged", "same-count-change", "reference-change", "person-change", "generation-change", "capture-failure", "catalog-429", "catalog-500", "catalog-503", "catalog-invalid", "snapshot-scope", "paused-race", "current-429", "current-network", "source-503", "current-401", "current-invalid", "source-invalid", "capture-before-invalid", "capture-after-invalid", "capture-session-invalid", "denied", "limit", "limit-path", "limit-page", "limit-size", "cancel" }) {
            await using var f = new Fixture(); var session = f.Create(); await session.StartAsync();
            Directory.CreateDirectory(Path.GetDirectoryName(f.LocalSentinel)!); File.WriteAllText(f.LocalSentinel, "local");
            var before = File.ReadAllBytes(f.IndexPath); var activations = f.NativeActivations;
            if (mode == "same-count-change") f.Version = "version-two";
            if (mode == "reference-change") f.Reference = "odqr1_different";
            if (mode == "person-change") f.AfterCapture = () => f.Person = Fixture.PersonB;
            if (mode == "generation-change") f.AfterCapture = f.ChangeVisibleManifest;
            if (mode == "capture-failure") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.MetadataRequest, TransferFailureReason.Network, null);
            if (mode == "limit") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.ValidateInventory, TransferFailureReason.InvalidMetadata, null, CatalogCaptureLimit.EntryCount);
            if (mode == "limit-path") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.ValidateInventory, TransferFailureReason.InvalidMetadata, null, CatalogCaptureLimit.PathOrDepth);
            if (mode == "limit-page") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.ValidateInventory, TransferFailureReason.InvalidMetadata, null, CatalogCaptureLimit.PageCount);
            if (mode == "limit-size") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.ValidateInventory, TransferFailureReason.InvalidMetadata, null, CatalogCaptureLimit.FileSize);
            if (mode == "catalog-503") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.MetadataRequest, TransferFailureReason.UnexpectedHttpStatus, 503);
            if (mode == "catalog-500") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.MetadataRequest, TransferFailureReason.UnexpectedHttpStatus, 500);
            if (mode == "catalog-invalid") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.ValidateInventory, TransferFailureReason.InvalidMetadata, null);
            if (mode == "capture-before-invalid") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.BeforeSession, TransferFailureReason.InvalidMetadata, null);
            if (mode == "capture-after-invalid") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.FolderListing, CatalogCaptureBoundary.AfterSession, TransferFailureReason.InvalidMetadata, null);
            if (mode == "capture-session-invalid") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.FinalSession, CatalogCaptureBoundary.ValidateInventory, TransferFailureReason.InvalidMetadata, null);
            if (mode == "snapshot-scope") f.WrongSnapshotScope = true;
            if (mode == "paused-race") f.AfterCapture = () => f.ForceEngineState(ExplorerPreviewState.Paused);
            if (mode == "catalog-429") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.MetadataRequest, TransferFailureReason.UnexpectedHttpStatus, 429);
            if (mode == "current-429") f.CurrentFailure = new TransferException("private", TransferFailureReason.UnexpectedHttpStatus, 429);
            if (mode == "current-network") f.CurrentFailure = new TransferException("private", TransferFailureReason.Network);
            if (mode == "current-invalid") f.CurrentFailure = new TransferException("private", TransferFailureReason.InvalidMetadata);
            if (mode == "source-invalid") f.SourceFailure = new TransferException("private", TransferFailureReason.InvalidMetadata);
            if (mode == "current-401") f.CurrentFailure = new TransferException("private", TransferFailureReason.UnexpectedHttpStatus, 401);
            if (mode == "source-503") f.SourceFailure = new TransferException("private", TransferFailureReason.UnexpectedHttpStatus, 503);
            if (mode == "denied") f.AccessDenied = true;
            if (mode == "cancel") {
                f.HoldCapture = true; using var c = new CancellationTokenSource();
                var pending = session.CheckCatalogChangesAsync(c.Token); await f.CaptureWaitEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                c.Cancel(); await Cancelled(pending);
            }
            else if (mode is "capture-failure" or "catalog-429" or "catalog-500" or "catalog-503" or "catalog-invalid" or "limit" or "limit-path" or "limit-page" or "limit-size") {
                try { await session.CheckCatalogChangesAsync(); throw new InvalidOperationException("Capture failure must propagate."); }
                catch (CatalogCaptureException) { }
                Check(session.State == ExplorerPreviewState.Running && session.Activity.Any(x => x.Contains("check was incomplete", StringComparison.Ordinal)), "incomplete check keeps provider running and reports incomplete");
            }
            else if (mode is "paused-race" or "snapshot-scope") {
                try { await session.CheckCatalogChangesAsync(); throw new InvalidOperationException("Interrupted observation must propagate."); }
                catch (IOException) { }
                Check(f.EnginePauses == 0 && session.Activity.Any(x => x == "The file check was interrupted; your connection was kept."), "interrupted observation reports its outcome without invoking failure pause");
            }
            else if (mode is "current-429" or "current-network" or "source-503") {
                try { await session.CheckCatalogChangesAsync(); throw new InvalidOperationException("Transient failure must propagate."); }
                catch (TransferException) { }
                Check(session.State == ExplorerPreviewState.Running && session.Activity.Any(x => x.Contains("check was incomplete", StringComparison.Ordinal)), "transient session failure keeps provider running");
            }
            else if (mode is "current-401" or "current-invalid" or "source-invalid" or "capture-before-invalid" or "capture-after-invalid" or "capture-session-invalid") {
                try { await session.CheckCatalogChangesAsync(); throw new InvalidOperationException("Unauthorized failure must propagate."); }
                catch (Exception e) when (e is TransferException or CatalogCaptureException) { }
                Check(session.State == ExplorerPreviewState.Failed && f.EnginePauses > 0, "unverifiable authority fails closed");
            }
            else if (mode is "person-change" or "generation-change" or "denied") {
                await Refuses(() => session.CheckCatalogChangesAsync());
                Check(session.State == ExplorerPreviewState.Failed && f.EnginePauses > 0, "authority or generation failure fails closed");
            }
            else {
                await session.CheckCatalogChangesAsync();
                Check(session.Activity.Any(x => x.Contains(mode == "unchanged" ? "observed no differences" : mode == "reference-change" ? "1 changed file references" : "1 changed files", StringComparison.Ordinal)), "check reports content and reference differences");
            }
            Check(File.ReadAllBytes(f.IndexPath).AsSpan().SequenceEqual(before) && File.ReadAllText(f.LocalSentinel) == "local" && f.NativeActivations == activations,
                "catalog check never changes selector, local bytes or native registration");
            if (mode is not ("unchanged" or "same-count-change" or "reference-change")) Check(!session.Activity.Any(x => x.StartsWith("File check observed", StringComparison.Ordinal)), "failed checks never report a result");
        }
    }

    internal static async Task ActivityAcrossEngineAndConnection()
    {
        await using var fixture = new Fixture { Alias = "employee" };
        var session = fixture.Create(); await session.StartAsync();
        fixture.AddEngineActivity("engine older");
        typeof(ConnectedExplorerSession).GetMethod("Add", System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.NonPublic)!.Invoke(session, ["connection newer"]);
        var lines = session.Activity;
        Check(lines.Contains("engine older") && lines.Contains("connection newer") &&
            Array.IndexOf(lines.ToArray(), "engine older") < Array.IndexOf(lines.ToArray(), "connection newer"),
            "newer connection error follows older engine events");
        for (var i = 0; i < 150; i++) fixture.AddEngineActivity("engine " + i);
        typeof(ConnectedExplorerSession).GetMethod("Add", System.Reflection.BindingFlags.Instance |
            System.Reflection.BindingFlags.NonPublic)!.Invoke(session, ["latest connection error"]);
        lines = session.Activity;
        Check(lines.Count == 100 && lines[^1] == "latest connection error" && !lines.Contains("engine 0"),
            "bounded merge retains latest connection event after engine activity floods");
        await session.DisposeAsync();
        var first = new OrderedActivity(); var second = new OrderedActivity();
        await Task.WhenAll(Enumerable.Range(0, 4).Select(worker => Task.Run(() => {
            for (var i = 0; i < 150; i++) (worker % 2 == 0 ? first : second).Add($"{worker}:{i}");
        })));
        var merged = OrderedActivity.Merge(first.Snapshot(), second.Snapshot());
        Check(merged.Count == 100 && first.Snapshot().Count == 100 && second.Snapshot().Count == 100 &&
            merged.Zip(merged.Skip(1), (a, b) => a.Sequence < b.Sequence).All(value => value),
            "concurrent sources stay bounded and produce strictly ordered events");
    }

#if DEBUG
    private sealed class SyntheticRestartAuthority : IProviderWorkAuthority
    {
        internal bool Closed;
        public void VerifyHeld() { if (Closed) throw new IOException("Synthetic selector closed."); }
        public void Dispose() { Closed = true; }
    }
    private static async Task SyntheticDeferredRestartReceipt(bool failActivation, bool loseProof, string? cleanupFailureStage = null)
    {
        await using var fixture = new Fixture { Alias = "employee" };
        var connected = fixture.Create(); await connected.StartAsync(); var source = fixture.StartedSources.Single();
        var scope = new ExplorerRootScope("pilot", "employee", source.Origin.GetLeftPart(UriPartial.Authority), Fixture.PersonA);
        var manifest = new ExplorerRootManifest(scope, new Dictionary<string, PlaceholderIdentity>());
        var profile = Path.Combine(fixture.TestRoot, "deferred-profile"); var root = Path.Combine(fixture.TestRoot, "deferred-root"); var cache = Path.Combine(fixture.TestRoot, "deferred-cache");
        Directory.CreateDirectory(profile); Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        File.WriteAllText(Path.Combine(profile, "profile.json"), "generated profile"); File.WriteAllText(Path.Combine(profile, "manifest.json"), "generated manifest");
        string? failStage = cleanupFailureStage;
        var session = OwnedExplorerRootSession.CandidateForTest(profile, root, source, scope, manifest,
            hook: stage => { if (stage == failStage) { failStage = null; throw new IOException("Synthetic pre-cleanup interruption."); } },
            priorVerify: _ => true, priorDrain: _ => Task.CompletedTask);
        var lockPath = Path.Combine(profile, "session.lock"); var stream = new FileStream(lockPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        var handles = ConnectedGenerationHandleLease.Open(profile, "manifest.json", root);
        var snapshot = new ConnectedGenerationSnapshot(Guid.NewGuid(), profile, root, unchecked((long)handles.RootFileId), Guid.NewGuid(), manifest.Digest, scope, 2);
        session.AttachSyntheticRestartForTest(stream, new ConnectedGenerationHeldObservation(snapshot, handles)); session.MarkSyntheticRestartRunningForTest();
        var identity = new PlaceholderIdentity("pilot", "employee", scope.Origin, Fixture.PersonA, "odqr1_" + new string('a', 64), "ondf1_" + new string('c', 64), new string('b', 64), "sample.txt", 0, "\"etag\"", new string('d', 64));
        var provider = new NativePlaceholderProvider(new SyntheticRegistration(root), cache, source, "pilot", Fixture.PersonA, new Dictionary<string, PlaceholderIdentity> { ["sample.txt"] = identity });
        provider.ConfigureFreshAdmission();
        typeof(NativePlaceholderProvider).GetField("catalogReady", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(provider, true);
        provider.SyntheticFreshScannerStartForTest = () => { if (failActivation) throw new IOException("Synthetic scanner start failure."); }; session.AttachSyntheticAvailabilityProviderForTest(provider);
        var a = new SyntheticRestartAuthority(); IProviderWorkAuthority? selector = a;
        try { session.ActivateHeldRestartProvider(ref selector, _ => false); throw new Exception("Expected ownership refusal."); } catch (IOException) { }
        Check(ReferenceEquals(selector, a) && !a.Closed, "failed pre-transfer proof retains caller authority");
        if (failActivation) {
            try { session.ActivateHeldRestartProvider(ref selector, _ => true); throw new Exception("Expected scanner failure."); } catch (IOException) { }
            Check(selector is null && !a.Closed, "failed activation retains selector in session");
            await session.StopHeldRestartDeferredProviderAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Check(a.Closed, "failed activation releases selector only after provider drain");
            using (new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            await session.DisposeAsync(); await connected.DisposeAsync(); return;
        }
        bool proofValid = true;
        session.ActivateHeldRestartProvider(ref selector, _ => proofValid);
        Check(selector is null && !a.Closed, "activation transfers selector into held provider receipt");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var work = provider.RunSyntheticAvailabilityForTest("sample.txt", async _ => { entered.TrySetResult(); await release.Task; });
        var drainEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        provider.SyntheticAvailabilityDrainEnteredForTest = pending => drainEntered.TrySetResult(pending.Contains(work));
        Task? stopping = null;
        try {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (loseProof) proofValid = false;
            stopping = session.StopHeldRestartDeferredProviderAsync();
            Check(await drainEntered.Task.WaitAsync(TimeSpan.FromSeconds(5)), "deferred stop captures in-flight work");
            Check(!stopping.IsCompleted && !a.Closed, "deferred stop retains selector until worker drain");
            try { using var unexpected = provider.FreshAdmissionForTest.Enter(); throw new Exception("Stop left provider admission open."); } catch (IOException) { }
            try { using var unexpected = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("Session lease released before drain."); } catch (IOException) { }
            release.TrySetResult(); await work.WaitAsync(TimeSpan.FromSeconds(5));
            if (loseProof) {
                try { await stopping.WaitAsync(TimeSpan.FromSeconds(5)); throw new Exception("Lost proof was accepted for reclaim."); } catch (IOException) { }
                Check(!a.Closed, "lost proof retains selector after successful drain");
                try { using var unexpected = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("Lost-proof session lease released."); } catch (IOException) { }
                proofValid = true; stopping = session.StopHeldRestartDeferredProviderAsync();
            }
            if (cleanupFailureStage is not null) {
                try { await stopping.WaitAsync(TimeSpan.FromSeconds(5)); throw new Exception("Cleanup interruption was not observed."); } catch (IOException) { }
                try { await session.StopHeldRestartProviderAsync(_ => true); throw new Exception("Legacy stop bypassed held cleanup."); } catch (IOException) { }
                try { session.ReleaseReadOnlyRestartObservation(); throw new Exception("Read-only release bypassed held cleanup."); } catch (IOException) { }
                try { using var unexpected = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("Interrupted cleanup released session lease."); } catch (IOException) { }
                stopping = session.StopHeldRestartDeferredProviderAsync();
            }
            await stopping.WaitAsync(TimeSpan.FromSeconds(5));
            Check(a.Closed, "selector released after provider drain and receipt reclaim");
            using (new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        } finally {
            release.TrySetResult(); try { await work.WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
            if (stopping is not null) await stopping.WaitAsync(TimeSpan.FromSeconds(5));
            await session.DisposeAsync(); await connected.DisposeAsync();
        }
    }
    private static async Task SyntheticHeldProviderDrain()
    {
        await using var fixture = new Fixture { Alias = "employee" };
        var connected = fixture.Create(); await connected.StartAsync();
        var source = fixture.StartedSources.Single();
        var scope = new ExplorerRootScope("pilot", "employee", source.Origin.GetLeftPart(UriPartial.Authority), Fixture.PersonA);
        var manifest = new ExplorerRootManifest(scope, new Dictionary<string, PlaceholderIdentity>());
        foreach (var restartHeld in new[] { false, true }) {
            var prefix = restartHeld ? "provider-restart" : "provider-current";
            var profile = Path.Combine(fixture.TestRoot, prefix + "-profile");
            var root = Path.Combine(fixture.TestRoot, prefix + "-root");
            var cache = Path.Combine(fixture.TestRoot, prefix + "-cache");
            Directory.CreateDirectory(profile); Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
            File.WriteAllText(Path.Combine(profile, "profile.json"), "generated profile");
            File.WriteAllText(Path.Combine(profile, "manifest.json"), "generated manifest");
            var session = OwnedExplorerRootSession.CandidateForTest(profile, root, source, scope, manifest,
                priorVerify: _ => true, priorDrain: _ => Task.CompletedTask);
            var lockPath = Path.Combine(profile, "session.lock");
            var stream = new FileStream(lockPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            if (restartHeld) {
                var handles = ConnectedGenerationHandleLease.Open(profile, "manifest.json", root);
                var snapshot = new ConnectedGenerationSnapshot(Guid.NewGuid(), profile, root, unchecked((long)handles.RootFileId), Guid.NewGuid(), manifest.Digest, scope, 2);
                session.AttachSyntheticRestartForTest(stream, new ConnectedGenerationHeldObservation(snapshot, handles));
                session.MarkSyntheticRestartRunningForTest();
            } else {
                session.AttachSyntheticPriorLeaseForTest(stream);
                session.ConfigureSyntheticPriorForTest(() => throw new InvalidOperationException("No observation expected."), root);
            }
            var identity = new PlaceholderIdentity("pilot", "employee", scope.Origin, Fixture.PersonA,
                "odqr1_" + new string('a', 64), "ondf1_" + new string('c', 64), new string('b', 64), "sample.txt", 0, "\"etag\"", new string('d', 64));
            var provider = new NativePlaceholderProvider(new SyntheticRegistration(root), cache, source, "pilot", Fixture.PersonA,
                new Dictionary<string, PlaceholderIdentity> { ["sample.txt"] = identity });
            session.AttachSyntheticAvailabilityProviderForTest(provider);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var work = provider.RunSyntheticAvailabilityForTest("sample.txt", async _ => { entered.TrySetResult(); await release.Task; });
            var drainEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            provider.SyntheticAvailabilityDrainEnteredForTest = pending => drainEntered.TrySetResult(pending.Contains(work));
            Task? stopping = null;
            try {
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                if (restartHeld) {
                    try { await session.StopHeldRestartProviderAsync(_ => false); throw new Exception("Missing selector proof accepted."); }
                    catch (IOException) { }
                    Check(!work.IsCompleted, "selector refusal does not discard in-flight owned work");
                }
                stopping = restartHeld ? session.StopHeldRestartProviderAsync(_ => true) : session.DisposeAsync().AsTask();
                Check(await drainEntered.Task.WaitAsync(TimeSpan.FromSeconds(5)), "provider drain captured the actual in-flight availability operation");
                Check(!stopping.IsCompleted, "held provider stop joins in-flight availability work");
                try { using var unexpected = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("Session lease released before provider drain."); }
                catch (IOException) { }
                release.TrySetResult();
                await work.WaitAsync(TimeSpan.FromSeconds(5)); await stopping.WaitAsync(TimeSpan.FromSeconds(5));
                using (new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
                Check(Directory.Exists(root), "held provider drain preserves synthetic root");
            } finally {
                release.TrySetResult();
                try { await work.WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
                if (stopping is null) stopping = restartHeld ? session.StopHeldRestartProviderAsync(_ => true) : session.DisposeAsync().AsTask();
                await stopping.WaitAsync(TimeSpan.FromSeconds(5));
                if (restartHeld) await session.DisposeAsync();
            }
        }
        await connected.DisposeAsync();
    }
#endif

    private static async Task AvailabilityRetryDelegation()
    {
        await using var fixture = new Fixture { Alias = "employee" };
        var session = fixture.Create();
        Check(!session.CanRetryAvailability, "retry unavailable before connection");
        await session.StartAsync();
        var signIns = fixture.SignIns; var requests = fixture.Requests;
        Check(session.CanRetryAvailability, "running owner exposes availability retry");
        await session.RetryAvailabilityAsync();
        Check(fixture.EngineRetries == 1 && fixture.SignIns == signIns && fixture.Requests == requests, "retry delegates without sign-in or source requests");
        await session.PauseAsync();
        Check(!session.CanRetryAvailability, "paused owner hides retry");
        try { await session.RetryAvailabilityAsync(); throw new Exception("Paused retry unexpectedly succeeded."); }
        catch (InvalidOperationException) { }
        Check(fixture.EngineRetries == 1, "paused retry does not reach provider");
        await session.DisposeAsync();
    }

#if DEBUG
    private static async Task EngineStatusQueueRaces()
    {
        await using (var fixture = new Fixture { Alias = "employee" }) {
            var session = fixture.Create(); await session.StartAsync();
            var path = Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, ConnectionStatusStore.Leaf);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            session.SetEngineStatusBarrierForTest(() => { entered.TrySetResult(); return release.Task; });
            fixture.ForceEngineState(ExplorerPreviewState.Paused); await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            fixture.ForceEngineState(ExplorerPreviewState.Running); fixture.ForceEngineState(ExplorerPreviewState.Paused);
            release.TrySetResult(); await session.WaitForEngineStatusForTestAsync().WaitAsync(TimeSpan.FromSeconds(10));
            using (var status = System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(path))) Check(status.RootElement.GetProperty("state").GetString() == "Paused", "rapid state changes retain latest observation");
            var before = File.ReadAllBytes(path);
            entered = new(TaskCreationOptions.RunContinuationsAsynchronously); release = new(TaskCreationOptions.RunContinuationsAsynchronously);
            session.SetEngineStatusBarrierForTest(() => { entered.TrySetResult(); return release.Task; });
            fixture.ForceEngineState(ExplorerPreviewState.Running); await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await session.ClearFakeEngineForStatusTestAsync(); release.TrySetResult(); await session.WaitForEngineStatusForTestAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Check(File.ReadAllBytes(path).AsSpan().SequenceEqual(before), "replaced engine's queued state is discarded");
            await session.DisposeAsync();
        }
        await using (var fixture = new Fixture { Alias = "employee" }) {
            var session = fixture.Create(); await session.StartAsync();
            var path = Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, ConnectionStatusStore.Leaf);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            session.SetEngineStatusBarrierForTest(() => { entered.TrySetResult(); return release.Task; });
            fixture.ForceEngineState(ExplorerPreviewState.Paused); await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await session.DisposeAsync(); var stopped = File.ReadAllBytes(path); release.TrySetResult();
            await session.WaitForEngineStatusForTestAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Check(File.ReadAllBytes(path).AsSpan().SequenceEqual(stopped), "shutdown discards queued stale state");
        }
    }
#endif

    private static async Task FreshProductTransitionGate()
    {
        await using var fixture = new Fixture { Alias = "employee" };
        var session = fixture.Create(); await session.StartAsync();
        Check(!session.CanStartFreshReadOnlyConnection, "unqualified session does not offer a fresh connection");
        var statusPath = Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, ConnectionStatusStore.Leaf);
        Check(System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(statusPath)).RootElement.GetProperty("state").GetString() == "Running", "running owned session records status");
#if DEBUG
        fixture.ForceEngineState(ExplorerPreviewState.Paused); await session.WaitForEngineStatusForTestAsync();
        using (var pausedStatus = System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(statusPath)))
            Check(pausedStatus.RootElement.GetProperty("schemaVersion").GetInt32() == 2 && pausedStatus.RootElement.GetProperty("state").GetString() == "Paused", "provider pause persists current status in compatible schema");
        fixture.ForceEngineState(ExplorerPreviewState.Running); await session.WaitForEngineStatusForTestAsync();
        using (var resumedStatus = System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(statusPath)))
            Check(resumedStatus.RootElement.GetProperty("state").GetString() == "Running", "provider resume persists current status");
#endif
        var bytes = File.ReadAllBytes(fixture.IndexPath); var requests = fixture.Requests; var captures = fixture.Captures;
        try { await session.StartFreshReadOnlyConnectionAsync(CancellationToken.None); throw new Exception("Unqualified transition was accepted."); }
        catch (IOException) { }
        Check(session.State == ExplorerPreviewState.Running && fixture.Requests == requests && fixture.Captures == captures &&
            File.ReadAllBytes(fixture.IndexPath).AsSpan().SequenceEqual(bytes), "unqualified first transition left the running session and selector unchanged");
        await session.DisposeAsync();
        Check(System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(statusPath)).RootElement.GetProperty("state").GetString() == "NotStarted", "orderly stop records final status");
    }

    private static async Task FreshRestartPartialStop()
    {
        await using var fixture = new Fixture { Alias = "employee" };
        var session = fixture.Create(); await session.StartAsync(); var source = fixture.StartedSources.Single();
        var scope = new FreshGenerationPlan.Scope("pilot", "employee", source.Origin.GetLeftPart(UriPartial.Authority), Fixture.PersonA);
        var nativeScope = new ExplorerRootScope(scope.Channel, scope.Source, scope.Origin, scope.Principal);
        var manifest = new ExplorerRootManifest(nativeScope, new Dictionary<string, PlaceholderIdentity>());
        var allowPrior = false;
        (OwnedExplorerRootSession Session, RestartGenerationEvidence Evidence, string Lock) Prepare(string name, Func<bool> verify)
        {
            var dir = Path.Combine(fixture.TestRoot, name + "-profile"); var root = Path.Combine(fixture.TestRoot, name + "-root");
            Directory.CreateDirectory(dir); Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(dir, "profile.json"), "generated profile"); File.WriteAllText(Path.Combine(dir, "manifest.json"), "generated manifest");
            var owned = OwnedExplorerRootSession.CandidateForTest(dir, root, source, nativeScope, manifest,
                priorVerify: _ => verify(), priorDrain: _ => Task.CompletedTask);
            var lockPath = Path.Combine(dir, "session.lock"); var stream = new FileStream(lockPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            var handles = ConnectedGenerationHandleLease.Open(dir, "manifest.json", root);
            var snapshot = new ConnectedGenerationSnapshot(Guid.NewGuid(), dir, root, unchecked((long)handles.RootFileId), Guid.NewGuid(), manifest.Digest, nativeScope, 2);
            var evidence = new RestartGenerationEvidence(snapshot, handles.ProfileDirectoryVolume, handles.ProfileDirectoryFileId,
                handles.ProfileVolume, handles.ProfileFileId, handles.RootVolume, handles.RootFileId);
            owned.AttachSyntheticRestartForTest(stream, new ConnectedGenerationHeldObservation(snapshot, handles));
            return (owned, evidence, lockPath);
        }
        var readonlyOld = Prepare("readonly-old", () => true); var readonlyNew = Prepare("readonly-new", () => true);
        readonlyOld.Session.ReleaseReadOnlyRestartObservation(); readonlyNew.Session.ReleaseReadOnlyRestartObservation();
        foreach (var path in new[] { readonlyOld.Lock, readonlyNew.Lock }) using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        await readonlyOld.Session.DisposeAsync(); await readonlyNew.Session.DisposeAsync();
        Check(Directory.Exists(readonlyOld.Evidence.Snapshot.RootPath) && Directory.Exists(readonlyNew.Evidence.Snapshot.RootPath),
            "read-only installer observation releases both exact handles without removing roots");
        var prior = Prepare("stop-old", () => allowPrior); var current = Prepare("stop-new", () => true);
        var p = prior.Evidence; var c = current.Evidence;
        var old = new FreshGenerationPlan.Generation(p.Snapshot.Identity, scope, p.Snapshot.ProfileDirectory, p.Snapshot.RootPath, p.Snapshot.ManifestDigest,
            p.ProfileDirectoryVolume, p.ProfileDirectoryFileId, p.Snapshot.ProfileRevision, p.ProfileDocumentVolume, p.ProfileDocumentFileId,
            p.RootVolume, p.RootFileId, p.Snapshot.NamespaceClsid);
        var next = new FreshGenerationPlan.Generation(c.Snapshot.Identity, scope, c.Snapshot.ProfileDirectory, c.Snapshot.RootPath, c.Snapshot.ManifestDigest,
            c.ProfileDirectoryVolume, c.ProfileDirectoryFileId, 1, c.ProfileDocumentVolume, c.ProfileDocumentFileId);
        var readyRoot = new FreshGenerationPlan.RootEvidence(c.RootVolume, c.RootFileId, c.Snapshot.NamespaceClsid, c.Snapshot.ProfileRevision,
            c.ProfileDocumentVolume, c.ProfileDocumentFileId);
        var prepared = FreshGenerationPlan.Prepare(new(old, null, FreshGenerationPlan.Phase.OldActive), next, scope, true, true);
        var ready = FreshGenerationPlan.Ready(FreshGenerationPlan.Drained(prepared, true), scope, next.Id, next.ManifestDigest, next.RootPath, readyRoot, true);
        var selector = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, "synthetic", "pilot", "employee", new string('a', 64),
            scope.Principal, new string('b', 64), 4, FreshGenerationPlan.Publish(ready, true), next.Id);
        var selectorAuthorized = false;
        var restart = FreshGenerationColdRestart.CreateSyntheticHeldForTest(prior.Session, current.Session, selector, () => selectorAuthorized);
        try { await restart.StopHeldAsync(); throw new Exception("Missing selector proof ignored."); } catch (IOException) { }
        foreach (var path in new[] { prior.Lock, current.Lock }) {
            try { using var unexpected = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("A lock was released without selector proof."); }
            catch (IOException) { }
        }
        selectorAuthorized = true;
        try { await restart.StopHeldAsync(); throw new Exception("Prior verification failure ignored."); } catch (IOException) { }
        using (new FileStream(current.Lock, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        try { using var unexpected = new FileStream(prior.Lock, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("Prior lock released after failure."); }
        catch (IOException) { }
        allowPrior = true; await restart.StopHeldAsync();
        using (new FileStream(prior.Lock, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        await prior.Session.DisposeAsync(); await current.Session.DisposeAsync();
        Check(Directory.Exists(p.Snapshot.RootPath) && Directory.Exists(c.Snapshot.RootPath), "synthetic stop retains both roots");
        foreach (var uncertainCurrent in new[] { false, true }) {
            var partial = Prepare("partial-" + Guid.NewGuid().ToString("N"), () => true); var e = partial.Evidence;
            var partialOld = old with { Id = e.Snapshot.Identity, ProfileDirectory = e.Snapshot.ProfileDirectory, RootPath = e.Snapshot.RootPath,
                ProfileDirectoryVolume = e.ProfileDirectoryVolume, ProfileDirectoryFileId = e.ProfileDirectoryFileId,
                ProfileDocumentVolume = e.ProfileDocumentVolume, ProfileDocumentFileId = e.ProfileDocumentFileId,
                RootVolume = e.RootVolume, RootFileId = e.RootFileId, NamespaceClsid = e.Snapshot.NamespaceClsid };
            var partialSelector = selector with { State = selector.State with { Old = partialOld } };
            var dummy = OwnedExplorerRootSession.CandidateForTest(Path.Combine(fixture.TestRoot, Guid.NewGuid().ToString("N")),
                Path.Combine(fixture.TestRoot, Guid.NewGuid().ToString("N")), source, nativeScope, manifest,
                priorVerify: _ => true, priorDrain: _ => Task.CompletedTask);
            var partialRestart = FreshGenerationColdRestart.CreateSyntheticPartialForTest(partial.Session, dummy, partialSelector, () => true, uncertainCurrent);
            if (uncertainCurrent) {
                try { await partialRestart.StopHeldAsync(); throw new Exception("Unknown candidate outcome was accepted."); } catch (IOException) { }
                try { await partialRestart.StopHeldAsync(); throw new Exception("Unknown candidate outcome was retried as complete."); } catch (IOException) { }
            } else await partialRestart.StopHeldAsync();
            using (new FileStream(partial.Lock, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            await partial.Session.DisposeAsync(); await dummy.DisposeAsync();
        }
        var activePriorAllowed = true;
        var activePrior = Prepare("active-old", () => activePriorAllowed); var activeCurrent = Prepare("active-new", () => true);
        var ap = activePrior.Evidence; var ac = activeCurrent.Evidence;
        var activeOld = old with { Id = ap.Snapshot.Identity, ProfileDirectory = ap.Snapshot.ProfileDirectory, RootPath = ap.Snapshot.RootPath,
            ProfileDirectoryVolume = ap.ProfileDirectoryVolume, ProfileDirectoryFileId = ap.ProfileDirectoryFileId,
            ProfileDocumentVolume = ap.ProfileDocumentVolume, ProfileDocumentFileId = ap.ProfileDocumentFileId,
            RootVolume = ap.RootVolume, RootFileId = ap.RootFileId, NamespaceClsid = ap.Snapshot.NamespaceClsid };
        var activeNext = next with { Id = ac.Snapshot.Identity, ProfileDirectory = ac.Snapshot.ProfileDirectory, RootPath = ac.Snapshot.RootPath,
            ProfileDirectoryVolume = ac.ProfileDirectoryVolume, ProfileDirectoryFileId = ac.ProfileDirectoryFileId,
            ProfileDocumentVolume = ac.ProfileDocumentVolume, ProfileDocumentFileId = ac.ProfileDocumentFileId };
        var activeRoot = new FreshGenerationPlan.RootEvidence(ac.RootVolume, ac.RootFileId, ac.Snapshot.NamespaceClsid, ac.Snapshot.ProfileRevision,
            ac.ProfileDocumentVolume, ac.ProfileDocumentFileId);
        var activePrepared = FreshGenerationPlan.Prepare(new(activeOld, null, FreshGenerationPlan.Phase.OldActive), activeNext, scope, true, true);
        var activeReady = FreshGenerationPlan.Ready(FreshGenerationPlan.Drained(activePrepared, true), scope, activeNext.Id, activeNext.ManifestDigest, activeNext.RootPath, activeRoot, true);
        var activeBase = Path.Combine(fixture.TestRoot, "active-state"); var activeDir = Path.Combine(activeBase, "connected-explorer-pilot-employee"); Directory.CreateDirectory(activeDir);
        var backup = Encoding.UTF8.GetBytes("generated backup");
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var activeSelector = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, identity.User!.Value, "pilot", "employee",
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(scope.Origin))), scope.Principal,
            Convert.ToHexStringLower(SHA256.HashData(backup)), 4, FreshGenerationPlan.Publish(activeReady, true), activeNext.Id);
        var selectorBytes = FreshGenerationIndexCodec.Encode(activeSelector);
        File.WriteAllBytes(Path.Combine(activeDir, "current.json"), selectorBytes);
        File.WriteAllBytes(Path.Combine(activeDir, FreshGenerationIndexStore.LegacyBackup), backup);
        using (File.Create(Path.Combine(activeDir, "index.lock"))) { }
        var activeSelectorAllowed = true;
        var activeRestart = FreshGenerationColdRestart.CreateSyntheticHeldForTest(activePrior.Session, activeCurrent.Session, activeSelector, () => activeSelectorAllowed);
        activeCurrent.Session.MarkSyntheticRestartRunningForTest();
        await using (var activeSession = new ConnectedExplorerSession(() => throw new Exception("Backend must not be constructed."),
            "pilot", "employee", new Uri(scope.Origin), activeBase, activeOld.RootPath)) {
            var notice="An availability or cache-cleanup step failed. Retrying availability actions is not available for this connection yet. Leave your files in place and contact LedgeTop support.";
            activeCurrent.Session.OnProviderActivity("Could not change local availability. Support code: availability/Inspect/LocalIO",null);
            Check(!activeSession.Activity.Contains(notice),"untyped text cannot manufacture a fresh notice");
            var cacheDir=Path.Combine(fixture.TestRoot,"synthetic-provider-cache");Directory.CreateDirectory(cacheDir);
            await using(var provider=new NativePlaceholderProvider(new SyntheticRegistration(activeNext.RootPath),cacheDir,source,"pilot",scope.Principal,new Dictionary<string,PlaceholderIdentity>())) {
                provider.AvailabilityFailureObserved += activeCurrent.Session.OnProviderAvailabilityFailure;
                var worker=new BoundedAvailabilityWorkers(["synthetic"],_=>throw LocalAvailabilityException.FromException(LocalAvailabilityStage.CacheReclamation,new IOException("synthetic cache cleanup failure")),(_,_,_)=>Task.CompletedTask,provider.ReportAvailabilityFailure);
                try {Check(worker.Observe("synthetic",new(AvailabilityIntent.Free,true)),"synthetic scanner schedules worker");await worker.WhenJoinedAsync("synthetic").WaitAsync(TimeSpan.FromSeconds(5));}
                finally {await worker.StopAndDrainAsync(()=>Task.CompletedTask,()=>Task.CompletedTask);}
            }
            Check(!activeSession.Activity.Contains(notice),"early failure is not presented before publication");
            await activeSession.PublishSyntheticColdReadOnlyProviderForTestAsync(activeRestart);
            Check(activeSession.Activity.Count(line=>line==notice)==1,"early typed cache cleanup failure survives fresh publication");
            Check(activeSession.FreshReadOnlyActive && !activeSession.RequiresOwnershipReview && activeSession.RootPath == activeNext.RootPath && activeSession.State == ExplorerPreviewState.Running,
                "verified generated current provider is published while previous root is retained");
            activePrior.Session.OnProviderAvailabilityFailure(LocalAvailabilityException.FromException(LocalAvailabilityStage.Inspect,new IOException("synthetic")));
            Check(activeSession.Activity.Count(line=>line==notice)==1,"old generation failure does not duplicate fresh notice");
            activeCurrent.Session.OnProviderAvailabilityFailure(LocalAvailabilityException.FromException(LocalAvailabilityStage.Inspect,new IOException("synthetic")));
            Check(activeSession.Activity.Count(line=>line==notice)==1,"fresh typed availability failure presents one accurate retry message");
            try { await activeSession.RemoveAsync(); throw new Exception("Read-only active session allowed removal."); } catch (IOException) { }
            try { await activeSession.GetUpdateBindingAsync(); throw new Exception("Read-only active session allowed update."); } catch (IOException) { }
            Check(activeSession.FreshReadOnlyActive && activeSession.State == ExplorerPreviewState.Running,
                "denied app actions do not pause or change the active retained provider");
            activeSelectorAllowed = false;
            try { await activeSession.StopColdFreshRestartAsync(); throw new Exception("Missing selector proof was accepted."); } catch (IOException) { }
            Check(!activeSession.FreshReadOnlyActive && activeSession.RequiresOwnershipReview && activeSession.State == ExplorerPreviewState.Failed,
                "failed selector proof clears active availability and retains review state");
            activeSelectorAllowed = true;
            activePriorAllowed = false;
            try { await activeSession.StopColdFreshRestartAsync(); throw new Exception("Partial stop was accepted."); } catch (IOException) { }
            Check(!activeSession.FreshReadOnlyActive && activeSession.RequiresOwnershipReview && activeSession.State == ExplorerPreviewState.Failed,
                "partial stop no longer reports the provider as available");
            using (new FileStream(activeCurrent.Lock, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            try { using var unexpected = new FileStream(activePrior.Lock, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("Prior lock was released on failed stop."); }
            catch (IOException) { }
            activePriorAllowed = true; // DisposeAsync must be able to retry even though availability is cleared.
        }
        Check(Directory.Exists(activeOld.RootPath) && Directory.Exists(activeNext.RootPath) &&
            File.ReadAllBytes(Path.Combine(activeDir, "current.json")).AsSpan().SequenceEqual(selectorBytes), "active session quit preserved roots and selector");
    }

    private static async Task FreshTransitionRetainsDrainedPrior(bool afterFakeStart, bool publish = false)
    {
        await using var fixture = new Fixture { Alias = "employee" };
        var session = fixture.Create(); await session.StartAsync();
        var bytes = File.ReadAllBytes(fixture.IndexPath); var json = JsonNode.Parse(bytes) ?? throw new IOException();
        string Field(string name) => json[name]?.GetValue<string>() ?? throw new IOException(name);
        var source = fixture.StartedSources.Single();
        var scope = new FreshGenerationPlan.Scope("pilot", "employee", source.Origin.GetLeftPart(UriPartial.Authority), Field("PrincipalId"));
        var nativeScope = new ExplorerRootScope(scope.Channel, scope.Source, scope.Origin, scope.Principal);
        var manifest = new ExplorerRootManifest(nativeScope, new Dictionary<string, PlaceholderIdentity>());
        var profile = Path.Combine(fixture.TestRoot, "generated-prior-profile"); var root = Path.Combine(fixture.TestRoot, "generated-prior-root");
        Directory.CreateDirectory(profile); Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(profile, "profile.json"), "generated profile");
        File.WriteAllText(Path.Combine(profile, "manifest.json"), "generated manifest");
        var prior = OwnedExplorerRootSession.CandidateForTest(profile, root, source, nativeScope, manifest,
            priorVerify: _ => true, priorDrain: _ => Task.CompletedTask);
        var lockPath = Path.Combine(profile, "session.lock");
        prior.AttachSyntheticPriorLeaseForTest(new FileStream(lockPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None));
        var handles = ConnectedGenerationHandleLease.Open(profile, "manifest.json", root);
        var snapshot = new ConnectedGenerationSnapshot(Guid.NewGuid(), profile, root, 123, Guid.NewGuid(), manifest.Digest, nativeScope, 1);
        var old = new FreshGenerationPlan.Generation(snapshot.Identity, scope, profile, root, snapshot.ManifestDigest, handles.ProfileDirectoryVolume, handles.ProfileDirectoryFileId, 1, handles.ProfileVolume, handles.ProfileFileId, handles.RootVolume, handles.RootFileId, snapshot.NamespaceClsid);
        var binding = new FreshGenerationIndexStore.LegacyBinding(json["Revision"]!.GetValue<long>(), Field("Sid"), "pilot", "employee", Field("OriginSha256"), scope.Principal, old);
        var candidate = OwnedExplorerRootSession.CandidateForTest(Path.Combine(fixture.TestRoot, "generated-new-profile"), Path.Combine(fixture.TestRoot, "generated-new-root"), source, nativeScope, manifest);
        var checks = 0; var wrongPrincipal = false;
        var adapter = FreshGenerationOwnedAdapter.CreateForTest(prior, candidate, old, _ => {
            if (++checks == (afterFakeStart ? 3 : 2) && !publish) throw new IOException("Injected authentication failure."); return Task.FromResult(wrongPrincipal ? scope with { Principal = "wrong" } : scope);
        }, (_, _) => true, _ => false);
        adapter.SetSyntheticPriorForTest(fixture.CurrentEngine);
        adapter.SetSyntheticObservationForTest(() => new ConnectedGenerationHeldObservation(snapshot, handles));
        if (afterFakeStart) adapter.SetSyntheticStartForTest(p => {
            Directory.CreateDirectory(p.RootPath); // generated ordinary directory, not a Cloud Files root
            var profilePath = Path.Combine(p.ProfileDirectory, "profile.json");
            var replacement = Path.Combine(p.ProfileDirectory, "fake-ready-profile.tmp");
            File.WriteAllBytes(replacement, File.ReadAllBytes(profilePath));
            File.Move(replacement, profilePath, overwrite: true); // simulate the real atomic profile replacement
            var observed = ConnectedGenerationHandleLease.Open(p.ProfileDirectory, "manifest-" + p.Identity.ToString("N") + ".json", p.RootPath);
            Check(observed.ProfileFileId != p.ProfileDocumentFileId, "fake start records a different replacement profile file ID");
            return Task.FromResult(new ConnectedGenerationHeldObservation(new ConnectedGenerationSnapshot(p.Identity, p.ProfileDirectory,
                p.RootPath, unchecked((long)observed.RootFileId), Guid.NewGuid(), p.ManifestDigest, nativeScope, p.ProfileRevision + 1), observed));
        });
        if (publish) {
            var result = await session.ExecuteFreshGenerationAsync(adapter, bytes, binding, CancellationToken.None);
            Check(result.State.Phase == FreshGenerationPlan.Phase.Published && session.FreshGenerationRecoveryRequired && session.State == ExplorerPreviewState.Failed,
                "publication retains both sessions and reports review, not a live handoff");
            Check(FreshGenerationIndexCodec.Decode(File.ReadAllBytes(fixture.IndexPath)) == result, "published selector survived an independent read");
            await session.VerifyPublishedFreshGenerationAsync(CancellationToken.None);
            wrongPrincipal = true;
            try { await session.VerifyPublishedFreshGenerationAsync(CancellationToken.None); throw new Exception("Changed account was accepted."); }
            catch (IOException) { }
            wrongPrincipal = false;
            try { using var unexpected = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("Prior lock released on auth failure."); }
            catch (IOException) { }
            var selectedBytes = File.ReadAllBytes(fixture.IndexPath);
            var changed = result with { Revision = result.Revision + 1 };
            File.WriteAllBytes(fixture.IndexPath, FreshGenerationIndexCodec.Encode(changed));
            try { await session.VerifyPublishedFreshGenerationAsync(CancellationToken.None); throw new Exception("Changed selector was accepted."); }
            catch (IOException) { }
            File.WriteAllBytes(fixture.IndexPath, selectedBytes);
            var reopened = fixture.Create();
            Check(reopened.FreshGenerationRecoveryRequired && reopened.StartupProfileState == SavedProfileState.NeedsReview && !reopened.CanReconnectCached,
                "a restarted session holds the published selector rather than adopting an unqualified provider");
            var backendsBeforeCold = fixture.Backends;
            try { await reopened.ComposeColdFreshRestartAsync(explicitLogin: true, CancellationToken.None); throw new Exception("Unqualified product restart was accepted."); }
            catch (IOException) { }
            Check(fixture.Backends == backendsBeforeCold && File.ReadAllBytes(fixture.IndexPath).AsSpan().SequenceEqual(selectedBytes),
                "unqualified product restart refuses before backend construction or selector changes");
            var authInvoked = false;
            var disabledRestart = FreshGenerationColdRestart.CreateDisabled(prior, candidate, result, _ => {
                authInvoked = true; return Task.FromResult(scope);
            });
            try { await reopened.AttemptColdFreshRestartAsync(disabledRestart, CancellationToken.None); throw new Exception("Disabled cold restart was accepted."); }
            catch (IOException) { }
            Check(!authInvoked && File.ReadAllBytes(fixture.IndexPath).AsSpan().SequenceEqual(selectedBytes),
                "disabled cold restart refuses before authentication or selector changes");
            await reopened.DisposeAsync();
        } else {
            try { await session.ExecuteFreshGenerationAsync(adapter, bytes, binding, CancellationToken.None); throw new Exception("Expected post-drain failure."); }
            catch (IOException) { }
        }
        Check(checks == (publish ? 5 : afterFakeStart ? 3 : 2), "failure occurs at the requested transition boundary");
        Check(session.FreshGenerationRecoveryRequired && !session.CanReconnectCached && !session.CanRecheckSession && !session.CanRefreshEmptyInventory,
            "generation ownership hold suppresses schema-1 recovery and reconnect capabilities");
        try { using var unexpected = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("Prior lease released."); }
        catch (IOException) { }
        try { await session.DisposeAsync(); throw new Exception("Shutdown unexpectedly succeeded."); } catch (IOException) { }
        await adapter.ReclaimPriorAsync(CancellationToken.None);
        if (afterFakeStart) await adapter.ReleaseReclaimedSyntheticAfterFakeStartAsync();
        else await adapter.ReleaseReclaimedSyntheticBeforeStartAsync();
        await session.ReleaseEmptyFreshAdapterForTestAsync();
        await session.DisposeAsync();
        if (publish) {
            fixture.SyntheticColdAdmission = true;
            fixture.CurrentFailure = new IOException("Injected current-account failure.");
            var cold = fixture.Create(); var priorDisposals = fixture.BackendDisposals;
            Check(cold.CanStartPublishedFresh && cold.CanReconnectCached && !cold.RequiresOwnershipReview && cold.StartupProfileState == SavedProfileState.OwnedReady,
                "qualified published selector exposes only the fresh reconnect path");
            for (var attempt = 0; attempt < 2; attempt++) {
                try { if (attempt == 0) await cold.StartAsync(); else await cold.ReconnectCachedAsync(); throw new Exception("Failed account check was accepted."); }
                catch (IOException) { }
                using (new FileStream(Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, "index.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            }
            Check(fixture.BackendDisposals == priorDisposals + 2 && cold.CanStartPublishedFresh && !cold.RequiresOwnershipReview,
                "failed pre-start authentication releases each backend and selector lock for retry while holding saved selector");
            fixture.FailBackendDisposalOnce = true;
            try { await cold.ComposeColdFreshRestartAsync(explicitLogin: true, CancellationToken.None); throw new Exception("Failed cleanup was accepted."); }
            catch (IOException) { }
            try { using var unexpected = new FileStream(Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, "index.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new Exception("Uncertain cleanup released selector lock."); }
            catch (IOException) { }
            Check(cold.RequiresOwnershipReview, "failed backend disposal retains ownership review");
            fixture.CurrentFailure = null; fixture.SyntheticColdAdmission = false;
            await cold.DisposeAsync();
            using (new FileStream(Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, "index.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        }
    }

    private static async Task FreshTransitionSessionRetention()
    {
        await using var fixture = new Fixture { Alias = "employee" };
        var session = fixture.Create(); await session.StartAsync();
        var bytes = File.ReadAllBytes(fixture.IndexPath);
        var json = JsonNode.Parse(bytes) ?? throw new IOException();
        string Field(string name) => json[name]?.GetValue<string>() ?? throw new IOException(name);
        var source = fixture.StartedSources.Single();
        var scope = new FreshGenerationPlan.Scope("pilot", "employee", source.Origin.GetLeftPart(UriPartial.Authority), Field("PrincipalId"));
        var old = new FreshGenerationPlan.Generation(Guid.NewGuid(), scope, Path.Combine(fixture.TestRoot, "old-profile"), Path.Combine(fixture.TestRoot, "old-root"), new string('a', 64), 1, 2, 1, 1, 3, 1, 4, Guid.NewGuid());
        var binding = new FreshGenerationIndexStore.LegacyBinding(json["Revision"]!.GetValue<long>(), Field("Sid"), "pilot", "employee", Field("OriginSha256"), scope.Principal, old);
        var nativeScope = new ExplorerRootScope(scope.Channel, scope.Source, scope.Origin, scope.Principal);
        var manifest = new ExplorerRootManifest(nativeScope, new Dictionary<string, PlaceholderIdentity>());
        await using var prior = new OwnedExplorerRootSession(old.ProfileDirectory, old.RootPath, source, nativeScope, manifest);
        await using var candidate = new OwnedExplorerRootSession(Path.Combine(fixture.TestRoot, "new-profile"), Path.Combine(fixture.TestRoot, "new-root"), source, nativeScope, manifest);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var adapter = FreshGenerationOwnedAdapter.CreateForTest(prior, candidate, old, async token => {
            entered.TrySetResult(); await release.Task.WaitAsync(token); throw new IOException("Injected authentication failure.");
        }, (_, _) => false, _ => false);
        adapter.SetSyntheticPriorForTest(fixture.CurrentEngine);
        var transition = session.ExecuteFreshGenerationAsync(adapter, bytes, binding, CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var shutdown = session.DisposeAsync().AsTask();
        release.TrySetResult();
        try { await transition; throw new Exception("Transition unexpectedly succeeded."); } catch (IOException) { }
        try { await shutdown; throw new Exception("Shutdown unexpectedly succeeded."); } catch (IOException) { }
        Check(fixture.EngineStarts == 1 && !Directory.Exists(old.ProfileDirectory), "failure retains adapter without native root actions");
        await session.ReleaseEmptyFreshAdapterForTestAsync();
        await session.DisposeAsync();
    }

    private static async Task SavedCapabilityObservationRaces()
    {
        foreach (var empty in new[] { false, true }) foreach (var transition in new[] { "reconnect", "dispose", "disposed-observation" }) {
            await using var fixture = new Fixture { EmptyInventory = empty };
            var seed = fixture.Create(); await seed.StartAsync(); await seed.DisposeAsync();
            var session = fixture.Create();
            bool Observe() => empty ? session.CanRefreshEmptyInventory : session.CanReconnectCached;
            var requests = fixture.Requests; var signs = fixture.SignIns; var captures = fixture.Captures;
            Check(Observe() && fixture.Requests == requests && fixture.SignIns == signs && fixture.Captures == captures,
                "stable saved capability remains an offline hint with unchanged owned eligibility");
            using var barrier = new StateReadBarrier();
            fixture.BeforeOwnedReceipt = () => {
                if (barrier.Thread != Environment.CurrentManagedThreadId) return;
                barrier.Entered.TrySetResult();
                if (!barrier.Release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Saved capability release required.");
            };
            var reading = Task.Run(() => { barrier.Thread = Environment.CurrentManagedThreadId; return Observe(); });
            await barrier.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Task? reconnect = null;
            try {
                if (transition == "reconnect") {
                    fixture.HoldCurrent = true; reconnect = session.ReconnectCachedAsync();
                    await fixture.CurrentEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    Check(session.State == ExplorerPreviewState.Starting && fixture.SignIns == signs && fixture.Captures == captures,
                        "background reconnect drains the captured provider while the UI getter is blocked without holding view");
                } else {
                    fixture.ThrowDisposedObservation = transition == "disposed-observation";
                    await session.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
                    Check(fixture.Requests == requests && fixture.SignIns == signs && fixture.Captures == captures,
                        "disposal completes while a getter is blocked without authentication or view lock inversion");
                }
                barrier.Release.Set();
                Check(!await reading.WaitAsync(TimeSpan.FromSeconds(5)),
                    "both saved capability getters reject drained/replaced generations and known disposed observations without dereferencing mutable fields");
            } finally {
                barrier.Release.Set(); fixture.BeforeOwnedReceipt = null;
                await reading.WaitAsync(TimeSpan.FromSeconds(5));
                if (reconnect is not null) { var closing = session.DisposeAsync().AsTask(); await Cancelled(reconnect); await closing.WaitAsync(TimeSpan.FromSeconds(5)); }
            }
            Check(!Observe(), "closed or cancelled saved capability stays unavailable");
        }
    }
    private static async Task LocalFailureDiagnosticIntegration()
    {
        string Diagnostic(Fixture fixture) => Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, ConnectionDiagnosticStore.Leaf);
        foreach (var atSource in new[] { false, true }) {
            await using var fixture = new Fixture { Alias = "employee", VerifyEngineSession = true };
            var session = fixture.Create(); await session.StartAsync();
            var index = File.ReadAllBytes(fixture.IndexPath); var indexTime = File.GetLastWriteTimeUtc(fixture.IndexPath);
            var signs = fixture.SignIns; var captures = fixture.Captures; var starts = fixture.EngineStarts;
            var failure = new TransferException("private URL token account reference", TransferFailureReason.UnexpectedHttpStatus, 503);
            failure.Data["private"] = "secret";
            if (atSource) fixture.SourceFailure = failure; else fixture.CurrentFailure = failure;
            await SameFailure(session.RecheckSessionAsync, failure);
            var leaf = Diagnostic(fixture); var text = File.ReadAllText(leaf); var record = JsonNode.Parse(text)!.AsObject();
            var expected = ConnectionFailureTrace.Format(ConnectionAction.Recheck,
                atSource ? ConnectionPhase.SourceSession : ConnectionPhase.CurrentSession, failure);
            Check(new FileInfo(leaf).Length <= 1024 && record.Count == 5 && record["owner"]!.GetValue<string>() == ConnectionDiagnosticStore.Owner &&
                record["supportCode"]!.GetValue<string>() == expected &&
                record["appVersion"]!.GetValue<string>() == typeof(ConnectedExplorerSession).Assembly.GetName().Version!.ToString(4) &&
                !text.Contains("private", StringComparison.Ordinal) && !text.Contains("secret", StringComparison.Ordinal) && !text.Contains(Fixture.PersonA, StringComparison.Ordinal),
                "owned employee lease writes only the exact closed typed current/source failure and five bounded fields");
            fixture.CurrentFailure = null; fixture.SourceFailure = null; fixture.Log.Clear(); var requests = fixture.Requests;
            await session.RecheckSessionAsync();
            Check(session.State == ExplorerPreviewState.Running && fixture.Requests == requests + 3 && fixture.SignIns == signs &&
                fixture.Captures == captures && fixture.EngineStarts == starts && fixture.EngineResumes == 1 &&
                index.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)) && File.GetLastWriteTimeUtc(fixture.IndexPath) == indexTime &&
                File.ReadAllText(leaf) == text,
                "diagnostic persistence changes no authorization/recovery calls, index or successful-operation evidence");
        }
        await using (var fixture = new Fixture { Alias = "employee", VerifyEngineSession = true }) {
            var session = fixture.Create(); await session.StartAsync();
            var leaf = Diagnostic(fixture); File.WriteAllText(leaf, "unknown diagnostic record must remain");
            var original = File.ReadAllBytes(leaf); var time = File.GetLastWriteTimeUtc(leaf);
            var failure = new TransferException("private transient", TransferFailureReason.Network); fixture.CurrentFailure = failure;
            await SameFailure(session.RecheckSessionAsync, failure);
            Check(session.CanRecoverTransientSession && original.AsSpan().SequenceEqual(File.ReadAllBytes(leaf)),
                "unknown existing record is not adopted and cannot suppress normal transient recovery");
            fixture.CurrentFailure = null; fixture.Log.Clear(); var requests = fixture.Requests; var signs = fixture.SignIns;
            await session.RecheckSessionAsync();
            Check(session.State == ExplorerPreviewState.Running && fixture.Requests == requests + 3 && fixture.SignIns == signs && fixture.EngineResumes == 1 &&
                fixture.Log.SequenceEqual(["current-check", "source-check", "resume-gate", "source-check", "engine-resumed"]) &&
                original.AsSpan().SequenceEqual(File.ReadAllBytes(leaf)) && File.GetLastWriteTimeUtc(leaf) == time &&
                !File.Exists(Path.Combine(Path.GetDirectoryName(leaf)!, ".latest-connection-failure.write.tmp")),
                "unknown record stays byte/time identical while the same verified recovery and requests complete");
        }
        await using (var client = new Fixture()) {
            var session = client.Create(); await session.StartAsync();
            var failure = new TransferException("private client", TransferFailureReason.Network); client.CurrentFailure = failure;
            await SameFailure(session.RecheckSessionAsync, failure);
            Check(!File.Exists(Diagnostic(client)), "client source never writes an employee diagnostic");
        }
        foreach (var unknownIndex in new[] { false, true }) {
            await using var fixture = new Fixture { Alias = "employee" };
            var seed = fixture.Create(); await seed.StartAsync(); await seed.DisposeAsync();
            if (unknownIndex) File.WriteAllText(fixture.IndexPath, "{}");
            var original = File.ReadAllBytes(fixture.IndexPath); var requests = fixture.Requests; var signs = fixture.SignIns;
            var passive = fixture.Create();
            if (unknownIndex) await Refuses(passive.StartAsync);
            else await Refuses(async () => { _ = await passive.GetUpdateBindingAsync(); });
            Check(!File.Exists(Diagnostic(fixture)) && original.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)) &&
                fixture.Requests == requests && fixture.SignIns == signs,
                "unknown index or passive current index without its real lease cannot write diagnostics or start authentication");
        }
        await using (var fixture = new Fixture { Alias = "employee", FailFirstRunningDispose = true }) {
            var session = fixture.Create(); await session.StartAsync(); var requests = fixture.Requests;
            await Refuses(() => session.DisposeAsync().AsTask());
            var text = File.ReadAllText(Diagnostic(fixture));
            Check(JsonNode.Parse(text)!["supportCode"]!.GetValue<string>() == ConnectionFailureTrace.Format(ConnectionAction.Dispose,
                ConnectionPhase.ProviderDrain, new IOException("ignored private detail")) && fixture.Requests == requests,
                "uncertain disposal writes its bounded phase while the real index lease remains owned, without authentication");
            await session.DisposeAsync();
            Check(File.ReadAllText(Diagnostic(fixture)) == text, "successful later drain does not overwrite failure evidence");
        }
    }

    private static async Task RecoveryViewPublicationRaces()
    {
        foreach (var transient in new[] { true, false }) {
            await using var fixture = new Fixture { Alias = "employee", VerifyEngineSession = true };
            var session = fixture.Create(); await session.StartAsync();
            using var stateRead = new StateReadBarrier();
            var staleEvent = fixture.EmitWithBlockedStateRead(stateRead);
            await stateRead.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            using var readerContinue = new ManualResetEventSlim(false);
            var readerReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var reader = Task.Run(() => {
                var thread = Environment.CurrentManagedThreadId;
                var readsBefore = fixture.StateReadsOnThread(thread);
                var before = session.CanRecheckSession && !session.CanRecoverTransientSession;
                readerReady.TrySetResult();
                if (!readerContinue.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Synthetic view reader release required.");
                var recheck = session.CanRecheckSession; var recovery = session.CanRecoverTransientSession;
                return (before, Recheck: recheck, Recovery: recovery, Reads: fixture.StateReadsOnThread(thread) - readsBefore);
            });
            try {
                await readerReady.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Exception failure = transient ? new TransferException("private transient", TransferFailureReason.Network) : new AccessDeniedException();
                fixture.CurrentFailure = failure;
                await SameFailure(session.RecheckSessionAsync, failure);
                Check(session.State == ExplorerPreviewState.Failed && session.CanRecoverTransientSession == transient,
                    "failure+pending is published while a stale Running event read and view reader are held");
                stateRead.Release.Set(); await staleEvent.WaitAsync(TimeSpan.FromSeconds(5));
                readerContinue.Set(); var observed = await reader.WaitAsync(TimeSpan.FromSeconds(5));
                Check(observed.before && observed.Recheck == transient && observed.Recovery == transient &&
                    observed.Reads == 0 && session.State == ExplorerPreviewState.Failed &&
                    session.CanRecoverTransientSession == transient,
                    "getters are read-only atomic observations with no engine calls; delayed Running cannot erase or promote transient/permanent Failed publication");
                fixture.CurrentFailure = null; var requests = fixture.Requests;
                await session.RecheckSessionAsync();
                Check(transient ? session.State == ExplorerPreviewState.Running && fixture.EngineResumes == 1
                        : session.State == ExplorerPreviewState.Failed && fixture.EngineResumes == 0 && fixture.Requests == requests,
                    "only a fresh checked operation promotes transient recovery; permanent hold remains untouched");
            } finally {
                stateRead.Release.Set(); readerContinue.Set();
                await staleEvent.WaitAsync(TimeSpan.FromSeconds(5)); await reader.WaitAsync(TimeSpan.FromSeconds(5));
            }
        }
    }

    private static async Task TransientRecheckRecovery()
    {
        foreach (var (failure, atSource) in new[] {
            new TransferException("private transient", TransferFailureReason.Network),
            new TransferException("private transient", TransferFailureReason.Timeout),
            new TransferException("private transient", TransferFailureReason.UnexpectedHttpStatus, 502),
            new TransferException("private transient", TransferFailureReason.UnexpectedHttpStatus, 503),
            new TransferException("private transient", TransferFailureReason.UnexpectedHttpStatus, 504)
        }.SelectMany(failure => new[] { (failure, false), (failure, true) })) {
            await using var fixture = new Fixture { Alias = "employee", VerifyEngineSession = true };
            var session = fixture.Create(); await session.StartAsync();
            var signs = fixture.SignIns; var starts = fixture.EngineStarts; var captures = fixture.Captures;
            var index = File.ReadAllBytes(fixture.IndexPath);
            Directory.CreateDirectory(Path.GetDirectoryName(fixture.LocalSentinel)!);
            await File.WriteAllTextAsync(fixture.LocalSentinel, "local bytes stay during automatic recovery");
            if (atSource) fixture.SourceFailure = failure; else fixture.CurrentFailure = failure;
            await SameFailure(session.RecheckSessionAsync, failure);
            Check(session.State == ExplorerPreviewState.Failed && session.CanRecoverTransientSession && session.CanRecheckSession &&
                fixture.EnginePauses == 1 && fixture.EngineResumes == 0 && fixture.SignIns == signs,
                "only confirmed pause of a running generation arms a later timer check for a bounded transient");
            fixture.EmitEngineActivity();
            Check(session.State == ExplorerPreviewState.Failed && session.CanRecoverTransientSession,
                "late Changed/Activity from the same paused provider retains Failed+pending until a checked resume");
            var requests = fixture.Requests;
            await SameFailure(session.RecheckSessionAsync, failure);
            Check(fixture.Requests == requests + (atSource ? 2 : 1) && fixture.EnginePauses == 1 && fixture.EngineResumes == 0 && session.CanRecoverTransientSession,
                "a still-unavailable next tick performs one check and retains the same paused generation without an inner retry loop");
            fixture.CurrentFailure = null; fixture.SourceFailure = null; fixture.Log.Clear(); requests = fixture.Requests;
            await session.RecheckSessionAsync();
            Check(session.State == ExplorerPreviewState.Running && !session.CanRecoverTransientSession && fixture.EngineResumes == 1 &&
                fixture.Requests == requests + 3 && fixture.Log.SequenceEqual(["current-check", "source-check", "resume-gate", "source-check", "engine-resumed"]),
                "next healthy tick verifies current and source identity before the root engine's separate cached gate resumes");
            Check(fixture.SignIns == signs && fixture.EngineStarts == starts && fixture.Captures == captures &&
                index.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)) && await File.ReadAllTextAsync(fixture.LocalSentinel) == "local bytes stay during automatic recovery",
                "automatic recovery uses no browser/new backend/provider/capture/index write and preserves local bytes");
        }
    }

    private static async Task TransientResumeGateRecovery()
    {
        foreach (var failure in new Exception[] { new TransferException("offline", TransferFailureReason.Network), new AccessDeniedException() }) {
            await using var fixture = new Fixture { Alias = "employee", VerifyEngineSession = true };
            var session = fixture.Create(); await session.StartAsync();
            var offline = new TransferException("offline", TransferFailureReason.Network);
            fixture.CurrentFailure = offline; await SameFailure(session.RecheckSessionAsync, offline);
            fixture.CurrentFailure = null; fixture.ResumeFailure = failure;
            await SameFailure(session.RecheckSessionAsync, failure);
            var shouldRetry = failure is TransferException;
            Check(session.State == ExplorerPreviewState.Failed && session.CanRecoverTransientSession == shouldRetry,
                "only transient resume-gate failure on same paused generation retains automatic recovery");
            fixture.ResumeFailure = null; var resumes = fixture.EngineResumes;
            await session.RecheckSessionAsync();
            Check(shouldRetry ? session.State == ExplorerPreviewState.Running && fixture.EngineResumes == resumes + 1
                : session.State == ExplorerPreviewState.Failed && fixture.EngineResumes == resumes,
                "healthy next tick resumes only eligible recovery");
        }
        foreach (var ambiguous in new[] { "changed-inventory", "partial-running" }) {
            await using var fixture = new Fixture { Alias = "employee", VerifyEngineSession = true };
            var session = fixture.Create(); await session.StartAsync();
            var offline = new TransferException("offline", TransferFailureReason.Network);
            fixture.CurrentFailure = offline; await SameFailure(session.RecheckSessionAsync, offline);
            fixture.CurrentFailure = null; fixture.ResumeFailure = offline;
            fixture.BeforeResumeFailure = ambiguous == "changed-inventory"
                ? fixture.ChangeVisibleManifest : () => fixture.ForceEngineState(ExplorerPreviewState.Running);
            await SameFailure(session.RecheckSessionAsync, offline);
            Check(!session.CanRecoverTransientSession && !session.CanRecheckSession,
                "changed ownership or ambiguous partial resume must remain held: " + ambiguous);
        }
    }

    private static async Task TransientRecoveryHolds()
    {
        foreach (var failure in new Exception[] {
            new TransferException("private invalid", TransferFailureReason.InvalidMetadata),
            new TransferException("private unknown"),
            new TransferException("private HTTP", TransferFailureReason.UnexpectedHttpStatus, 500),
            new TransferException("private HTTP", TransferFailureReason.UnexpectedHttpStatus, 429),
            new LoginRequiredException(LoginFailureReason.HttpUnauthorized, LoginFailureOperation.QueueSession),
            new AccessDeniedException(), new ResourceUnavailableException(), new IOException("private ownership"),
            new UnauthorizedAccessException("private local access"), new System.ComponentModel.Win32Exception(5), new OperationCanceledException()
        }) {
            await using var fixture = new Fixture { Alias = "employee" };
            var session = fixture.Create(); await session.StartAsync();
            // Also prove that a permanent result retires a previously eligible transient wait.
            var transient = new TransferException("private network", TransferFailureReason.Network); fixture.CurrentFailure = transient;
            await SameFailure(session.RecheckSessionAsync, transient); Check(session.CanRecoverTransientSession, "seed transient recovery");
            fixture.CurrentFailure = failure; await SameFailure(session.RecheckSessionAsync, failure);
            fixture.EmitEngineActivity();
            Check(session.State == ExplorerPreviewState.Failed && !session.CanRecheckSession,
                "late paused Activity cannot turn a permanent/manual Failed hold back into timer checks");
            var requests = fixture.Requests; fixture.CurrentFailure = null;
            await session.RecheckSessionAsync();
            Check(!session.CanRecoverTransientSession && !session.CanRecheckSession && fixture.Requests == requests && fixture.EngineResumes == 0,
                "nontransient results require explicit action and cannot restart checks or resume after becoming healthy");
        }
        foreach (var condition in new[] { "manual-pause", "pause-unconfirmed", "changed-person", "expired", "changed-inventory", "changed-index", "engine-failed", "engine-stopped", "engine-running", "engine-removed", "engine-unknown", "removed", "disposed" }) {
            await using var fixture = new Fixture { Alias = "employee" };
            var session = fixture.Create(); await session.StartAsync();
            var failure = new TransferException("private network", TransferFailureReason.Network);
            if (condition == "manual-pause") await session.PauseAsync();
            if (condition == "pause-unconfirmed") fixture.RefusePause = true;
            fixture.CurrentFailure = failure; await SameFailure(session.RecheckSessionAsync, failure); fixture.CurrentFailure = null;
            if (condition == "changed-person") fixture.Person = Fixture.PersonB;
            if (condition == "expired") fixture.Expired = true;
            if (condition == "changed-inventory") fixture.ChangeVisibleManifest();
            if (condition == "changed-index") {
                var changed = JsonNode.Parse(File.ReadAllText(fixture.IndexPath))!.AsObject(); changed["Revision"] = changed["Revision"]!.GetValue<long>() + 1;
                File.WriteAllText(fixture.IndexPath, changed.ToJsonString());
            }
            if (condition == "engine-failed") fixture.ForceEngineState(ExplorerPreviewState.Failed);
            if (condition == "engine-stopped") fixture.ForceEngineState(ExplorerPreviewState.NotStarted);
            if (condition == "engine-running") fixture.ForceEngineState(ExplorerPreviewState.Running);
            if (condition == "engine-removed") fixture.ForceEngineState(ExplorerPreviewState.Removed);
            if (condition == "engine-unknown") fixture.ForceEngineState((ExplorerPreviewState)123);
            if (condition == "removed") await session.RemoveAsync();
            if (condition == "disposed") await session.DisposeAsync();
            var requests = fixture.Requests;
            if (condition is "changed-person" or "expired") await Refuses(session.RecheckSessionAsync);
            else if (condition == "disposed") {
                try { await session.RecheckSessionAsync(); throw new InvalidOperationException("Disposed check must refuse."); }
                catch (ObjectDisposedException) { }
            } else await session.RecheckSessionAsync();
            Check(fixture.EngineResumes == 0 && !session.CanRecoverTransientSession,
                "manual pause, changed identity/expiry/ownership, unsupported engine state, removal and disposal never auto-resume: " + condition);
            if (condition is "manual-pause" or "pause-unconfirmed" or "changed-inventory" or "changed-index" or "engine-failed" or "engine-stopped" or "engine-running" or "engine-removed" or "engine-unknown" or "removed" or "disposed")
                Check(fixture.Requests == requests, "held/removed/disposed paths make no further account/source calls");
        }
    }

    private static async Task TransientRecoveryTimerAndQuit()
    {
        await using var fixture = new Fixture { Alias = "employee", VerifyEngineSession = true };
        var session = fixture.Create(); var factories = 0;
        var window = new ExplorerPreviewWindow(() => { factories++; throw new InvalidOperationException("Timer must not replace a generation."); },
            _ => new FakeTrayIcon(), ExplorerWindowContent.Connected("Test", AccessMode.Employee), session)
            { ShowInTaskbar = false, Left = -20000, Top = -20000, WindowStartupLocation = System.Windows.WindowStartupLocation.Manual };
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); window.Closed += (_, _) => closed.TrySetResult(); window.Show();
        try {
            await window.StartPreviewAsync();
            fixture.CurrentFailure = new TransferException("private network", TransferFailureReason.Network);
            await window.TickSessionCheckAsync();
            Check(window.StatusText == "Waiting to reconnect" && session.CanRecoverTransientSession && factories == 0,
                "existing timer path accepts an eligible failed generation and clearly describes automatic recovery");
            fixture.CurrentFailure = null; fixture.HoldCurrent = true;
            var tick = window.TickSessionCheckAsync(); await fixture.CurrentEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var requests = fixture.Requests; await window.TickSessionCheckAsync();
            Check(!tick.IsCompleted && fixture.Requests == requests, "busy timer guard makes no overlapping check");
            window.Quit(); await closed.Task.WaitAsync(TimeSpan.FromSeconds(5)); await tick;
            await window.TickSessionCheckAsync();
            Check(fixture.EngineResumes == 0 && !session.CanRecoverTransientSession && fixture.Requests == requests && factories == 0,
                "Quit cancels the pending fresh check and later ticks cannot resume, authenticate or create a replacement");
        } finally { window.Quit(); await closed.Task.WaitAsync(TimeSpan.FromSeconds(5)); }
    }

    private static async Task SameFailure(Func<Task> work, Exception expected)
    {
        try { await work(); }
        catch (Exception error) when (ReferenceEquals(error, expected)) { return; }
        throw new InvalidOperationException("Expected the same bounded source failure.");
    }

    internal sealed class StateReadBarrier : IDisposable
    {
        internal int Thread;
        internal readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly ManualResetEventSlim Release = new(false);
        public void Dispose() { Release.Set(); Release.Dispose(); }
    }

    private static async Task RecheckDiagnosticsAndRecovery()
    {
        foreach (var boundary in new[] { "current", "source", "login" }) {
            await using var fixture = new Fixture { Alias = "employee" };
            var session = fixture.Create(); await session.StartAsync();
            var signs = fixture.SignIns; var starts = fixture.EngineStarts;
            Directory.CreateDirectory(Path.GetDirectoryName(fixture.LocalSentinel)!);
            await File.WriteAllTextAsync(fixture.LocalSentinel, "local data retained through failed checks");
            var sentinel = await File.ReadAllBytesAsync(fixture.LocalSentinel);
            if (boundary == "current") fixture.CurrentFailure = new TransferException("private session details", TransferFailureReason.UnexpectedHttpStatus, 503);
            if (boundary == "source") fixture.SourceFailure = new TransferException("private source details", TransferFailureReason.Network);
            if (boundary == "login") fixture.CurrentFailure = new LoginRequiredException(LoginFailureReason.TokenExpired, LoginFailureOperation.CachedToken);
            try { await session.RecheckSessionAsync(); throw new InvalidOperationException("Check failure required."); }
            catch (Exception error) when (ReferenceEquals(error, fixture.CurrentFailure) || ReferenceEquals(error, fixture.SourceFailure)) { }
            var expected = boundary switch {
                "current" => "connection/Recheck/CurrentSession/Transfer/UnexpectedHttpStatus; HTTP 503",
                "source" => "connection/Recheck/SourceSession/Transfer/Network",
                _ => "connection/Recheck/CurrentSession/LoginRequired/Unknown; auth=CachedToken/TokenExpired"
            };
            Check(session.State == ExplorerPreviewState.Failed && fixture.EnginePauses == 1 && fixture.SignIns == signs && fixture.EngineStarts == starts &&
                session.Activity.Any(line => line.EndsWith(expected, StringComparison.Ordinal)) && session.Activity.All(line => !line.Contains("private ", StringComparison.Ordinal)),
                "periodic failure pauses without browser/retry and retains its bounded source boundary/root cause");
            fixture.CurrentFailure = null; fixture.SourceFailure = null;
            await session.StartAsync();
            var retained = await File.ReadAllBytesAsync(fixture.LocalSentinel);
            Check(session.State == ExplorerPreviewState.Running && fixture.SignIns == signs + 1 && fixture.EngineStarts == starts + 1 &&
                sentinel.AsSpan().SequenceEqual(retained),
                "only explicit sign-in recovers through full drain and current account checks, preserving local data");
        }
    }

    private static async Task EmployeeAdmission()
    {
        await using (var denied = new Fixture { Alias = "employee", AccessDenied = true }) {
            var session = denied.Create(); await Refuses(session.StartAsync);
            Check(denied.Backends == 1 && denied.SignIns == 1 && denied.Captures == 0 && denied.EngineStarts == 0 &&
                !File.Exists(denied.IndexPath) && session.State == ExplorerPreviewState.Failed,
                "an authenticated but unadmitted employee account opens no inventory/provider and never probes a client source");
        }
        await using (var admitted = new Fixture { Alias = "employee", EmptyInventory = true }) {
            var session = admitted.Create(); await session.StartAsync();
            Check(admitted.Backends == 1 && admitted.Captures == 1 && admitted.EngineStarts == 1 && session.InventoryEmpty &&
                session.State == ExplorerPreviewState.Running && admitted.StartedSources.All(source => source.Alias == "employee"),
                "authoritatively admitted employee with zero current shared roots remains connected to the employee source");
        }
    }

    private static async Task ExplicitEmptyRefresh()
    {
        foreach (var mode in new[] { "refresh", "still-empty", "capture-fails", "count-limit", "path-limit", "person-changes", "manifest-changes", "cancel-capture", "remove-uncertain", "cancel-after-remove" }) {
            await using var f = new Fixture { EmptyInventory = true };
            var session = f.Create(); await session.StartAsync();
            var before = File.ReadAllBytes(f.IndexPath);
            Directory.CreateDirectory(Path.GetDirectoryName(f.LocalSentinel)!);
            File.WriteAllText(f.LocalSentinel, "locally added bytes stay here");
            Check(session.CanRefreshEmptyInventory, "owned empty generation offers explicit refresh");
            f.EmptyInventory = mode == "still-empty";
            if (mode == "capture-fails") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.FileResolution, CatalogCaptureBoundary.MetadataRequest, TransferFailureReason.Network, null);
            if (mode is "count-limit" or "path-limit") f.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.FolderListing,
                CatalogCaptureBoundary.ValidateInventory, TransferFailureReason.InvalidMetadata, null,
                mode=="count-limit" ? CatalogCaptureLimit.EntryCount : CatalogCaptureLimit.PathOrDepth);
            if (mode == "person-changes") f.AfterCapture = () => f.Person = Fixture.PersonB;
            if (mode == "manifest-changes") f.AfterCapture = f.ChangeSavedManifest;
            if (mode == "remove-uncertain") f.UnconfirmedRemove = true;
            if (mode == "cancel-after-remove") f.AfterRemove = () => { _ = session.DisposeAsync(); };
            if (mode == "cancel-capture") f.HoldCapture = true;
            var refresh = session.StartAsync();
            if (mode == "cancel-capture") {
                // The first seed capture already completed its signal: this fresh operation still waits on the unreleased capture gate.
                Check(!refresh.IsCompleted, "refresh waits for current authorized capture");
                var closing = session.DisposeAsync().AsTask(); await Cancelled(refresh); await closing;
            } else if (mode == "cancel-after-remove") await Cancelled(refresh);
            else if (mode is "capture-fails" or "count-limit" or "path-limit") {
                try { await refresh; throw new InvalidOperationException("Expected capture failure."); }
                catch (CatalogCaptureException error) when (ReferenceEquals(error, f.CaptureFailure)) { }
            }
            else if (mode is "person-changes" or "manifest-changes" or "remove-uncertain") await Refuses(() => refresh);
            else await refresh;
            Check(File.ReadAllText(f.LocalSentinel) == "locally added bytes stay here", "refresh never deletes or modifies an added local file");
            if(mode is "count-limit" or "path-limit") {
                var expected=mode=="count-limit" ? "limit of 1,000 files and folders" : "folder path or its nesting exceeds";
                Check(session.Activity.Any(line=>line.Contains(expected,StringComparison.Ordinal)) && session.Activity.All(line=>!line.Contains(f.IndexPath,StringComparison.Ordinal)),
                    "limit explanation is actionable and does not expose local paths");
            }
            var removed = f.Log.Count(item => item == "engine-remove");
            if (mode == "refresh") {
                Check(removed == 1 && f.Captures == 2 && f.EngineStarts == 2 && !session.InventoryEmpty && !session.CanRefreshEmptyInventory,
                    "explicit sign-in refresh rotates only an empty generation after capture and exact removal");
                Check(session.Activity.Any(line => line.Contains("check the previous folder for local files", StringComparison.Ordinal)), "refresh directs users to check the previous folder");
                var captures = f.Captures; await session.StartAsync();
                Check(f.Captures == captures && f.Log.Count(item => item == "engine-remove") == 1, "nonempty explicit reconnect never recaptures or removes");
            } else if (mode == "still-empty") Check(removed == 0 && session.InventoryEmpty && f.Captures == 2 &&
                session.Activity.All(line => !line.Contains("Reconnecting does not refresh it", StringComparison.Ordinal)), "still-empty capture reuses existing registration without contradictory activity");
            else if (mode == "cancel-after-remove") Check(removed == 1 && JsonNode.Parse(File.ReadAllText(f.IndexPath))!["Removed"]!.GetValue<bool>() && f.EngineStarts == 1,
                "confirmed removal is durable before cancellation and never creates a replacement");
            else Check(removed == (mode == "remove-uncertain" ? 1 : 0) && f.EngineStarts == 1 && before.AsSpan().SequenceEqual(File.ReadAllBytes(f.IndexPath)),
                "failed capture/account/cancellation or uncertain removal never publishes a replacement index");
        }
        await using (var f = new Fixture { DirectoriesOnly = true }) {
            var session = f.Create(); await session.StartAsync();
            Check(!session.InventoryEmpty && !session.CanRefreshEmptyInventory, "a saved directory also makes an inventory nonempty");
            f.DirectoriesOnly = false; await session.StartAsync();
            Check(f.Captures == 1 && !f.Log.Contains("engine-remove"), "directory-only inventory is never rotated or recaptured");
        }
        await using (var f = new Fixture { EmptyInventory = true }) {
            var first = f.Create(); await first.StartAsync(); await first.DisposeAsync();
            f.EmptyInventory = false;
            var before = File.ReadAllBytes(f.IndexPath); var restored = f.Create(); await restored.ReconnectCachedAsync();
            Check(f.Captures == 1 && restored.InventoryEmpty && !f.Log.Contains("engine-remove") && before.AsSpan().SequenceEqual(File.ReadAllBytes(f.IndexPath)),
                "cached startup/reconnect never refreshes even an empty saved generation");
        }
    }

    private static async Task CaptureDiagnostics()
    {
        await using var fixture = new Fixture {
            CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.FileResolution,
                CatalogCaptureBoundary.MetadataRequest, TransferFailureReason.UnexpectedHttpStatus, 503)
        };
        var session = fixture.Create();
        try { await session.StartAsync(); throw new InvalidOperationException("Expected the exact capture refusal."); }
        catch (CatalogCaptureException error) when (ReferenceEquals(error, fixture.CaptureFailure)) { }
        Check(session.Activity.Any(line => line.Contains("catalog/FileResolution/MetadataRequest/UnexpectedHttpStatus; HTTP 503", StringComparison.Ordinal)), "Activity omits bounded capture coordinate/status");
        Check(session.Activity.All(line => !line.Contains("No redirects", StringComparison.Ordinal) && !line.Contains(fixture.IndexPath, StringComparison.Ordinal)), "Activity exposes a path or implies a redirect cause");
        Check(!File.Exists(fixture.IndexPath) && fixture.EngineStarts == 0 && fixture.NativeActivations == 0 && fixture.Captures == 1,
            "Failed capture published ownership or activated Windows integration");
        foreach(var limit in new[]{CatalogCaptureLimit.EntryCount,CatalogCaptureLimit.PathOrDepth,CatalogCaptureLimit.PageCount,CatalogCaptureLimit.FileSize}) {
            await using var limited = new Fixture { CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.FolderListing,
                CatalogCaptureBoundary.ValidateInventory,TransferFailureReason.InvalidMetadata,null,limit) };
            Directory.CreateDirectory(Path.GetDirectoryName(limited.LocalSentinel)!);
            File.WriteAllText(limited.LocalSentinel, "preserved local data");
            var attempt=limited.Create();
            try { await attempt.StartAsync();throw new InvalidOperationException("Expected limit refusal."); }
            catch(CatalogCaptureException error) when(ReferenceEquals(error,limited.CaptureFailure)) { }
            var expected = limit switch {
                CatalogCaptureLimit.EntryCount => "This file list exceeds this version's limit of 1,000 files and folders. Ask your LedgeTop contact to review which folders are shared.",
                CatalogCaptureLimit.PathOrDepth => "A shared folder path or its nesting exceeds this version's limit. Ask your LedgeTop contact to review shared folder paths.",
                CatalogCaptureLimit.PageCount => "This file list requires more pages than this version supports. Ask your LedgeTop contact to review which folders are shared.",
                _ => "A file exceeds this version's 64 GiB file size limit. Ask your LedgeTop contact to review the shared files."
            };
            var fullMessage = expected + " Existing local files stay in their folders. Support code: " + limited.CaptureFailure!.SupportCode;
            Check(attempt.Activity.Any(line => line == fullMessage) && attempt.Activity.All(line => !line.Contains(limited.TestRoot,StringComparison.Ordinal)),
                "limit Activity is exact and redacted");
            Check(!File.Exists(limited.IndexPath) && limited.EngineStarts==0 && limited.NativeActivations==0 &&
                File.ReadAllText(limited.LocalSentinel) == "preserved local data",
                "limit refusal preserves local bytes before index publication and native activation");
        }
    }

    private static async Task UpdateIdentityBinding()
    {
        await using var fixture = new Fixture();
        var session = fixture.Create();
        await Refuses(async () => { _ = await session.GetUpdateBindingAsync(); });
        Check(fixture.Backends == 0 && fixture.SignIns == 0 && fixture.Captures == 0, "update identity cannot construct or sign into a disconnected source");
        await session.StartAsync();
        var before = File.ReadAllBytes(fixture.IndexPath);
        var signs = fixture.SignIns; var captures = fixture.Captures;
        var binding = await session.GetUpdateBindingAsync();
        Check(binding == new ConnectedExplorerUpdateBinding("pilot", "portal", Fixture.PersonA) &&
            fixture.SignIns == signs && fixture.Captures == captures && before.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
            "update identity checks the selected account without login, recapture or index mutation");
        await session.PauseAsync();
        Check(await session.GetUpdateBindingAsync() == binding, "a paused connected source retains the same verified update identity");
        fixture.HoldCurrent = true;
        using (var cancel = new CancellationTokenSource()) {
            var pending = session.GetUpdateBindingAsync(cancel.Token);
            Check(!pending.IsCompleted, "update identity waits for the fresh selected-session observation");
            cancel.Cancel();
            try { _ = await pending; throw new Exception("Cancelled identity check completed."); }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested) { }
            Check(session.State == ExplorerPreviewState.Paused && fixture.SignIns == signs && fixture.Captures == captures,
                "cancelled update identity checks stop without failing or restarting the connected source");
        }
        fixture.HoldCurrent = false;
        Check(await session.GetUpdateBindingAsync() == binding, "a cancelled identity check can retry with fresh proof");
        fixture.Person = Fixture.PersonB;
        await Refuses(async () => { _ = await session.GetUpdateBindingAsync(); });
        Check(session.State == ExplorerPreviewState.Failed && fixture.SignIns == signs && fixture.Captures == captures &&
            before.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)), "a changed account cannot export the old identity or rewrite its saved ownership");
    }

    private static async Task SelectionAndFrozenReopen()
    {
        await using var fixture = new Fixture();
        var first = fixture.Create();
        Check(fixture.Backends == 0 && fixture.SignIns == 0 && fixture.Captures == 0 && fixture.EngineStarts == 0, "construction performs no backend/auth/capture/start");
        await first.StartAsync();
        Check(first.State == ExplorerPreviewState.Running && fixture.Backends == 1 && fixture.SignIns == 1 && fixture.Captures == 1, "one explicit source signs in and captures");
        var text = File.ReadAllText(fixture.IndexPath);
        Check(!text.Contains("https://", StringComparison.Ordinal) && !text.Contains("odqr1_", StringComparison.Ordinal) && !text.Contains("token", StringComparison.OrdinalIgnoreCase), "index contains no URLs/resource references/tokens");
        await first.PauseAsync(); await first.ResumeAsync();
        Check(fixture.SignIns == 1 && fixture.EnginePauses == 1 && fixture.EngineResumes == 1, "resume uses cached session only");
        await first.DisposeAsync();
        Check(fixture.Log.IndexOf("engine-dispose") < fixture.Log.IndexOf("backend-dispose"), "native owner drains before backend");
        var before = fixture.Captures; var authBefore = fixture.SignIns; var backendBefore = fixture.Backends;
        var reopened = fixture.Create();
        Check(fixture.Backends == backendBefore && fixture.SignIns == authBefore, "frozen constructor is offline");
        await reopened.StartAsync();
        Check(fixture.Captures == before && fixture.SignIns == authBefore + 1, "frozen ready generation reconnects without recapture");
        await reopened.RemoveAsync();
        fixture.Version = "new-version";
        await reopened.StartAsync();
        Check(fixture.Captures == before + 1, "only explicit removal permits fresh capture/version generation");
        await using (var empty = new Fixture { EmptyInventory = true }) {
            var connectedEmpty = empty.Create(); await connectedEmpty.StartAsync();
            Check(connectedEmpty.State == ExplorerPreviewState.Running && connectedEmpty.InventoryEmpty &&
                connectedEmpty.Activity.Any(line => line.Contains("saved file list is empty", StringComparison.Ordinal)),
                "authorized empty source connects with an explicit empty-sharing explanation instead of a failure");
        }
        foreach (var wrong in new[] { "alias", "origin", "multiple" }) {
            await using var refused = new Fixture { WrongConfiguration = wrong };
            var session = refused.Create();
            await Refuses(session.StartAsync);
            Check(refused.SignIns == 0 && refused.Captures == 0 && refused.EngineStarts == 0, "invalid selected source refuses before browser/capture");
            await session.RemoveAsync();
            Check(refused.BackendDisposals == 1, "failed pre-index connection still disposes backend on Remove");
        }
    }

    private static async Task ForeignPersonAndOfflineRemoval()
    {
        await using var fixture = new Fixture();
        var first = fixture.Create(); await first.StartAsync(); await first.DisposeAsync();
        var original = File.ReadAllBytes(fixture.IndexPath);
        fixture.Person = Fixture.PersonB;
        var second = fixture.Create();
        await Refuses(second.StartAsync);
        Check(original.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)), "foreign principal cannot overwrite cleanup index");
        Check(fixture.Captures == 1 && fixture.EngineStarts == 1, "foreign account never captures or starts another root");
        await second.DisposeAsync();
        var backendBefore = fixture.Backends; var authBefore = fixture.SignIns; var requestsBefore = fixture.Requests;
        fixture.ThrowIfBackendCreated = true;
        var cleanup = fixture.Create(); await cleanup.RemoveAsync();
        Check(cleanup.State == ExplorerPreviewState.Removed && fixture.Backends == backendBefore && fixture.SignIns == authBefore && fixture.Requests == requestsBefore,
            "startup Remove needs no backend/helper/session/metadata/byte calls");
    }

    private static async Task OwnershipRefusals()
    {
        await using (var fixture = new Fixture()) {
            Directory.CreateDirectory(Path.GetDirectoryName(fixture.IndexPath)!);
            var marker = Path.Combine(Path.GetDirectoryName(fixture.IndexPath)!, "foreign.txt"); await File.WriteAllTextAsync(marker, "retain");
            var refused = fixture.Create(); await Refuses(refused.StartAsync); await Refuses(refused.RemoveAsync);
            Check(fixture.Backends == 0 && File.ReadAllText(marker) == "retain" && !File.Exists(fixture.IndexPath), "unowned index directory is not adopted");
        }
        await using (var fixture = new Fixture()) {
            var session = fixture.Create(); await session.StartAsync(); await session.DisposeAsync();
            var bytes = File.ReadAllBytes(fixture.IndexPath);
            var otherOrigin = fixture.Create(new Uri("https://other.invalid"));
            await Refuses(otherOrigin.StartAsync); await Refuses(otherOrigin.RemoveAsync);
            Check(bytes.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)) && fixture.SignIns == 1, "origin drift cannot adopt or rewrite saved connection");
        }
    }

    private static async Task FailedStartRetainsCleanup()
    {
        await using var fixture = new Fixture { FailEngineStart = true };
        var session = fixture.Create(); await Refuses(session.StartAsync);
        Check(File.Exists(fixture.IndexPath) && session.State == ExplorerPreviewState.Failed, "cleanup index is durable before native Start attempt");
        Check(session.Activity.Any(line => line.Contains("ownership review", StringComparison.OrdinalIgnoreCase)) &&
            !session.Activity.Any(line => line.Contains("private-fixture-detail", StringComparison.Ordinal)),
            "local setup failure supplies safe next action without arbitrary exception text");
        var requests = fixture.Requests; var signs = fixture.SignIns;
        await session.RemoveAsync();
        Check(session.State == ExplorerPreviewState.Removed && fixture.Requests == requests && fixture.SignIns == signs, "failed setup is removable without authentication");
    }

    private static async Task CancelLogin()
    {
        await using var fixture = new Fixture { HoldLogin = true };
        var session = fixture.Create(); var start = session.StartAsync();
        await fixture.LoginEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var closing = session.DisposeAsync().AsTask();
        await Cancelled(start); await closing.WaitAsync(TimeSpan.FromSeconds(3));
        Check(fixture.Captures == 0 && fixture.EngineStarts == 0 && fixture.BackendDisposals == 1 && !File.Exists(fixture.IndexPath),
            "quit cancels browser helper before capture/start and drains backend");
    }
    private static async Task CancelCapture()
    {
        await using var fixture = new Fixture { HoldCapture = true };
        var session = fixture.Create(); var start = session.StartAsync();
        await fixture.CaptureEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var closing = session.DisposeAsync().AsTask();
        await Cancelled(start); await closing.WaitAsync(TimeSpan.FromSeconds(3));
        Check(fixture.EngineStarts == 0 && fixture.BackendDisposals == 1 && !File.Exists(fixture.IndexPath), "quit cancels capture before index/native publication");
    }
    private static async Task LateLoginNeverActivates()
    {
        await using var fixture = new Fixture { HoldLogin = true, IgnoreLoginCancellation = true };
        var session = fixture.Create(); var start = session.StartAsync();
        await fixture.LoginEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var closing = session.DisposeAsync().AsTask();
        Check(!closing.IsCompleted, "ownership waits for late helper completion");
        fixture.LoginRelease.TrySetResult();
        await Cancelled(start); await closing.WaitAsync(TimeSpan.FromSeconds(3));
        Check(fixture.Captures == 0 && fixture.EngineStarts == 0 && fixture.BackendDisposals == 1, "late cancelled sign-in cannot activate Explorer");
    }

    private static async Task RuntimeRevalidation()
    {
        foreach (var failure in new[] { "expiry", "person", "role" }) {
            await using var fixture = new Fixture();
            var session = fixture.Create(); await session.StartAsync(); var signs = fixture.SignIns;
            if (failure == "expiry") fixture.Expired = true;
            if (failure == "person") fixture.Person = Fixture.PersonB;
            if (failure == "role") fixture.AccessDenied = true;
            await Refuses(session.RecheckSessionAsync);
            Check(session.State == ExplorerPreviewState.Failed && fixture.EnginePauses == 1 && fixture.SignIns == signs, "runtime loss pauses provider without browser sign-in");
        }
        await using var held = new Fixture();
        var current = held.Create(); await current.StartAsync(); held.HoldCurrent = true;
        var recheck = current.RecheckSessionAsync(); await held.CurrentEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var stop = current.DisposeAsync().AsTask();
        await Cancelled(recheck); await stop.WaitAsync(TimeSpan.FromSeconds(3));
        Check(held.BackendDisposals == 1, "quit cancels a cached metadata recheck too");
    }

    private static async Task CancelEngineDefaultTokenRead()
    {
        await using var fixture = new Fixture { HoldEngineSession = true };
        var session = fixture.Create(); var start = session.StartAsync();
        await fixture.EngineSessionEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        try {
            var closing = session.DisposeAsync().AsTask();
            await Cancelled(start); await closing.WaitAsync(TimeSpan.FromSeconds(3));
            Check(fixture.EngineStarts == 1 && fixture.NativeActivations == 0 && fixture.BackendDisposals == 1,
                "quit cancels engine default-token cached read before native activation/backend disposal");
            Check(fixture.Log.IndexOf("engine-dispose") < fixture.Log.IndexOf("backend-dispose"), "engine drain still precedes backend release after cancellation");
        } finally { fixture.EngineSessionRelease.TrySetResult(); }

        await using var retryFixture = new Fixture { FailFirstRunningDispose = true, VerifyEngineSession = true };
        var retry = retryFixture.Create(); await retry.StartAsync();
        var oldSource = retryFixture.StartedSources.Single();
        await Refuses(() => retry.DisposeAsync().AsTask());
        Check(retryFixture.BackendDisposals == 0, "uncertain engine drain retains its backend");
        await retry.StartAsync();
        Check(retry.State == ExplorerPreviewState.Running && retryFixture.SignIns == 2 && retryFixture.Captures == 1,
            "explicit retry creates a fresh cancellation generation and reopens the frozen inventory");
        await Cancelled(oldSource.GetSessionAsync());
    }

    private static async Task DurableRemovalBeforeProfileCreation()
    {
        await using (var fixture = new Fixture { FailEngineBeforeProfile = true }) {
            var first = fixture.Create(); await Refuses(first.StartAsync); await first.DisposeAsync();
            var bytes = File.ReadAllBytes(fixture.IndexPath); var backends = fixture.Backends;
            var ambiguous = fixture.Create();
            Check(ambiguous.State == ExplorerPreviewState.Failed, "missing receipt plus existing index requires ownership review");
            await Refuses(ambiguous.StartAsync); await Refuses(ambiguous.RemoveAsync);
            Check(fixture.Backends == backends && bytes.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
                "ambiguous missing profile never authenticates, recaptures, removes or publishes cleanup confirmation");
        }
        await using (var fixture = new Fixture { FailEnginePreparedAuth = true }) {
            var first = fixture.Create(); await Refuses(first.StartAsync);
            Check(File.Exists(fixture.IndexPath) && fixture.NativeActivations == 0, "prepared preflight failure retains positive cleanup receipt without activation");
            await first.RemoveAsync(); await first.DisposeAsync();
            Check(JsonNode.Parse(File.ReadAllText(fixture.IndexPath))!["Removed"]!.GetValue<bool>(), "confirmed prepared-profile removal publishes durable confirmation");
            fixture.ForgetRemovedProfiles();
            fixture.FailEnginePreparedAuth = false; fixture.Person = Fixture.PersonB;
            var reopened = fixture.Create();
            Check(reopened.State == ExplorerPreviewState.Removed, "restarted missing profile restores confirmed removal");
            await reopened.StartAsync(); await reopened.DisposeAsync();
            var current = JsonNode.Parse(File.ReadAllText(fixture.IndexPath))!;
            Check(reopened.State == ExplorerPreviewState.NotStarted && current["PrincipalId"]!.GetValue<string>() == Fixture.PersonB &&
                !current["Removed"]!.GetValue<bool>() && fixture.NativeActivations == 1,
                "new account can connect after durable missing-profile removal and resets confirmation");

            current["Removed"] = true; File.WriteAllText(fixture.IndexPath, current.ToJsonString());
            var contradictory = File.ReadAllBytes(fixture.IndexPath); var backends = fixture.Backends;
            fixture.ThrowIfBackendCreated = true;
            var refused = fixture.Create();
            Check(refused.State == ExplorerPreviewState.Failed, "removed index plus frozen active profile fails ownership validation");
            await Refuses(refused.StartAsync); await Refuses(refused.RemoveAsync);
            Check(fixture.Backends == backends && contradictory.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
                "contradictory removal never authenticates or rewrites retained ownership");
        }
        await using (var fixture = new Fixture()) {
            var first = fixture.Create(); await first.StartAsync(); await first.RemoveAsync(); await first.DisposeAsync();
            var current = JsonNode.Parse(File.ReadAllText(fixture.IndexPath))!;
            // Simulate a crash after the engine's durable Removed phase, before the coordinator index publication.
            current.AsObject().Remove("Removed"); File.WriteAllText(fixture.IndexPath, current.ToJsonString());
            fixture.Person = Fixture.PersonB;
            var reopened = fixture.Create();
            Check(reopened.State == ExplorerPreviewState.Removed, "engine durable removal remains positive evidence with legacy absent index flag");
            await reopened.StartAsync();
            Check(reopened.State == ExplorerPreviewState.Running && fixture.Captures == 2, "engine-confirmed removal permits another account and fresh inventory");
        }
    }

    private static async Task CachedReconnect()
    {
        await using (var fixture = new Fixture()) {
            var first = fixture.Create(); await first.StartAsync(); await first.PauseAsync(); await first.DisposeAsync();
            var bytes = File.ReadAllBytes(fixture.IndexPath); var signs = fixture.SignIns; var captures = fixture.Captures;
            var restored = fixture.Create();
            Check(restored.CanReconnectCached, "validated disconnected frozen connection exposes cached reconnect capability");
            await restored.ReconnectCachedAsync();
            Check(restored.State == ExplorerPreviewState.Running && fixture.EngineResumes == 1 && fixture.SignIns == signs && fixture.Captures == captures &&
                bytes.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
                "fresh same-principal cached reconnect resumes legacy pause without login, capture or index publication");
            await restored.DisposeAsync();
            foreach (var failure in new[] { "expired", "person", "role" }) {
                fixture.Expired = failure == "expired"; fixture.Person = failure == "person" ? Fixture.PersonB : Fixture.PersonA;
                fixture.AccessDenied = failure == "role";
                var starts = fixture.EngineStarts; var denied = fixture.Create(); await Refuses(denied.ReconnectCachedAsync);
                Check(fixture.SignIns == signs && fixture.Captures == captures && fixture.EngineStarts == starts &&
                    bytes.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath)),
                    "cached authorization loss cannot sign in, activate, capture or replace the saved principal");
                await denied.DisposeAsync();
            }
            fixture.ThrowIfBackendCreated = true;
            var offline = fixture.Create(); await offline.RemoveAsync();
            Check(offline.State == ExplorerPreviewState.Removed, "failed cached checks retain exact offline cleanup");
            var backends = fixture.Backends; var removed = fixture.Create(); await Refuses(removed.ReconnectCachedAsync);
            Check(fixture.Backends == backends, "removed generation refuses cached reconnect before backend creation");
        }
        foreach (var kind in new[] { "absent", "prepared", "missing", "corrupt" }) {
            await using var fixture = new Fixture { FailEnginePreparedAuth = kind == "prepared", FailEngineBeforeProfile = kind == "missing" };
            if (kind != "absent") {
                var seed = fixture.Create();
                if (kind == "corrupt") { await seed.StartAsync(); await seed.DisposeAsync(); File.WriteAllText(fixture.IndexPath, "{}"); }
                else { await Refuses(seed.StartAsync); await seed.DisposeAsync(); }
            }
            var before = File.Exists(fixture.IndexPath) ? File.ReadAllBytes(fixture.IndexPath) : null;
            var backends = fixture.Backends; fixture.ThrowIfBackendCreated = true;
            var refused = fixture.Create();
            Check(!refused.CanReconnectCached, "absent/incomplete/ambiguous/corrupt ownership never exposes the settings reconnect capability");
            await Refuses(refused.ReconnectCachedAsync);
            Check(fixture.Backends == backends && (before is null ? !File.Exists(fixture.IndexPath) : before.AsSpan().SequenceEqual(File.ReadAllBytes(fixture.IndexPath))),
                "absent/incomplete/ambiguous/corrupt cache refuses before backend and leaves ownership unchanged");
        }
        await using (var fixture = new Fixture()) {
            var seed = fixture.Create(); await seed.StartAsync(); await seed.DisposeAsync();
            var signs = fixture.SignIns; fixture.HoldCurrent = true;
            var restored = fixture.Create(); var reconnect = restored.ReconnectCachedAsync();
            await fixture.CurrentEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var closing = restored.DisposeAsync().AsTask(); await Cancelled(reconnect); await closing.WaitAsync(TimeSpan.FromSeconds(3));
            Check(fixture.SignIns == signs && fixture.EngineStarts == 1 && fixture.Captures == 1 && fixture.BackendDisposals == 2,
                "quit cancels cached reconnect metadata without browser, capture or activation and drains backend");
        }
    }

    private static async Task Refuses(Func<Task> action)
    {
        try { await action().WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (Exception error) when (error is AccessDeniedException or IOException or LoginRequiredException) { return; }
        throw new InvalidOperationException("Expected a fail-closed connection refusal.");
    }
    private static async Task Cancelled(Task action)
    {
        try { await action.WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (OperationCanceledException) { return; }
        throw new InvalidOperationException("Expected a cancelled pending connection action.");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    internal sealed class Fixture : IAsyncDisposable
    {
        internal static readonly string PersonA = "odqp1_" + new string('a', 64), PersonB = "odqp1_" + new string('b', 64);
        private readonly string root = Path.Combine(Path.GetTempPath(), "ltfiles-connected-coordinator-" + Guid.NewGuid().ToString("N"));
        private readonly Dictionary<string, Saved> profiles = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<ConnectedExplorerSession> sessions = [];
        private FakeEngine? lastEngine;
        private ExplorerRootManifest? visibleManifestOverride;
        private readonly System.Collections.Concurrent.ConcurrentDictionary<int, int> stateReads = new();
        internal readonly List<string> Log = [];
        internal readonly List<IQueuedDownloadSource> StartedSources = [];
        internal string Person = PersonA, Version = "version-one", Reference = "odqr1_reference", WrongConfiguration = "", Alias = "portal";
        internal bool HoldLogin, HoldCapture, HoldCurrent, HoldEngineSession, HoldSourceSession, IgnoreLoginCancellation, Expired, AccessDenied, FailEngineStart, ThrowIfBackendCreated, EmptyInventory,
            FailFirstRunningDispose, RunningDisposeRefused, VerifyEngineSession, FailEngineBeforeProfile, FailEnginePreparedAuth, RefusePause;
        internal bool SyntheticColdAdmission, FailBackendDisposalOnce, WrongSnapshotScope;
        internal CatalogCaptureException? CaptureFailure;
        internal Exception? CurrentFailure, SourceFailure, ResumeFailure;
        internal Action? AfterCapture, AfterRemove, BeforeOwnedReceipt, BeforeResumeFailure;
        internal bool ThrowDisposedObservation;
        internal bool UnconfirmedRemove, DirectoriesOnly;
        internal string LocalSentinel => Path.Combine(root, "Files", "added-local.txt");
        internal string TestRoot => root;
        internal IExplorerPreviewSession CurrentEngine => lastEngine ?? throw new InvalidOperationException();
        internal int Backends, SignIns, Captures, EngineStarts, EnginePauses, EngineResumes, BackendDisposals, Requests, NativeActivations, EngineRetries;
        internal readonly TaskCompletionSource LoginEntered = new(TaskCreationOptions.RunContinuationsAsynchronously), LoginRelease = new(TaskCreationOptions.RunContinuationsAsynchronously),
            CaptureEntered = new(TaskCreationOptions.RunContinuationsAsynchronously), CaptureRelease = new(TaskCreationOptions.RunContinuationsAsynchronously),
            CaptureWaitEntered = new(TaskCreationOptions.RunContinuationsAsynchronously),
            CurrentEntered = new(TaskCreationOptions.RunContinuationsAsynchronously), CurrentRelease = new(TaskCreationOptions.RunContinuationsAsynchronously),
            EngineSessionEntered = new(TaskCreationOptions.RunContinuationsAsynchronously), EngineSessionRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal string IndexPath => Path.Combine(root, "State", "connected-explorer-pilot-" + Alias, "current.json");
        private static readonly Uri Origin = new("https://coordinator.invalid");
        internal Fixture() => Directory.CreateDirectory(root);
        internal void ChangeSavedManifest()
        {
            var saved = profiles.Values.Single(item => !item.Removed);
            saved.Manifest = new ExplorerRootManifest(saved.Manifest.Scope, new Dictionary<string, PlaceholderIdentity>(), ["changed"]);
        }
        internal void ForceEngineState(ExplorerPreviewState state) => (lastEngine ?? throw new InvalidOperationException()).ForceState(state);
        internal void AddEngineActivity(string text) => (lastEngine ?? throw new InvalidOperationException()).AddActivity(text);
        internal void EmitEngineActivity() => (lastEngine ?? throw new InvalidOperationException()).EmitChanged();
        internal Task EmitWithBlockedStateRead(StateReadBarrier barrier)
        {
            var owned = lastEngine ?? throw new InvalidOperationException();
            return Task.Run(() => owned.EmitWithBlockedStateRead(barrier));
        }
        internal int StateReadsOnThread(int thread) => stateReads.GetValueOrDefault(thread);
        internal void ChangeVisibleManifest()
        {
            var saved = profiles.Values.Single(item => !item.Removed);
            visibleManifestOverride = new ExplorerRootManifest(saved.Manifest.Scope, new Dictionary<string, PlaceholderIdentity>(), ["changed"]);
        }
        internal void ForgetRemovedProfiles()
        {
            if (profiles.Values.Any(profile => !profile.Removed)) throw new InvalidOperationException("Only confirmed removed test profiles may be forgotten.");
            profiles.Clear();
        }
        internal ConnectedExplorerSession Create(Uri? origin = null, SyntheticFirstTransitionHooks? transition = null)
        {
            var session = new ConnectedExplorerSession(() => {
                if (ThrowIfBackendCreated) throw new InvalidOperationException("No backend may be created for offline cleanup.");
                Backends++; return new Backend(this);
            }, "pilot", Alias, origin ?? Origin, Path.Combine(root, "State"), Path.Combine(root, "Files"), CreateEngine, Capture,
                () => SyntheticColdAdmission, transition);
            sessions.Add(session); return session;
        }
        private ConnectedExplorerEngine CreateEngine(ConnectedExplorerEngineRequest request)
        {
            profiles.TryGetValue(request.ProfileDirectory, out var saved);
            var fake = new FakeEngine(this, request, saved);
            lastEngine = fake;
            ExplorerRootManifest? Manifest() => visibleManifestOverride ?? request.InitialManifest ?? (saved?.Removed == false ? saved.Manifest : null);
            return new(fake, Manifest,
                () => { BeforeOwnedReceipt?.Invoke(); return profiles.ContainsKey(request.ProfileDirectory); },
                () => { var m = Manifest() ?? throw new IOException(); return new(Guid.Parse("11111111-1111-1111-1111-111111111111"), request.ProfileDirectory,
                    request.PreferredRoot, 1, Guid.Parse("22222222-2222-2222-2222-222222222222"), m.Digest, m.Scope, 1); });
        }
        private async Task<ExplorerCatalogSnapshot> Capture(IFilesBackend backend, string channel, string expected, CancellationToken token)
        {
            Captures++; CaptureEntered.TrySetResult();
            if (CaptureFailure is { } failure) throw failure;
            if (HoldCapture) { CaptureWaitEntered.TrySetResult(); await CaptureRelease.Task.WaitAsync(token); }
            var source = backend.Sources.Single();
            AfterCapture?.Invoke();
            if (EmptyInventory || DirectoriesOnly) return new(expected, channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority),
                new Dictionary<string, PlaceholderIdentity>(), DirectoriesOnly ? ["shared"] : []);
            var id = new PlaceholderIdentity(channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority), expected,
                Reference, "ondf1_" + new string('c', 64), Version, "sample.txt", 0, "\"etag\"", new string('d', 64));
            return new(expected, WrongSnapshotScope ? "stable" : channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority),
                new Dictionary<string, PlaceholderIdentity> { ["sample.txt"] = id }, []);
        }
        private DateTimeOffset Expiry => DateTimeOffset.UtcNow.AddHours(Expired ? -1 : 1);
        private sealed class Backend : IFilesBackend
        {
            private readonly Fixture fixture;
            private bool disposed;
            internal Backend(Fixture fixture)
            {
                this.fixture = fixture; Session = new Gateway(fixture); Catalog = new Catalog();
                var source = new Source(fixture);
                Sources = fixture.WrongConfiguration == "multiple" ? [source, source] : [source];
            }
            public ISessionGateway Session { get; }
            public IFileCatalog Catalog { get; }
            public IReadOnlyList<IQueuedDownloadSource> Sources { get; }
            public string StateDirectory => Path.Combine(fixture.root, "unused-queue");
            public ValueTask DisposeAsync() {
                if (fixture.FailBackendDisposalOnce) { fixture.FailBackendDisposalOnce = false; throw new IOException("Injected backend disposal failure."); }
                if (!disposed) { disposed = true; fixture.BackendDisposals++; fixture.Log.Add("backend-dispose"); } return ValueTask.CompletedTask;
            }
        }
        private sealed class Gateway(Fixture fixture) : ISessionGateway, IConnectionSessionGateway
        {
            public async Task SignInAsync(CancellationToken cancellationToken = default)
            {
                fixture.SignIns++; fixture.LoginEntered.TrySetResult();
                if (fixture.HoldLogin) {
                    if (fixture.IgnoreLoginCancellation) await fixture.LoginRelease.Task;
                    else await fixture.LoginRelease.Task.WaitAsync(cancellationToken);
                }
            }
            public async Task<SessionInfo?> TryCurrentAsync(CancellationToken cancellationToken = default)
            {
                try { return await CheckCurrentForConnectionAsync(cancellationToken); }
                catch (LoginRequiredException) { return null; }
            }
            public async Task<SessionInfo?> CheckCurrentForConnectionAsync(CancellationToken cancellationToken = default)
            {
                fixture.Log.Add("current-check");
                fixture.Requests++;
                if (fixture.HoldCurrent) { fixture.CurrentEntered.TrySetResult(); await fixture.CurrentRelease.Task.WaitAsync(cancellationToken); }
                if (fixture.AccessDenied) throw new AccessDeniedException();
                if (fixture.CurrentFailure is { } failure) throw failure;
                return new(fixture.Person, fixture.Expiry);
            }
        }
        private sealed class Source(Fixture fixture) : IQueuedDownloadSource
        {
            public string Alias => fixture.WrongConfiguration == "alias" ? fixture.Alias == "portal" ? "employee" : "portal" : fixture.Alias;
            public Uri Origin => fixture.WrongConfiguration == "origin" ? new("https://wrong.invalid") : Fixture.Origin;
            public async Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
            {
                fixture.Log.Add("source-check");
                fixture.Requests++; cancellationToken.ThrowIfCancellationRequested();
                if (fixture.HoldSourceSession) { fixture.EngineSessionEntered.TrySetResult(); await fixture.EngineSessionRelease.Task.WaitAsync(cancellationToken); }
                if (fixture.AccessDenied) throw new AccessDeniedException();
                if (fixture.SourceFailure is { } failure) throw failure;
                return new QueuedDownloadSession(fixture.Person, fixture.Expiry);
            }
            public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default) => throw new InvalidOperationException("No source resolution in coordinator fake tests.");
            public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException("No byte transfers in coordinator fake tests.");
        }
        private sealed class Catalog : IFileCatalog
        {
            public Task<IReadOnlyList<CatalogNode>> GetSectionsAsync(CancellationToken cancellationToken = default) => throw new InvalidOperationException();
            public Task<NodePage> GetChildrenAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException();
            public Task<CatalogListing> ListAsync(CatalogNode folder, object? more = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException();
            public Task<string> GetReferenceAsync(CatalogFile file, CancellationToken cancellationToken = default) => throw new InvalidOperationException();
        }
        private sealed class Saved(ExplorerRootManifest manifest) { internal ExplorerRootManifest Manifest = manifest; internal bool Removed, Failed, Paused; }
        private sealed class FakeEngine : IExplorerPreviewSession, IAvailabilityRetry, IOrderedActivitySource
        {
            private readonly Fixture fixture; private readonly ConnectedExplorerEngineRequest request; private Saved? saved; private bool disposed;
            private ExplorerPreviewState currentState;
            private StateReadBarrier? stateReadBarrier;
            internal FakeEngine(Fixture fixture, ConnectedExplorerEngineRequest request, Saved? saved)
            { this.fixture = fixture; this.request = request; this.saved = saved; State = saved?.Removed == true ? ExplorerPreviewState.Removed : saved?.Failed == true ? ExplorerPreviewState.Failed : ExplorerPreviewState.NotStarted; }
            public string RootPath => request.PreferredRoot;
            public ExplorerPreviewState State {
                get {
                    if (disposed && fixture.ThrowDisposedObservation) throw new ObjectDisposedException(nameof(FakeEngine));
                    var thread = Environment.CurrentManagedThreadId;
                    fixture.stateReads.AddOrUpdate(thread, 1, (_, count) => count + 1);
                    var snapshot = currentState;
                    var barrier = Volatile.Read(ref stateReadBarrier);
                    if (barrier is not null && barrier.Thread == thread) {
                        barrier.Entered.TrySetResult();
                        if (!barrier.Release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Synthetic engine State read release required.");
                    }
                    return snapshot;
                }
                private set => currentState = value;
            }
            private readonly OrderedActivity activity = new();
            public IReadOnlyList<ActivityEntry> ActivityEntries => activity.Snapshot();
            public IReadOnlyList<string> Activity => ActivityEntries.Select(entry => entry.Text).ToArray();
            internal void AddActivity(string text) { activity.Add(text); Changed?.Invoke(this, EventArgs.Empty); }
            public bool CanRetryAvailability => !disposed && State == ExplorerPreviewState.Running;
            public Task RetryAvailabilityAsync() { if (!CanRetryAvailability) throw new InvalidOperationException(); fixture.EngineRetries++; return Task.CompletedTask; }
            public event EventHandler? Changed;
            public async Task StartAsync()
            {
                fixture.EngineStarts++;
                fixture.StartedSources.Add(request.Source);
                if (fixture.FailEngineBeforeProfile) throw new LoginRequiredException();
                var frozen = request.InitialManifest ?? saved?.Manifest ?? throw new IOException("No frozen inventory.");
                var paused = saved is { Removed: false, Paused: true };
                saved = new(frozen) { Paused = paused }; fixture.profiles[request.ProfileDirectory] = saved;
                if (fixture.FailEnginePreparedAuth) { saved.Failed = true; State = ExplorerPreviewState.Failed; throw new LoginRequiredException(); }
                if (fixture.HoldEngineSession) {
                    fixture.HoldSourceSession = true;
                }
                if (fixture.HoldEngineSession || fixture.VerifyEngineSession)
                    await request.Source.GetSessionAsync(); // Deliberately no caller token, matching the root engine's cached preflight.
                if (fixture.FailEngineStart) { saved.Failed = true; State = ExplorerPreviewState.Failed; throw new IOException("private-fixture-detail: synthetic partial setup."); }
                fixture.NativeActivations++;
                State = saved.Paused ? ExplorerPreviewState.Paused : ExplorerPreviewState.Running; Changed?.Invoke(this, EventArgs.Empty);
            }
            public Task PauseAsync() {
                fixture.EnginePauses++; if (fixture.RefusePause) throw new IOException("Synthetic pause not confirmed.");
                if (saved is not null) saved.Paused = true; State = ExplorerPreviewState.Paused; Changed?.Invoke(this, EventArgs.Empty); return Task.CompletedTask;
            }
            public async Task ResumeAsync() {
                fixture.EngineResumes++; fixture.Log.Add("resume-gate");
                if (fixture.VerifyEngineSession) await request.Source.GetSessionAsync();
                if (fixture.ResumeFailure is { } failure) { fixture.BeforeResumeFailure?.Invoke(); throw failure; }
                if (saved is not null) saved.Paused = false; State = ExplorerPreviewState.Running; fixture.Log.Add("engine-resumed"); Changed?.Invoke(this, EventArgs.Empty);
            }
            internal void ForceState(ExplorerPreviewState value) { State = value; Changed?.Invoke(this, EventArgs.Empty); }
            internal void EmitChanged() => Changed?.Invoke(this, EventArgs.Empty);
            internal void EmitWithBlockedStateRead(StateReadBarrier barrier)
            {
                barrier.Thread = Environment.CurrentManagedThreadId; Volatile.Write(ref stateReadBarrier, barrier);
                try { EmitChanged(); } finally { Volatile.Write(ref stateReadBarrier, null); }
            }
            public Task RemoveAsync() { if (saved is not null) saved.Removed = !fixture.UnconfirmedRemove; State = fixture.UnconfirmedRemove ? ExplorerPreviewState.Failed : ExplorerPreviewState.Removed; fixture.Log.Add("engine-remove"); fixture.AfterRemove?.Invoke(); Changed?.Invoke(this, EventArgs.Empty); return Task.CompletedTask; }
            public ValueTask DisposeAsync()
            {
                if (!disposed) {
                    if (fixture.FailFirstRunningDispose && !fixture.RunningDisposeRefused && State == ExplorerPreviewState.Running) {
                        fixture.RunningDisposeRefused = true; throw new IOException("Synthetic uncertain running-engine disposal.");
                    }
                    disposed = true; fixture.Log.Add("engine-dispose");
                }
                return ValueTask.CompletedTask;
            }
        }
        public async ValueTask DisposeAsync()
        {
            LoginRelease.TrySetResult(); CaptureRelease.TrySetResult(); CurrentRelease.TrySetResult(); EngineSessionRelease.TrySetResult();
            foreach (var session in sessions) await session.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            var full = Path.GetFullPath(root);
            if (!full.StartsWith(Path.GetFullPath(Path.GetTempPath()) + "ltfiles-connected-coordinator-", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Refusing unexpected coordinator test cleanup path.");
            Directory.Delete(full, true);
        }
    }    private sealed class SyntheticRegistration(string root) : IPreviewRootRegistration {
        public string Root => root;public void VerifyOwned() {} public void Unregister()=>throw new InvalidOperationException("Synthetic registration cannot mutate");
    }

}
