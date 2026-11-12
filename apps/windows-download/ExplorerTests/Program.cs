using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

if (args.Length == 1 && args[0] == "--held-broker-decision-tests") return HeldShellBrokerProbe.DecisionTests();
if (args.Length >= 1 && args[0] == "--held-broker-probe") {
    if (args.Length != 2 || Environment.GetEnvironmentVariable("LEDGETOP_HELD_BROKER_PROBE") != "1") return 2;
    return await HeldShellBrokerProbe.RunAsync(args[1]);
}
if (args.Length == 1 && args[0] == "--held-root-registration-decision-tests") return HeldRootRegistrationProbe.DecisionTests();
if (args.Length >= 1 && args[0] == "--held-root-registration-probe") {
    if (args.Length != 2 || Environment.GetEnvironmentVariable("LEDGETOP_HELD_ROOT_PROBE") != "1") return 2;
    return HeldRootRegistrationProbe.Run(args[1]);
}
if (args.Length == 1 && args[0] == "--typed-hydration-retention-tests") return await TypedHydrationRetentionTests.RunAsync();
if (args.Length == 1 && args[0] == "--hydration-activity-tests") return await HydrationActivityTests.RunAsync();
#if LEDGETOP_NATIVE_DIAGNOSTICS
#if LEDGETOP_CACHE_RACE_TEST
if (args.Length == 1 && args[0] == "--synthetic-owned-source-contract-tests") return await SyntheticMemoryNative.OwnedSourceContractTests();
#endif
if (args.Length == 1 && args[0] == "--synthetic-reader-evidence-tests") return await SyntheticReaderEvidence.SelfTestsAsync();
if (args.Length == 3 && args[0] == "--synthetic-reader-evidence-child")
    return await SyntheticReaderEvidence.SendAsync(args[1], args[2], "sample-1.bin", "IOException", unchecked((int)0x80070185)) ? 1 : 2;
