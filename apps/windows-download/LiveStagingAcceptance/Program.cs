using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Backends;
using LedgeTop.WindowsDownload;

// Deliberate live read-only acceptance, not a loopback fixture or an installer.
// Grants/revocation are performed separately through supported owner workflows.
try { await Run(args); }
catch (Exception error) {
    // Exception messages can contain paths or selectors. Never print them or stacks.
    Console.Error.WriteLine(JsonSerializer.Serialize(new { schemaVersion = 1, outcome = "refused-or-failed", errorType = error.GetType().Name }));
    Environment.ExitCode = 1;
}

static async Task Run(string[] args)
{
    if (!OperatingSystem.IsWindows()) throw new InvalidOperationException();
    var input = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var i = 0; i < args.Length; i += 2) {
        if (i + 1 >= args.Length || !input.TryAdd(args[i], args[i + 1])) throw new ArgumentException();
    }
    string[] required = ["--phase", "--mode", "--run-id", "--helper", "--sha256", "--selection"];
    Require(input.Count == required.Length && required.All(input.ContainsKey));
    var phase = input["--phase"]; var mode = input["--mode"];
    Require(phase is "interrupt" or "resume" or "existing-destination" or "after-revoke");
    Require(mode is "employee" or "client");
    Require(Guid.TryParseExact(input["--run-id"], "D", out var runId) && runId != Guid.Empty);
    var sha = input["--sha256"];
    Require(sha.Length == 64 && sha.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'));
    var selection = input["--selection"];
    Require(selection.Length is > 0 and <= 160 && !selection.Any(char.IsControl));
    var profile = ReleaseProfiles.For(ReleaseChannel.Pilot) ?? throw new InvalidOperationException();
    Require(profile.CloudflaredSha256 is not null && profile.StaffApplicationUrl is not null);
    var application = mode == "employee" ? profile.StaffApplicationUrl! : profile.PortalApplicationUrl;
    // Reuse the exact reviewed, source-controlled staging profile and helper hash.
    Require(application.Host is "ops-staging.ledgetopdroneservices.com" or "portal-staging.ledgetopdroneservices.com");
    var session = new CloudflareAccessSession(application, input["--helper"], profile.CloudflaredSha256!);
    // This command never launches a browser or tries another identity. Sign in separately.
    using var source = mode == "employee" ? (QueuedDownloadSource)new EmployeeQueuedDownloadSource("employee", session)
        : new PortalQueuedDownloadSource("portal", session);
    using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(4));
    var token = deadline.Token;
    var home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTop", "Files", "live-staging-acceptance");
    PlainPath(home); Directory.CreateDirectory(home); PlainPath(home);
    var root = Path.Combine(home, runId.ToString("D"));
    var marker = new RunMarker(1, runId, mode, sha, Hash(selection));
    var json = JsonSerializer.Serialize(marker);
    if (phase == "interrupt") {
        Require(!Directory.Exists(root) && !File.Exists(root));
        Directory.CreateDirectory(root); PlainPath(root);
        WriteNew(Path.Combine(root, "owner.json"), json);
    } else {
        PlainPath(root); Require(Directory.Exists(root));
        Require(ReadSmall(Path.Combine(root, "owner.json")) == json);
    }
    var lockPath = Path.Combine(root, "operator.lock"); PlainPath(lockPath);
    using var held = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    var receiptPath = Path.Combine(root, phase + ".receipt.json");
    Require(!File.Exists(receiptPath)); // Each phase is one attempt. Never overwrite evidence.
    if (phase != "interrupt") Require(File.Exists(Path.Combine(root, "interrupt.receipt.json")));
    if (phase == "existing-destination" || phase == "after-revoke") Require(File.Exists(Path.Combine(root, "resume.receipt.json")));
    var output = Path.Combine(root, "download");
    Directory.CreateDirectory(output); PlainPath(output);
    await using var queue = await TransferQueue.OpenAsync(Path.Combine(root, "queue"), source, token);
    Guid jobId;
    if (phase == "interrupt") {
        var reference = await Discover(mode, selection, session, source, token);
        var resolved = await source.ResolveAsync(reference, token);
        Fixture(resolved.Spec, sha);
        jobId = await queue.EnqueueAsync(reference, output, token);
        Task? pause = null;
        var delayed = false;
        var progress = new InlineProgress(value => {
            if (value.Phase != DownloadPhase.Receiving) return;
            if (value.BytesTransferred == 0 && !delayed) {
                delayed = true;
                // The production observer throttles at 100ms. Wait locally before the
                // first read so its first <=64KiB write is reported, even over fast LAN.
                Thread.Sleep(150);
            } else if (value.BytesTransferred > 0 && pause is null) {
                pause = queue.PauseAsync(jobId); // Cancels synchronously; never await this transfer from its own observer.
            }
        });
        await queue.StartAsync(jobId, progress, token);
        await queue.WaitForIdleAsync(token);
        Require(pause is not null); await pause!;
        var jobs = await queue.GetJobsAsync(token);
        Require(jobs.Single().State == QueuedTransferState.Paused);
        var prefix = Partial(output);
        Require(prefix is > 0 and <= 65536 && !File.Exists(Path.Combine(output, "map.bin")));
        Receipt(receiptPath, phase, mode, sha, new { retainedPrefixBytes = prefix, interrupted = true, processId = Environment.ProcessId });
    } else {
        var jobs = await queue.GetJobsAsync(token); Require(jobs.Count == 1);
        var job = jobs.Single(); jobId = job.JobId;
        Require(job.Destination == output && job.FileName == "map.bin" && job.Length == 2 * 1024 * 1024 && job.Sha256 == sha);
        if (phase == "resume") {
            using var prior = JsonDocument.Parse(ReadSmall(Path.Combine(root, "interrupt.receipt.json")));
            Require(prior.RootElement.GetProperty("result").GetProperty("processId").GetInt32() != Environment.ProcessId);
            Require(job.State == QueuedTransferState.Paused && Partial(output) is > 0 and <= 65536);
            await queue.StartAsync(jobId, cancellationToken: token); await queue.WaitForIdleAsync(token);
            Require((await queue.GetJobsAsync(token)).Single().State == QueuedTransferState.Completed);
            await Verified(Path.Combine(output, "map.bin"), sha, token);
            Receipt(receiptPath, phase, mode, sha, new { restarted = true, finalHashVerified = true });
        } else if (phase == "existing-destination") {
            Require(job.State == QueuedTransferState.Completed);
            var existing = Path.Combine(root, "existing"); Require(!Directory.Exists(existing)); Directory.CreateDirectory(existing);
            var sentinel = Path.Combine(existing, "map.bin"); WriteNew(sentinel, "owned acceptance sentinel\n");
            var before = Hash(File.ReadAllText(sentinel));
            var resolved = await source.ResolveAsync(job.ResourceReference, token); Fixture(resolved.Spec, sha);
            var refused = false;
            try { await source.DownloadAsync(resolved.Spec, existing, cancellationToken: token); }
            catch (TransferException) { refused = true; }
            Require(refused && Hash(File.ReadAllText(sentinel)) == before);
            Receipt(receiptPath, phase, mode, sha, new { existingDestinationPreserved = true });
        } else {
            // Arm while the grant is still active. Keep the short byte selector only
            // in this process, then let the separate owner workflow revoke access.
            var saved = await source.ResolveAsync(job.ResourceReference, token); Fixture(saved.Spec, sha);
            Require(saved.LogicalFileId == job.LogicalFileId && saved.RemoteVersion == job.RemoteVersion && saved.Spec.ETag == job.ETag);
            Console.WriteLine(JsonSerializer.Serialize(new { schemaVersion = 1, phase, mode, eventName = "armed-awaiting-owner-revocation",
                instruction = "Revoke only this fixture grant through its owner workflow; then enter REVOKED within 90 seconds." }));
            using var revokeDeadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            revokeDeadline.CancelAfter(TimeSpan.FromSeconds(90));
            Require(await Console.In.ReadLineAsync(revokeDeadline.Token) == "REVOKED");
            var refused = false; string? resolutionDenial = null;
            try { await source.ResolveAsync(job.ResourceReference, token); }
            catch (Exception e) when (e is AccessDeniedException or ResourceUnavailableException) { refused = true; resolutionDenial = Denial(e); }
            Require(refused); // Auth expiry/transport errors are NOT proof of grant revocation.
            var revokedOutput = Path.Combine(root, "revoked"); Require(!Directory.Exists(revokedOutput)); Directory.CreateDirectory(revokedOutput);
            var savedDenied = false; string? byteDenial = null;
            try { await source.DownloadAsync(saved.Spec, revokedOutput, cancellationToken: token); }
            catch (Exception e) when (e is AccessDeniedException or ResourceUnavailableException) { savedDenied = true; byteDenial = Denial(e); }
            Require(savedDenied && !File.Exists(Path.Combine(revokedOutput, "map.bin")));
            Require(await Undiscoverable(mode, selection, session, token));
            await Verified(Path.Combine(output, "map.bin"), sha, token);
            Receipt(receiptPath, phase, mode, sha, new { durableReferenceDenied = true, existingLocalCopyPreserved = true,
                savedByteHandleDenied = true, discoveryDenied = true, resolutionDenial, byteDenial,
                ownerRevocationIndependentlyVerified = false });
        }
    }
}