if (args.Length == 1 && args[0] == "--synthetic-memory-cache-stage-tests") return await SyntheticMemoryNative.CacheStageTests();
if (args.Length >= 1 && args[0] == "--synthetic-memory-inspect-tests") return args.Length == 1 ? SyntheticMemoryInspection.Tests() : 2;
if (args.Length >= 1 && args[0] == "--synthetic-memory-inspect") return args.Length == 2 ? SyntheticMemoryInspection.Run(args[1]) : 2;
if (args.Length >= 1 && args[0] == "--synthetic-memory-cleanup") return args.Length == 3 ? SyntheticMemoryInspection.Cleanup(args[1], args[2]) : 2;
if (args.Length == 1 && args[0] == "--synthetic-memory-marker-reader-tests") return SyntheticMemoryNative.MarkerReadScopeTests();
if (args.Length == 3 && args[0] == "--synthetic-memory-marker-read" && Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE") == "1")
    return SyntheticMemoryNative.MarkerRead(args[1], args[2]);
if (args.Length == 1 && args[0] == "--synthetic-memory-native-marker-tests") return SyntheticMemoryNative.MarkerIoTests();
if (args.Length == 1 && args[0] == "--synthetic-memory-native-cleanup-tests") return SyntheticMemoryNative.CleanupEvidenceTests();
if (args.Length is 4 or 6 && args[0] == "--synthetic-memory-native-reader" && Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE") == "1")
    return await SyntheticMemoryNative.Reader(args[1], args[2], args[3], args.Length == 6 ? args[4] : null, args.Length == 6 ? args[5] : null);
if (args.Length == 2 && args[0] == "--synthetic-memory-native" && int.TryParse(args[1], out var memoryProbeCount)) return await SyntheticMemoryNative.RunAsync(memoryProbeCount);
if (args.Length == 1 && args[0] == "--synthetic-memory-native-retry") return await SyntheticMemoryNative.RunAsync(1, retryProbe: true);
if (args.Length == 1 && args[0] == "--diagnostic-connect-flags-tests") {
    var calls = new List<uint>();
    int Fake(uint flags) { calls.Add(flags); return 37; }
    if (DiagnosticConnectionFlags.Connect(Fake, false) != 37 || DiagnosticConnectionFlags.Connect(Fake, true) != 37 ||
        DiagnosticConnectionFlags.Connect(Fake, false, true) != 37 || DiagnosticConnectionFlags.Connect(Fake, true, true) != 37
        || !calls.SequenceEqual(new uint[] { 4, 12, 6, 14 })) throw new InvalidOperationException("Diagnostic flags did not preserve native call/result semantics.");
    var starts = 0;
    DiagnosticConnectionFlags.StartScanner(() => starts++, false);
    DiagnosticConnectionFlags.StartScanner(() => starts++, true);
    if (starts != 1) throw new InvalidOperationException("Diagnostic scanner comparison did not preserve default start or suppress the opt-in start.");
    Console.WriteLine("PASS diagnostic native connection flag comparison with fake native call.");
    return 0;
}
#endif
if (args.Length >= 1 && args[0] == "--first-shell-registration-gate-tests") return args.Length == 1 ? FirstShellRegistrationProbe.GateTests() : 2;
if (args.Length >= 1 && args[0] == "--first-shell-registration-disposable-vm") return args.Length == 1 ? await FirstShellRegistrationProbe.RunAsync() : 2;
if (args.Length == 1 && args[0] == "--synthetic-busy-native") return await SyntheticBusyNative.RunAsync();
if (args.Length == 1 && args[0] == "--generated-removal-binding-only") return await GeneratedRemovalBindingTests.RunAsync();
if (args.Length == 1 && args[0] == "--synthetic-busy-native-dedicated") return await SyntheticBusyNative.RunAsync(dedicatedReaders: true);
if (args.Length == 1 && args[0] == "--synthetic-dedicated-reader-tests") return await SyntheticBusyNative.RunDedicatedReaderTestsAsync();
if (args.Length == 1 && args[0] == "--synthetic-busy-diagnostics-tests") return await SyntheticBusyNative.RunDiagnosticsTestsAsync();
if (args.Length == 1 && args[0] == "--synthetic-busy-window-tests") return SyntheticBusyNative.RunBusyWindowTests();
if (args.Length == 1 && args[0] == "--preflight-recovery-tests") return await PreflightRecoveryBoundaryTests.RunAsync();
if (args.Length == 1 && args[0] == "--shell-partial-observation-tests") return ShellPartialObservationTests.Run();
if (args.Length == 1 && args[0] == "--dedicated-hydration-tests") return await DedicatedHydrationWorkerTests.RunAsync();

if (args.Length >= 1 && args[0] == "--identity-refresh-transaction-tests")
    return args.Length == 1 ? await LedgeTop.Files.Explorer.Tests.IdentityRefresh.IdentityRefreshTransactionTests.RunAsync() : 2;

if (args.Length >= 1 && args[0] == "--company-hydration-source-gate-tests")
    return args.Length == 1 ? await CompanyHydrationSourceGateTests.RunAsync() : 2;
if (args.Length == 1 && args[0] == "--branding-policy-tests") return await ExplorerBrandIconTests.RunAsync();
if (args.Length >= 1 && args[0] == "--display-name-policy-tests")
    return args.Length == 1 ? ExplorerRootDisplayNameTests.Run() : 2;
if (args.Length == 1 && args[0] == "--scanner-reporter-integration-tests") return await ScannerReporterIntegrationTests.RunAsync();
if (args.Length == 1 && args[0] == "--live-provider-catalog-tests") return await LiveProviderCatalogTests.RunAsync();
if (args.Length == 1 && args[0] == "--availability-inspection-reporter-tests") return AvailabilityInspectionReporterTests.Run();
if (args.Length >= 1 && args[0] == "--availability-scan-wake-tests")
    return args.Length == 1 ? await AvailabilityScanWakeTests.RunAsync() : 2;
if (args.Length >= 1 && args[0] == "--bounded-availability-worker-tests")
    return args.Length == 1 ? await BoundedAvailabilityWorkerTests.RunAsync() : 2;
if (args.Length >= 1 && args[0] == "--availability-intent-policy-tests")
    return args.Length == 1 ? FailedAvailabilityIntentTests.Run() : 2;
if (args.Length >= 1 && args[0] == "--source-gate-policy-tests")
    return args.Length == 1 ? await ExplorerSourceGatePolicyTests.RunAsync() : 2;
if (args.Length == 1 && args[0] == "--owned-resume-synthetic-tests") return await OwnedResumeSyntheticTests.RunAsync();
if (args.Length >= 1 && args[0] == "--local-availability-operation-tests")
    return args.Length == 1 ? LocalAvailabilityOperationTests.Run() : 2;
if (args.Length >= 1 && args[0] == "--package-context-policy-tests")
    return args.Length == 1 ? CurrentProcessPackageContextTests.Run() : 2;
if (args.Length >= 1 && args[0] == "--package-context-observation") {
    if (args.Length != 1) return 2;
    var observation = CurrentProcessPackageContextObserver.Observe();
    Console.WriteLine(JsonSerializer.Serialize(new { scope = "current-process-only", kind = observation.Kind.ToString(),
        observation.QueryStatus, observation.ReadStatus }));
    return observation.Kind == CurrentProcessPackageContextKind.Unknown ? 1 : 0;
}
if (args.Length >= 1 && args[0] == "--generated-removed-absence-acceptance")
    return args.Length == 1 ? await GeneratedRemovedAbsenceAcceptance.RunAsync() : 2;

if (args.Length == 1 && args[0] == "--empty-inventory-acceptance") return await EmptyInventoryAcceptance.RunAsync();
if (args.Length >= 1 && args[0] == "--connected-root-acceptance") return await ConnectedRootAcceptance.RunAsync(args[1..]);
if (args.Length == 1 && args[0] == "--connected-preflight-acceptance") return await ConnectedPreflightAcceptance.RunAsync();

if (args.Length == 1 && args[0] == "--remove-default-owned-preview") {
    await using var defaultPreview = new ExplorerPreviewSession();
    await defaultPreview.RemoveAsync();
    Console.WriteLine(JsonSerializer.Serialize(new { state = defaultPreview.State.ToString(), root = defaultPreview.RootPath, localFilesPreserved = true }));
    return defaultPreview.State == ExplorerPreviewState.Removed ? 0 : 1;
}

if (args.Length == 2 && args[0] is "--session-seed" or "--session-resume") {
    var sessionId = Guid.ParseExact(args[1], "N");
    var sessionDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTopFilesExplorerSessionTests", sessionId.ToString("N"));
    var profileDirectory = Path.Combine(sessionDirectory, "Profile");
    var testRoot = Path.Combine(sessionDirectory, "Files");
    await using var session = new ExplorerPreviewSession(profileDirectory, testRoot);
    session.Changed += (_, _) => { var last = session.Activity.LastOrDefault(); if (last is not null) Console.WriteLine(last); };
    try {
        await session.StartAsync();
        Require(session.State == (args[0] == "--session-seed" ? ExplorerPreviewState.Running : ExplorerPreviewState.Paused), "Persisted pause state did not survive process restart.");
        if (args[0] == "--session-seed") {
            Require((await File.ReadAllBytesAsync(Path.Combine(session.RootPath, "Samples", "sample.csv"))).Length > 600000, "Seed CSV download failed.");
            await File.WriteAllTextAsync(Path.Combine(session.RootPath, "my-local-notes.txt"), "Local acceptance notes must survive removal.\r\n");
            await session.PauseAsync();
            await session.DisposeAsync();
            Console.WriteLine("PASS seed: actual native session disconnected, pause/profile/root/navigation retained for a separate process.");
        } else {
            Require((await File.ReadAllBytesAsync(Path.Combine(session.RootPath, "Samples", "sample.csv"))).Length > 600000, "Cached CSV was not readable while source paused after restart.");
            await session.ResumeAsync();
            Require((await File.ReadAllTextAsync(Path.Combine(session.RootPath, "README.txt"))).Contains("generated test files", StringComparison.Ordinal), "Resumed sample open failed.");
            var oldRoot = session.RootPath;
            await session.RemoveAsync();
            Require(session.State == ExplorerPreviewState.Removed && (await File.ReadAllTextAsync(Path.Combine(oldRoot, "my-local-notes.txt"))).StartsWith("Local acceptance notes", StringComparison.Ordinal), "Explicit removal changed local files.");
            await session.StartAsync();
            Require(session.RootPath != oldRoot && session.State == ExplorerPreviewState.Running, "Fresh preview reused a removed generation's files.");
            await session.RemoveAsync();
            Console.WriteLine("PASS resume: separate-process reconnect, cached paused read, resume hydration, safe removal and fresh generation.");
        }
        return 0;
    } catch (Exception error) {
        Console.Error.WriteLine(error);
        try { await session.RemoveAsync(); Console.Error.WriteLine("Failed session's exact owned integration removed; local files retained."); } catch (Exception cleanup) { Console.Error.WriteLine("Session integration retained for reconciliation: " + cleanup); }
        return 1;
    }
}

if (args.Length == 2 && args[0] == "--reconcile-native-only") {
    var previous = Guid.ParseExact(args[1], "N");
    var previousRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTopFilesExplorerTests", previous.ToString("N"), "Files");
    var context = Encoding.UTF8.GetBytes("LedgeTop.Files.Explorer.NativeAcceptance.v1:" + previous);
    Console.WriteLine(JsonSerializer.Serialize(NativeRootRegistration.Inspect(previousRoot, context)));
    var recovered = NativeRootRegistration.OpenOwned(previousRoot, context);
    recovered.Unregister();
    Console.WriteLine(JsonSerializer.Serialize(NativeRootRegistration.Inspect(previousRoot, context)));
    Console.WriteLine("Exact native registration removed after prior acceptance process exited. No reconnect or Register attempted.");
    return 0;
}

if (args.Length == 2 && args[0] == "--reconcile-native-preview") {
    var previous = Guid.ParseExact(args[1], "N");
    var previousRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTopFilesExplorerTests", previous.ToString("N"), "Files");
    var previousId = ShellRegistration.CreateId(previous);
    var context = Encoding.UTF8.GetBytes("LedgeTop.Files.Explorer.NativeAcceptance.v1:" + previous);
    // Historical acceptance did not persist the shell namespace CLSID/root file ID. A negative
    // broker enumeration cannot prove absence, and a partial positive result cannot replace that
    // durable receipt. Keep this legacy operation observation-only instead of adopting old roots.
    try {
        Console.WriteLine(JsonSerializer.Serialize(new {
            shellId = previousId, native = NativeRootRegistration.Inspect(previousRoot, context),
            observationOnly = true, registrationAbsenceProven = false, mutationsPerformed = false
        }));
    } catch (Exception error) when (error is IOException or ArgumentException or UnauthorizedAccessException) {
        Console.Error.WriteLine("Read-only legacy preview inspection was unavailable: " + error.Message);
    }
    Console.Error.WriteLine("Legacy shell cleanup refused: reconcile the exact durable namespace and native ownership receipts. No registration was changed.");
    return 1;
}

// This executable deliberately creates one disposable, current-user Windows provider registration.
// It is never part of normal unit tests and must be invoked explicitly.
if (!args.Contains("--owned-native-preview", StringComparer.Ordinal)) {
    Console.Error.WriteLine("Pass --owned-native-preview to test one isolated generated-data Windows root.");
    return 2;
}
var previewId = Guid.NewGuid();
var explicitArtifactRoot = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
var owned = explicitArtifactRoot is null
    ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTopFilesExplorerTests", previewId.ToString("N"))
    : Path.Combine(CheckedArtifactRoot(explicitArtifactRoot), "fixtures", previewId.ToString("N"));
var root = Path.Combine(owned, "Files");
var cache = Path.Combine(owned, "Cache");
Directory.CreateDirectory(root);
Directory.CreateDirectory(cache);
// Persist the exact generated root before the first native registration attempt.
// If the process is interrupted, this is evidence for reconciliation, not a
// permission to remove or unregister anything without checking its identity.
var ownerBytes = JsonSerializer.SerializeToUtf8Bytes(new { previewId, root, generatedDataOnly = true, productionAccess = false });
using (var ownerFile = new FileStream(Path.Combine(owned, "owner.json"), FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
    ownerFile.Write(ownerBytes);
    ownerFile.Flush(flushToDisk: true);
}
using var source = new CountedExplorerDemoSource();
source.SignIn();
IPreviewRootRegistration? registration = null;
NativePlaceholderProvider? provider = null;
ExplorerNavigation? navigation = null;
var phases = new List<string>();
var failures = new List<string>();
var safeToUnregister = true;
var explicitFreeSpaceWasPendingAtStop = false;
var cloudRootAttributesMasked = false;
var interactiveBrand = args.Contains("--synthetic-branded-interactive", StringComparer.Ordinal);
var interactiveObserverConfirmed = !interactiveBrand;
#if LEDGETOP_NATIVE_DIAGNOSTICS
NativeStallTrace.Capture? reconnectTrace = null;
#endif
if (interactiveBrand && (args.Contains("--native-only", StringComparer.Ordinal) || args.Contains("--navigation", StringComparer.Ordinal)))
    throw new ArgumentException("Branded interactive acceptance requires the Shell sync root without the legacy preview namespace.");
try {
    registration = args.Contains("--native-only", StringComparer.Ordinal) ? NativeRootRegistration.Register(root,
        Encoding.UTF8.GetBytes("LedgeTop.Files.Explorer.NativeAcceptance.v1:" + previewId)) : await ShellRegistration.RegisterAsync(root, ShellRegistration.CreateId(previewId),
        interactiveBrand ? ExplorerBrandIcon.EnsureResource() : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shell32.dll") + ",3",
        Encoding.UTF8.GetBytes("LedgeTop.Files.Explorer.NativeAcceptance.v1:" + previewId),
        interactiveBrand ? ExplorerRootDisplayName.ForConnectedAlias("employee") : ShellRegistration.DisplayName);
    phases.Add(args.Contains("--native-only", StringComparer.Ordinal) ? "actual native-only registration and identity readback (no branded node)" : "actual shell registration and identity readback");
    var manifest = source.Entries.ToDictionary(e => e.RelativePath.Replace('/', '\\'), e => e.Identity, StringComparer.OrdinalIgnoreCase);
    var testCatalogAddition = args.Contains("--synthetic-catalog-addition", StringComparer.Ordinal);
    if (testCatalogAddition && !args.Contains("--native-only", StringComparer.Ordinal))
        throw new IOException("The catalog addition test requires the generated native-only root.");
    const string addedPath = "Samples\\diagram.svg";
    var initialManifest = manifest.Where(entry => !testCatalogAddition || !entry.Key.Equals(addedPath, StringComparison.OrdinalIgnoreCase))
        .ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.OrdinalIgnoreCase);
    string[] explicitDirectories = ["Empty folder\\Nested empty"];
    provider = new(registration, cache, source, source.Channel, source.PrincipalId, initialManifest, explicitDirectories);
    provider.Activity += text => Console.WriteLine("Reconnect: " + text);
    provider.Activity += text => Console.WriteLine(text);
    safeToUnregister = false;
    await provider.ConnectAndPopulateAsync();
    if (testCatalogAddition) {
        // Generated fixture only: this intentionally bypasses production publication and
        // provides no crash, collision, identity or authorization guarantees.
        var create = typeof(NativePlaceholderProvider).GetMethod("Create", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            ?? throw new IOException("Synthetic native creation method unavailable.");
        create.Invoke(provider, [addedPath, manifest[addedPath]]);
        var revision = provider.AdmitVerifiedCatalog(0, new Dictionary<string, PlaceholderIdentity>(StringComparer.OrdinalIgnoreCase) {
            [addedPath] = manifest[addedPath]
        }, Array.Empty<string>());
        if (revision != 1) throw new IOException("Synthetic catalog admission failed.");
        phases.Add("generated placeholder admitted to running provider catalog");
    }
    var ordinaryRootAttributes = File.GetAttributes(root);
    var exposedRootAttributes = PlaceholderVisibility.Run(() => File.GetAttributes(root));
    cloudRootAttributesMasked = (ordinaryRootAttributes & FileAttributes.ReparsePoint) == 0 &&
        (exposedRootAttributes & FileAttributes.ReparsePoint) != 0;
    phases.Add("actual native connection and placeholder creation");
    if (interactiveBrand) {
        // The external VM observer may open Explorer only while this owned provider is alive.
        // A bounded wait guarantees that an absent observer cannot leave the provider running.
        var ready = Path.Combine(owned, "interactive-ready.json");
        using (var stream = new FileStream(ready, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            JsonSerializer.Serialize(stream, new { Root = root, Identity = previewId, DisplayName = ExplorerRootDisplayName.ForConnectedAlias("employee") });
        Console.WriteLine("SYNTHETIC_EXPLORER_READY " + ready);
        var stop = Path.Combine(owned, "interactive-stop");
        var deadline = DateTime.UtcNow.AddMinutes(args.Contains("--synthetic-context-actions", StringComparer.Ordinal) ? 8 : 3);
        while (!File.Exists(stop) && DateTime.UtcNow < deadline) await Task.Delay(250);
        if (!File.Exists(stop)) throw new TimeoutException("Synthetic Explorer observer did not finish in time.");
        interactiveObserverConfirmed = true;
        phases.Add("bounded synthetic branded Explorer observer completed");
    }
    Require(Directory.Exists(Path.Combine(root, "Empty folder", "Nested empty")) &&
        Directory.GetFileSystemEntries(Path.Combine(root, "Empty folder", "Nested empty")).Length == 0,
        "Explicit empty catalog directories were not preserved.");
    provider.SetFolderAvailabilityIntent("Empty folder", true);
    provider.SetFolderAvailabilityIntent("Empty folder", false);
    phases.Add("explicit nested empty catalog directories exist and accept native keep/free intent");
    if (args.Contains("--navigation", StringComparer.Ordinal)) {
        navigation = ExplorerNavigation.Register(registration, previewId,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shell32.dll") + ",3");
        navigation.VerifyOwned();
        phases.Add("actual per-user Explorer namespace registration and exact ownership readback");
    }
    var diagram = Path.Combine(root, "Samples", "diagram.svg");
    await using (var tinyRead = new FileStream(diagram, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, true)) {
        tinyRead.Position = 17;
        var single = new byte[1];
        Require(await tinyRead.ReadAsync(single).AsTask().WaitAsync(TimeSpan.FromSeconds(30)) == 1, "Unaligned single-byte open failed.");
    }
    Require(Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(diagram))) == manifest["Samples\\diagram.svg"].Sha256, "Unaligned read hydration SHA mismatch.");
    phases.Add("unaligned single-byte initial read hydrates exact full content");
    var readme = Path.Combine(root, "README.txt");
    string[] CachedContent(string relative) => Directory.GetFiles(cache, Path.GetFileName(relative), SearchOption.AllDirectories);
    void RequireCachedContent(string relative) {
        var candidates = CachedContent(relative);
        Require(candidates.Length == 1 && Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(candidates[0]))) == manifest[relative].Sha256,
            "The exact private verified content cache was not present: " + relative);
    }
    Require(((uint)provider.InspectAttributes("README.txt") & 0x1000) != 0, "Initial README must be online only.");
    var bytes = await File.ReadAllBytesAsync(readme).WaitAsync(TimeSpan.FromSeconds(30));
    Require(Convert.ToHexStringLower(SHA256.HashData(bytes)) == manifest["README.txt"].Sha256, "Read-on-open SHA mismatch.");
    RequireCachedContent("README.txt");
    phases.Add("ordinary file read hydrates exact verified bytes");
    provider.KeepOnDevice("Samples\\sample.csv");
    var csvPath = Path.Combine(root, "Samples", "sample.csv");
    Require(((uint)provider.InspectAttributes("Samples\\sample.csv") & 0x80000) != 0, "Explicit keep must set pin intent.");
    Require(Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(csvPath))) == manifest["Samples\\sample.csv"].Sha256, "Pinned content SHA mismatch.");
    phases.Add("actual pin and verified full hydration");
    var readmeDownloads = source.DownloadCount("README.txt");
    var beforeFreeCalls = source.Calls;
    await provider.FreeSpaceAsync("README.txt");
    Require(((uint)provider.InspectAttributes("README.txt") & 0x1000) != 0, "Free space must return README to online only.");
    Require(CachedContent("README.txt").Length == 0 && source.Calls == beforeFreeCalls,
        "Free space did not remove private content cache offline without source calls.");
    Require(Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(readme))) == manifest["README.txt"].Sha256, "Read after eviction SHA mismatch.");
    Require(source.DownloadCount("README.txt") == readmeDownloads + 1, "Read after free space reused a hidden full-file cache instead of redownloading.");
    phases.Add("actual dehydration removes exact private content cache offline and next open downloads source bytes again");
    Require((await File.ReadAllBytesAsync(Path.Combine(root, "Samples", "empty.txt"))).Length == 0, "Empty placeholder read failed.");
    provider.KeepOnDevice("Samples\\empty.txt");
    phases.Add("zero-length placeholder opens without invented fetch completion");
    var sampleFiles = manifest.Where(entry => entry.Key.StartsWith("Samples\\", StringComparison.Ordinal)).ToArray();
    Require(sampleFiles.Length == 4 && sampleFiles.Any(entry => entry.Key.StartsWith("Samples\\Nested\\", StringComparison.Ordinal)),
        "The recursive acceptance fixture must include a nested child and an empty file.");
    string SampleAvailability() => string.Join(", ", sampleFiles.Select(entry => entry.Key + "=0x" + ((uint)provider.InspectAttributes(entry.Key)).ToString("X8")));
    provider.SetFolderAvailabilityIntent("Samples", keepOffline: true);
    await WaitForAsync(() => sampleFiles.All(entry => {
        var attributes = (uint)provider.InspectAttributes(entry.Key);
        return (attributes & 0x80000) != 0 && (attributes & 0x100000) == 0 &&
            (entry.Value.Length == 0 || (attributes & (0x1000u | 0x40000u | 0x400000u)) == 0);
    }), "Recursive keep intent did not converge to pinned local files.", SampleAvailability);
    foreach (var entry in sampleFiles) {
        var pinnedBytes = await File.ReadAllBytesAsync(Path.Combine(root, entry.Key)).WaitAsync(TimeSpan.FromSeconds(30));
        Require(Convert.ToHexStringLower(SHA256.HashData(pinnedBytes)) == entry.Value.Sha256,
            "Recursive pinned sample SHA mismatch: " + entry.Key);
    }
    phases.Add("recursive folder keep pins and fully hydrates every child including nested and empty samples");
    provider.SetFolderAvailabilityIntent("Samples", keepOffline: false);
    await WaitForAsync(() => sampleFiles.All(entry => {
        var attributes = (uint)provider.InspectAttributes(entry.Key);
        return (attributes & 0x100000) != 0 && (attributes & 0x80000) == 0 &&
            (entry.Value.Length == 0 || (attributes & 0x1000) != 0);
    }), "Recursive free-space intent did not converge to online-only files.", SampleAvailability);
    await WaitForAsync(() => sampleFiles.All(entry => CachedContent(entry.Key).Length == 0),
        "Recursive free-space intent retained hidden private content caches.", SampleAvailability);
    phases.Add("recursive folder free removes local nonempty data and exact private content caches while preserving children");
    // Restore the existing independent offline-read check after exercising recursive free space.
    provider.KeepOnDevice("Samples\\sample.csv");
    Require(((uint)provider.InspectAttributes("Samples\\sample.csv") & 0x80000) != 0 &&
        Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(csvPath))) == manifest["Samples\\sample.csv"].Sha256,
        "CSV was not restored to verified pinned content after recursive free space.");
    var notes = Path.Combine(root, "Samples", "Nested", "notes.txt");
    _ = await File.ReadAllBytesAsync(notes);
    File.SetAttributes(notes, File.GetAttributes(notes) & ~FileAttributes.ReadOnly);
    const string localEdit = "Generated acceptance test local edit; never discard.\r\n";
    await File.WriteAllTextAsync(notes, localEdit);
    var refusedDirty = false;
    try { provider.FreeSpace("Samples\\Nested\\notes.txt"); } catch (IOException) { refusedDirty = true; }
    Require(refusedDirty && await File.ReadAllTextAsync(notes) == localEdit, "Dirty sample data was not preserved during refused eviction.");
    phases.Add("modified local sample survives refused dehydration");
    await provider.DisposeAsync(); provider = null; safeToUnregister = true;
    Require(Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(csvPath))) == manifest["Samples\\sample.csv"].Sha256, "Pinned content unavailable after provider disconnect.");
    phases.Add("pinned sample remains readable with provider disconnected");