static async Task<bool> Undiscoverable(string mode, string selection, CloudflareAccessSession session, CancellationToken token) {
    if (mode == "employee") {
        using var client = new EmployeeClient(session);
        return (await client.GetRootsAsync(token)).All(root => root.RootId != selection);
    }
    using var portal = new PortalClient(session);
    var page = await portal.GetDeliveriesAsync(cancellationToken: token);
    Require(page.NextCursor is null);
    return page.Items.All(item => item.DisplayName != selection);
}

static async Task<string> Discover(string mode, string selection, CloudflareAccessSession session, QueuedDownloadSource source, CancellationToken token)
{
    if (mode == "employee") {
        using var client = new EmployeeClient(session);
        var roots = await client.GetRootsAsync(token); var root = roots.Single(r => r.RootId == selection);
        var folder = await client.GetEntriesAsync(root.RootId, cancellationToken: token);
        Require(folder.NextCursor is null && folder.Entries.Count == 1 && folder.Entries.Single().Name == "map.bin" && folder.Entries.Single().Kind == "file");
        return (await ((EmployeeQueuedDownloadSource)source).GetReferenceAsync(root.RootId, "map.bin", token)).ResourceReference;
    }
    using var portal = new PortalClient(session);
    var deliveries = await portal.GetDeliveriesAsync(cancellationToken: token);
    Require(deliveries.NextCursor is null);
    var delivery = deliveries.Items.Single(item => item.DisplayName == selection);
    var page = await portal.GetFolderAsync(delivery.Handle, cancellationToken: token);
    Require(page.NextCursor is null && page.Folders.Count == 0 && page.Files.Count == 1);
    var file = page.Files.Single(); Require(file.Name == "map.bin" && file.Size == 2 * 1024 * 1024 && file.DownloadAvailable);
    return (await ((PortalQueuedDownloadSource)source).GetReferenceAsync(file.Handle, token)).ResourceReference;
}
static void Fixture(DownloadSpec spec, string sha) => Require(spec.FileName == "map.bin" && spec.Length == 2 * 1024 * 1024 && spec.Sha256 == sha);
static string Denial(Exception error) => error is AccessDeniedException ? "HTTP403" : "HTTP404-or-409";
static long Partial(string output) {
    var state = Path.Combine(output, ".ltds-downloads-v1"); PlainPath(state);
    var paths = Directory.GetFiles(state, "*.part", SearchOption.TopDirectoryOnly); Require(paths.Length == 1); PlainPath(paths[0]);
    return new FileInfo(paths[0]).Length;
}
static async Task Verified(string path, string sha, CancellationToken token) {
    PlainPath(path); using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
    Require(stream.Length == 2 * 1024 * 1024 && Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, token)) == sha);
}
static void Receipt(string path, string phase, string mode, string sha, object result) {
    var text = JsonSerializer.Serialize(new { schemaVersion = 1, kind = "windows-live-staging-acceptance", phase, mode,
        bytes = 2 * 1024 * 1024, sha256 = sha, at = DateTimeOffset.UtcNow, result,
        harnessSha256 = AssemblyHash(System.Reflection.Assembly.GetExecutingAssembly()), coreSha256 = AssemblyHash(typeof(TransferQueue).Assembly),
        claims = new { productionQualified = false, installerQualified = false, httpRangeObserved = false, cloudGrantChanged = false } });
    WriteNew(path, text); Console.WriteLine(text);
}
static string AssemblyHash(System.Reflection.Assembly assembly) { using var stream = File.OpenRead(assembly.Location); return Convert.ToHexStringLower(SHA256.HashData(stream)); }
static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
static void Require(bool condition) { if (!condition) throw new InvalidOperationException("Acceptance assertion failed."); }
static void PlainPath(string path) {
    Require(Path.IsPathFullyQualified(path) && !path.StartsWith(@"\\", StringComparison.Ordinal));
    for (var current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current))
        if (File.Exists(current) || Directory.Exists(current)) Require((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0);
}
static void WriteNew(string path, string value) { PlainPath(path); using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None); stream.Write(Encoding.UTF8.GetBytes(value)); stream.Flush(true); }
static string ReadSmall(string path) { PlainPath(path); Require(new FileInfo(path).Length <= 16 * 1024); return File.ReadAllText(path); }
sealed record RunMarker(int SchemaVersion, Guid RunId, string Mode, string Sha256, string SelectionSha256);
sealed class InlineProgress(Action<DownloadProgress> action) : IProgress<DownloadProgress> { public void Report(DownloadProgress value) => action(value); }