#if LEDGETOP_NATIVE_DIAGNOSTICS
    if (args.Contains("--synthetic-reservation-control", StringComparer.Ordinal)) {
        // Use the same private volume and directory as reservations, while the provider is
        // disconnected. This is a timing control, not a replacement for the publication guard.
        var reservationDirectory = Path.Combine(cache, "verified-hydration-v1", ".hydration-reservations-v2");
        if (!Directory.Exists(reservationDirectory)) throw new IOException("Synthetic reservation directory is unavailable.");
        var samples = new List<object>();
        for (var iteration = 0; iteration < 5; iteration++) {
            var temporary = Path.Combine(reservationDirectory, "synthetic-control-" + Guid.NewGuid().ToString("N") + ".tmp");
            var clock = System.Diagnostics.Stopwatch.StartNew();
            long open, write, flush, close, guard;
            var created = false;
            try {
                var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                created = true;
                open = clock.ElapsedTicks;
                try {
                    output.Write(Encoding.UTF8.GetBytes("synthetic-reservation-control"));
                    write = clock.ElapsedTicks;
                    output.Flush(true);
                    flush = clock.ElapsedTicks;
                } finally { output.Dispose(); }
                close = clock.ElapsedTicks;
                using (var held = new FileStream(temporary, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete)) { guard = clock.ElapsedTicks; }
                samples.Add(new { iteration, open, write, flush, close, guard });
            } finally { if (created) File.Delete(temporary); }
        }
        await File.WriteAllTextAsync(Path.Combine(owned, "synthetic-reservation-control.json"),
            JsonSerializer.Serialize(new { Frequency = System.Diagnostics.Stopwatch.Frequency, Samples = samples }));
        phases.Add("ordinary worker reservation reopen control recorded");
    }
    if (args.Contains("--synthetic-reconnect-trace", StringComparer.Ordinal)) reconnectTrace = NativeStallTrace.Enable();
#endif
    provider = new(registration, cache, source, source.Channel, source.PrincipalId, manifest, explicitDirectories);
    provider.Activity += text => Console.WriteLine("Reconnect: " + text);
    safeToUnregister = false;
    await provider.ConnectExistingAsync();
    phases.Add("reconnect: native provider connected");
    Require(Directory.GetFileSystemEntries(Path.Combine(root, "Empty folder", "Nested empty")).Length == 0,
        "Reconnect changed an explicit empty directory.");
    phases.Add("reconnect: empty directory verified");
    provider.ValidateForRemoval();
    phases.Add("reconnect: removal validation passed");
    await provider.FreeSpaceAsync("README.txt");
    phases.Add("reconnect: README free-space completed");
    Require(CachedContent("README.txt").Length == 0, "Reconnect free-space left hidden README cache.");
    Require(Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(readme))) == manifest["README.txt"].Sha256, "Reconnected placeholder SHA mismatch.");
    phases.Add("reconnect: README read verified");
    Require(await File.ReadAllTextAsync(notes) == localEdit, "Reconnect changed local edits.");
    phases.Add("validated existing placeholders reconnect without rewriting local edits");
    source.Revoke();
    var beforeOfflineFree = source.Calls;
    await provider.FreeSpaceAsync("README.txt");
    Require(source.Calls == beforeOfflineFree && CachedContent("README.txt").Length == 0,
        "Revoked source prevented offline cache reclamation or was contacted during free space.");
    var beforeDeniedDownloads = source.DownloadCount("README.txt");
    var revokedDenied = false;
    try { _ = await File.ReadAllBytesAsync(readme).WaitAsync(TimeSpan.FromSeconds(30)); } catch (IOException) { revokedDenied = true; }
    Require(revokedDenied, "Revoked simulated source still hydrated an online-only sample.");
    Require(CachedContent("README.txt").Length == 0 && source.DownloadCount("README.txt") == beforeDeniedDownloads,
        "Denied source repopulated private content cache.");
    phases.Add("offline free space removes content cache after simulated revocation; later open is denied without cached bytes");
    var beforeStoppingFree = source.Calls;
    var stoppingProvider = provider;
    var explicitFree = stoppingProvider.FreeSpaceAsync("Samples\\sample.csv");
    explicitFreeSpaceWasPendingAtStop = !explicitFree.IsCompleted;
    await stoppingProvider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(30));
    Require(explicitFree.IsCompleted, "Provider disposal returned before explicit asynchronous free-space drained.");
    try { await explicitFree; } catch (Exception error) when (error is OperationCanceledException or IOException or TransferException) { }
    var refusedAfterStop = false;
    try { await stoppingProvider.FreeSpaceAsync("README.txt"); } catch (IOException) { refusedAfterStop = true; }
    Require(refusedAfterStop && source.Calls == beforeStoppingFree, "Stopped provider admitted availability work or contacted revoked source.");
    provider = null; safeToUnregister = true;
    phases.Add("provider stop joins explicit asynchronous free-space and rejects later availability work without source calls");
} catch (Exception error) {
    if (error is ExplorerNavigationRegistrationException { OwnedPartial: { } partial }) navigation = partial;
    if (provider?.LastCreationDiagnostic is { } creation) Console.Error.WriteLine(creation);
    if (provider?.LastNativeTransferDiagnostic is { } transfer) Console.Error.WriteLine(transfer);
    failures.Add(error.GetType().Name + ": " + error.Message);
    Console.Error.WriteLine(error.ToString());
} finally {
    if (provider is not null) { try { await provider.DisposeAsync(); safeToUnregister = true; } catch (Exception error) { failures.Add("Disconnect: " + error.Message); } }
#if LEDGETOP_NATIVE_DIAGNOSTICS
    if (reconnectTrace is not null) {
        NativeStallTrace.Disable(reconnectTrace);
        try {
            var traceEvents = NativeStallTrace.Snapshot(reconnectTrace).Select(e => new {
                e.Sequence, e.Timestamp, e.ThreadId, e.NativeThreadId, Kind = e.Kind.ToString(), e.CallbackId, NumericValue = e.ProcessId
            }).ToArray();
            await File.WriteAllTextAsync(Path.Combine(owned, "synthetic-reconnect-trace.json"), JsonSerializer.Serialize(new {
                StopwatchFrequency = System.Diagnostics.Stopwatch.Frequency, reconnectTrace.NativeProcessId,
                reconnectTrace.AnchorBefore, reconnectTrace.AnchorAfter, reconnectTrace.AnchorUtcTicks,
                Dropped = NativeStallTrace.Dropped(reconnectTrace), Events = traceEvents
            }));
        } catch (Exception error) { failures.Add("Reconnect trace unavailable: " + error.GetType().Name); }
    }
#endif
    if (!interactiveObserverConfirmed) { safeToUnregister = false; failures.Add("Registration retained because the Explorer observer did not confirm its window closed."); }
    if (navigation is not null && safeToUnregister) { try { navigation.Remove(); phases.Add("exact owned Explorer namespace removed"); } catch (Exception error) { failures.Add("Navigation removal: " + error.Message); safeToUnregister = false; } }
    if (registration is not null && safeToUnregister) { try { registration.Unregister(); phases.Add("exact owned registration removed and absence verified"); } catch (Exception error) { failures.Add("Unregister: " + error.Message); } }
    if (registration is not null && !safeToUnregister) failures.Add("Registration retained for reconciliation because disconnect was not confirmed.");
    // Keep this owned test directory and receipt for diagnosis. No recursive deletion of provider content.
    await File.WriteAllTextAsync(Path.Combine(owned, "receipt.json"), JsonSerializer.Serialize(new {
        previewId, root, phases, failures, explicitFreeSpaceWasPendingAtStop, cloudRootAttributesMasked, generatedDataOnly = true, productionAccess = false
    }, new JsonSerializerOptions { WriteIndented = true }));
}
Console.WriteLine(JsonSerializer.Serialize(new { passed = failures.Count == 0, phases, failures, receipt = Path.Combine(owned, "receipt.json") }));
return failures.Count == 0 ? 0 : 1;

static void Require(bool value, string message) { if (!value) throw new IOException(message); }

static string CheckedArtifactRoot(string value)
{
    if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value) || value.StartsWith(@"\\", StringComparison.Ordinal) ||
        value.Replace('/', '\\').Split('\\').Any(part => part is "." or ".." || part.EndsWith(' ') || part.EndsWith('.')))
        throw new IOException("The test artifact root must be an existing canonical local directory.");
    var full = Path.GetFullPath(value);
    if (!Directory.Exists(full) || Path.TrimEndingDirectorySeparator(full) == Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full)!) ||
        new DriveInfo(Path.GetPathRoot(full)!).DriveType != DriveType.Fixed)
        throw new IOException("The test artifact root must already exist on a local fixed drive.");
    for (string? part = full; part is not null; part = Path.GetDirectoryName(part))
        if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw new IOException("The test artifact root contains an alias.");
    return full;
}

static async Task WaitForAsync(Func<bool> condition, string failure, Func<string> detail)
{
    var deadline = System.Diagnostics.Stopwatch.StartNew();
    while (!condition()) {
        if (deadline.Elapsed > TimeSpan.FromSeconds(30)) throw new IOException(failure + " " + detail());
        await Task.Delay(TimeSpan.FromMilliseconds(100));
    }
}

sealed class CountedExplorerDemoSource : IQueuedDownloadSource, IDisposable
{
    private readonly ExplorerDemoSource inner = new(chunkDelay: TimeSpan.Zero);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, int> downloads = new(StringComparer.Ordinal);
    private int sessions, resolutions, downloadCalls;
    public string Alias => inner.Alias;
    public Uri Origin => inner.Origin;
    internal string Channel => inner.Channel;
    internal string PrincipalId => inner.PrincipalId;
    internal IReadOnlyList<ExplorerDemoEntry> Entries => inner.Entries;
    internal (int Sessions, int Resolutions, int Downloads) Calls => (Volatile.Read(ref sessions), Volatile.Read(ref resolutions), Volatile.Read(ref downloadCalls));
    internal int DownloadCount(string relative) {
        var identity = Entries.Single(entry => entry.RelativePath.Replace('/', '\\') == relative).Identity;
        return downloads.GetValueOrDefault(identity.LogicalFileId + ":" + identity.RemoteVersion);
    }
    internal void SignIn() => inner.SignIn();
    internal void Revoke() => inner.Revoke();
    public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) { Interlocked.Increment(ref sessions); return inner.GetSessionAsync(cancellationToken); }
    public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken cancellationToken = default) { Interlocked.Increment(ref resolutions); return inner.ResolveAsync(reference, cancellationToken); }
    public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) {
        Interlocked.Increment(ref downloadCalls); downloads.AddOrUpdate(spec.OpaqueIdentity, 1, (_, count) => count + 1);
        return inner.DownloadAsync(spec, destination, progress, cancellationToken);
    }
    public void Dispose() => inner.Dispose();
}

