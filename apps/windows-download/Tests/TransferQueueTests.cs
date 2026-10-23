using System.Net;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using LedgeTop.WindowsDownload;

internal static class TransferQueueTests
{
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("queue durable restart pauses Running and renews exact-content partial", RestartResume),
        ("queue identity change drains active work hides old jobs and expiry needs login", Identity),
        ("queue changed content blocks old partial until explicit new job", ChangedVersion),
        ("queue pause cancel completed file and truthful progress lifecycle", Lifecycle),
        ("queue failed state writes never start bytes and preserve committed completion", StateFailures),
        ("queue rejects unowned malformed ambiguous oversized and foreign state", UnsafeState),
        ("queue process lock and single active job survive duplicate instances", Exclusive),
        ("queue refreshed resolution rechecks principal revocation and exact logical resource", Resolution),
        ("queue interrupted promotion recovers verified existing content without overwriting", ExistingRecovery),
        ("queue refuses reparse state roots and output directories", Reparse),
        ("queue active pause and cancel drain immediately while session discovery is blocked", OfflineStop),
        ("queue inactive pause and cancel persist offline across restart", OfflineQueuedStop),
        ("queue local pause fences a start already awaiting sign-in", PendingStartStop),
        ("queue prepared start cannot outlive a newer local pause or cancel", PreparedStartStop),
        ("queue prepared start is bound to its original queue instance", PreparedStartOwner),
        ("queue prepared start still verifies the current principal", PreparedStartIdentity),
        ("queue record and serialized byte caps reject without starting transfers", Bounds),
        ("queue unavailable destinations isolate jobs across reopen and explicit retry", MissingDestinations),
        ("queue stored destinations remain canonical absolute local paths", DestinationSyntax),
        ("queue rechecks replaced destination aliases before new and recovery bytes", ReopenedDestinationReparse)
    ];
    private static void Assert(bool value) { if (!value) throw new Exception("Queue assertion failed."); }
    private static async Task<T> Throws<T>(Func<Task> action) where T : Exception {
        try { await action(); } catch (T error) { return error; } throw new Exception("Expected fail-closed queue failure.");
    }
    private static async Task<QueuedTransfer> Job(TransferQueue queue, Guid id) => (await queue.GetJobsAsync()).Single(job => job.JobId == id);
    private static string State(Fixture fixture) => Path.Combine(fixture.State, "queue.json");
    private static string Part(Fixture fixture) => Directory.GetFiles(fixture.Output, "*.part", SearchOption.AllDirectories).Single();

    private static async Task RestartResume() {
        using var fixture = new Fixture(); var source = new Source { Mode = Mode.Block };
        byte[] running; Guid id;
        await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) {
            id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
            await queue.StartAsync(id); await source.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(5));
            running = await File.ReadAllBytesAsync(State(fixture));
            Assert(Encoding.UTF8.GetString(running).Contains("Running", StringComparison.Ordinal));
            await queue.PauseAsync(id); Assert((await Job(queue, id)).State == QueuedTransferState.Paused);
            Assert(new FileInfo(Part(fixture)).Length == 7);
        }
        // Restore the exact persisted Running snapshot observed before the
        // simulated crash. The owned partial was produced by real Downloader.
        await File.WriteAllBytesAsync(State(fixture), running);
        source.Mode = Mode.Normal;
        await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) {
            Assert((await Job(queue, id)).State == QueuedTransferState.Paused);
            Assert(source.DownloadCalls == 1); // no automatic restart
            await queue.RetryAsync(id); await queue.WaitForIdleAsync();
            Assert((await Job(queue, id)).State == QueuedTransferState.Completed);
            Assert(source.LastOffset == 7 && source.Resolutions >= 3);
            Assert((await File.ReadAllBytesAsync(Path.Combine(fixture.Output, "map.bin"))).SequenceEqual(source.Bytes));
            var text = await File.ReadAllTextAsync(State(fixture));
            Assert(text.Contains("odqr1_resource_one", StringComparison.Ordinal));
            Assert(!text.Contains("eof1_", StringComparison.Ordinal) && !text.Contains("secret-token", StringComparison.Ordinal)
                && !text.Contains("Cf-Access", StringComparison.Ordinal) && !text.Contains("/downloads/", StringComparison.Ordinal));
        }
    }

    private static async Task Identity() {
        using var fixture = new Fixture(); var source = new Source { Mode = Mode.Block };
        await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) {
            var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
            await queue.StartAsync(id); await source.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(5));
            source.Principal = "odqp1_" + new string('b', 64);
            await Throws<AccessDeniedException>(() => queue.RefreshSessionAsync());
            await queue.WaitForIdleAsync(); Assert(source.Cancelled);
            await Throws<AccessDeniedException>(() => queue.GetJobsAsync());
            await Throws<AccessDeniedException>(() => queue.RetryAsync(id));
            source.Principal = Source.Owner;
            Assert((await Job(queue, id)).State == QueuedTransferState.Paused);
            source.Expiry = DateTimeOffset.UtcNow.AddSeconds(-1);
            await Throws<LoginRequiredException>(() => queue.RetryAsync(id));
            Assert(source.DownloadCalls == 1);
            source.Expiry = DateTimeOffset.UtcNow.AddHours(1);
        }
        source.Principal = "odqp1_" + new string('b', 64);
        await Throws<AccessDeniedException>(async () => { await using var _ = await TransferQueue.OpenAsync(fixture.State, source); });
    }

    private static async Task ChangedVersion() {
        using var fixture = new Fixture(); var source = new Source { Mode = Mode.Block };
        await using var queue = await TransferQueue.OpenAsync(fixture.State, source);
        var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
        await queue.StartAsync(id); await source.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(5)); await queue.PauseAsync(id);
        var partial = Part(fixture); var previous = await File.ReadAllBytesAsync(partial);
        source.Bytes = "entirely different synthetic revision"u8.ToArray(); source.Mode = Mode.Normal;
        await queue.RetryAsync(id); await queue.WaitForIdleAsync();
        Assert((await Job(queue, id)).State == QueuedTransferState.VersionChanged && source.DownloadCalls == 1);
        Assert((await File.ReadAllBytesAsync(partial)).SequenceEqual(previous));
        await Throws<TransferException>(() => queue.RetryAsync(id));
        var next = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
        await queue.StartAsync(next); await queue.WaitForIdleAsync();
        Assert((await Job(queue, next)).State == QueuedTransferState.Completed && source.LastOffset == 0);
        Assert((await File.ReadAllBytesAsync(partial)).SequenceEqual(previous));
        Assert((await File.ReadAllBytesAsync(Path.Combine(fixture.Output, "map.bin"))).SequenceEqual(source.Bytes));
    }

    private static async Task Lifecycle() {
        using var fixture = new Fixture(); var source = new Source { Mode = Mode.Block };
        await using var queue = await TransferQueue.OpenAsync(fixture.State, source);
        var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
        await queue.StartAsync(id); await source.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(5)); await queue.CancelAsync(id);
        Assert((await Job(queue, id)).State == QueuedTransferState.Cancelled && !File.Exists(Path.Combine(fixture.Output, "map.bin")));
        await queue.PauseAsync(id); await Throws<TransferException>(() => queue.RetryAsync(id));
        source.Mode = Mode.Normal; var progress = new List<DownloadProgress>();
        var next = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
        await queue.StartAsync(next, new Observer(value => progress.Add(value))); await queue.WaitForIdleAsync();
        Assert((await Job(queue, next)).State == QueuedTransferState.Completed);
        Assert(progress.Any(value => value.Phase == DownloadPhase.Verifying) && progress.Last().Phase == DownloadPhase.Completed);
        Assert(progress.Last().BytesTransferred == source.Bytes.Length);
        await queue.CancelAsync(next);
        Assert((await Job(queue, next)).State == QueuedTransferState.Completed && File.Exists(Path.Combine(fixture.Output, "map.bin")));
        await Throws<TransferException>(() => queue.RetryAsync(next));
    }

    private static async Task StateFailures() {
        using (var fixture = new Fixture()) {
            var source = new Source(); await using var queue = await TransferQueue.OpenAsync(fixture.State, source);
            var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
            using (var locked = new FileStream(State(fixture), FileMode.Open, FileAccess.Read, FileShare.Read)) {
                await Throws<QueueStorageException>(() => queue.StartAsync(id));
                Assert(source.DownloadCalls == 0 && source.Resolutions == 1);
                await Throws<QueueStorageException>(() => queue.EnqueueAsync("odqr1_resource_two", fixture.Output));
            }
            Assert((await queue.GetJobsAsync()).Count == 1);
        }
        using (var fixture = new Fixture()) {
            var source = new Source(); var queue = await TransferQueue.OpenAsync(fixture.State, source);
            FileStream? block = null;
            try {
                var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
                source.AfterCompleted = _ => { block = new FileStream(State(fixture), FileMode.Open, FileAccess.Read, FileShare.Read); return Task.CompletedTask; };
                await queue.StartAsync(id);
                var error = await Throws<QueueStorageException>(() => queue.WaitForIdleAsync());
                Assert(error.CompletedFilePath == Path.Combine(fixture.Output, "map.bin"));
                Assert((await File.ReadAllBytesAsync(error.CompletedFilePath!)).SequenceEqual(source.Bytes));
                await Throws<QueueStorageException>(() => queue.RetryAsync(id)); Assert(source.DownloadCalls == 1);
            } finally { block?.Dispose(); try { await queue.DisposeAsync(); } catch (QueueStorageException) { } }
            await using var recovered = await TransferQueue.OpenAsync(fixture.State, source);
            var job = (await recovered.GetJobsAsync()).Single(); Assert(job.State == QueuedTransferState.Paused);
            source.AfterCompleted = null;
            await recovered.RetryAsync(job.JobId); await recovered.WaitForIdleAsync();
            Assert((await Job(recovered, job.JobId)).State == QueuedTransferState.Completed);
            Assert(source.DownloadCalls == 1);
            Assert((await File.ReadAllBytesAsync(Path.Combine(fixture.Output, "map.bin"))).SequenceEqual(source.Bytes));
        }
    }

    private static async Task UnsafeState() {
        using (var unowned = new Fixture()) {
            await File.WriteAllTextAsync(Path.Combine(unowned.State, "unowned.txt"), "leave unchanged");
            await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(unowned.State, new Source()); });
            Assert(await File.ReadAllTextAsync(Path.Combine(unowned.State, "unowned.txt")) == "leave unchanged");
        }
        using var fixture = new Fixture(); var source = new Source(); byte[] original;
        await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) { await queue.EnqueueAsync("odqr1_resource_one", fixture.Output); }
        original = await File.ReadAllBytesAsync(State(fixture));
        var json = Encoding.UTF8.GetString(original);
        foreach (var malformed in new[] { "{}", json.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"schemaVersion\":1", StringComparison.Ordinal),
            json.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"credential\":\"secret\"", StringComparison.Ordinal),
            json.Replace("\"state\":\"Queued\"", "\"state\":123", StringComparison.Ordinal),
            json.Replace("\"resourceReference\":\"odqr1_resource_one\"", "\"resourceReference\":\"https://evil.invalid/token\"", StringComparison.Ordinal) }) {
            await File.WriteAllTextAsync(State(fixture), malformed);
            await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(fixture.State, source); });
        }
        var node = JsonNode.Parse(json)!.AsObject(); node["jobs"]![0]!.AsObject().Remove("state");
        await File.WriteAllTextAsync(State(fixture), node.ToJsonString());
        await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(fixture.State, source); });
        await File.WriteAllBytesAsync(State(fixture), new byte[8 * 1024 * 1024 + 1]);
        await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(fixture.State, source); });
        await File.WriteAllBytesAsync(State(fixture), original);
        await File.WriteAllTextAsync(Path.Combine(fixture.State, ".queue-ambiguous.tmp"), "unfinished");
        await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(fixture.State, source); });
        File.Delete(Path.Combine(fixture.State, ".queue-ambiguous.tmp")); File.Delete(State(fixture));
        await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(fixture.State, source); });
    }

    private static async Task Exclusive() {
        using var fixture = new Fixture(); var source = new Source { Mode = Mode.Block };
        await using var queue = await TransferQueue.OpenAsync(fixture.State, source);
        await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(fixture.State, source); });
        var first = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
        await Throws<TransferException>(() => queue.EnqueueAsync("odqr1_resource_one", fixture.Output));
        var second = await queue.EnqueueAsync("odqr1_resource_two", fixture.Output);
        await queue.StartAsync(first); await source.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Throws<TransferException>(() => queue.StartAsync(second)); Assert(source.DownloadCalls == 1);
        await queue.PauseAsync(first);
    }

    private static async Task Resolution() {
        foreach (var scenario in new[] { "revoked", "wrong-principal", "logical-change", "expired" }) {
            using var fixture = new Fixture(); var source = new Source(); await using var queue = await TransferQueue.OpenAsync(fixture.State, source);
            var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
            if (scenario == "revoked") source.ResolveError = new AccessDeniedException();
            if (scenario == "wrong-principal") source.DuringResolve = () => { source.Principal = "odqp1_" + new string('b', 64); };
            if (scenario == "logical-change") source.Logical = "oef1_" + new string('b', 64);
            if (scenario == "expired") source.DuringResolve = () => { source.Expiry = DateTimeOffset.UtcNow.AddSeconds(-1); };
            await queue.StartAsync(id); await queue.WaitForIdleAsync();
            source.Principal = Source.Owner; source.Expiry = DateTimeOffset.UtcNow.AddHours(1);
            var state = (await Job(queue, id)).State;
            Assert(state == (scenario == "expired" ? QueuedTransferState.LoginRequired : QueuedTransferState.AccessDenied));
            Assert(source.DownloadCalls == 0 && !File.Exists(Path.Combine(fixture.Output, "map.bin")));
        }
    }

    private static async Task ExistingRecovery() {
        foreach (var scenario in new[] { "same", "wrong-hash", "wrong-size", "wrong-person", "fresh-person-after-hash" }) {
            using var fixture = new Fixture(); var source = new Source { Mode = Mode.Block }; byte[] running; Guid id;
            await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) {
                id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
                await queue.StartAsync(id); await source.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(5));
                running = await File.ReadAllBytesAsync(State(fixture)); await queue.PauseAsync(id);
            }
            await File.WriteAllBytesAsync(State(fixture), running);
            var output = Path.Combine(fixture.Output, "map.bin");
            var existing = scenario == "wrong-hash" ? source.Bytes.Select(value => (byte)(value ^ 1)).ToArray()
                : scenario == "wrong-size" ? source.Bytes[..^1] : source.Bytes;
            await File.WriteAllBytesAsync(output, existing); source.Mode = Mode.Normal;
            await using var recovered = await TransferQueue.OpenAsync(fixture.State, source);
            if (scenario == "wrong-person") source.DuringResolve = () => source.Principal = "odqp1_" + new string('b', 64);
            if (scenario == "fresh-person-after-hash") {
                // Retry admission, worker admission, pre-hash admission, then
                // post-hash session: change only the final verified identity.
                var calls = 0; source.BeforeSession = () => { if (++calls == 4) source.Principal = "odqp1_" + new string('b', 64); };
            }
            using (var blocked = scenario == "wrong-person" ? new FileStream(output, FileMode.Open, FileAccess.Read, FileShare.None) : null) {
                await recovered.RetryAsync(id); await recovered.WaitForIdleAsync();
            }
            source.Principal = Source.Owner; source.BeforeSession = null; source.DuringResolve = null;
            var job = await Job(recovered, id);
            Assert(source.DownloadCalls == 1); // only the original interrupted transfer
            Assert((await File.ReadAllBytesAsync(output)).SequenceEqual(existing));
            Assert((await File.ReadAllBytesAsync(Part(fixture))).SequenceEqual(source.Bytes[..7]));
            if (scenario == "same") Assert(job.State == QueuedTransferState.Completed && !job.RecoveryRequired);
            else if (scenario.StartsWith("wrong-", StringComparison.Ordinal) && scenario != "wrong-person")
                Assert(job.State == QueuedTransferState.Failed && job.ErrorCode == "existing-content-mismatch");
            else Assert(job.State == QueuedTransferState.AccessDenied && job.RecoveryRequired);
        }
        // An ordinary new job never adopts an existing file, even exact bytes.
        using var fresh = new Fixture(); var ordinary = new Source();
        await File.WriteAllBytesAsync(Path.Combine(fresh.Output, "map.bin"), ordinary.Bytes);
        await using var initial = await TransferQueue.OpenAsync(fresh.State, ordinary);
        var newJob = await initial.EnqueueAsync("odqr1_resource_one", fresh.Output);
        await initial.StartAsync(newJob); await initial.WaitForIdleAsync();
        Assert((await Job(initial, newJob)).State == QueuedTransferState.Failed);
        Assert((await File.ReadAllBytesAsync(Path.Combine(fresh.Output, "map.bin"))).SequenceEqual(ordinary.Bytes));
    }

    private static async Task Reparse() {
        using var fixture = new Fixture(); var alias = Path.Combine(fixture.Root, "alias");
        if (OperatingSystem.IsWindows()) {
            foreach (var path in new[] { alias, fixture.Output }) Assert(System.Text.RegularExpressions.Regex.IsMatch(path, "\\A[A-Za-z]:[\\\\A-Za-z0-9._ -]+\\z"));
            var start = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                Arguments = "/d /c mklink /J \"" + alias + "\" \"" + fixture.Output + "\"" };
            using var process = Process.Start(start)!; await process.WaitForExitAsync(); Assert(process.ExitCode == 0);
        } else Directory.CreateSymbolicLink(alias, fixture.Output);
        try {
            await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(alias, new Source()); });
            await using var queue = await TransferQueue.OpenAsync(fixture.State, new Source());
            await Throws<TransferException>(() => queue.EnqueueAsync("odqr1_resource_one", alias));
            Assert(!Directory.EnumerateFileSystemEntries(fixture.Output).Any());
        } finally { Directory.Delete(alias); } // Remove only our owned link, never its target.
    }

    private static async Task OfflineStop() {
        foreach (var cancel in new[] { false, true }) {
            using var fixture = new Fixture(); var source = new Source { Mode = Mode.Block };
            await using var queue = await TransferQueue.OpenAsync(fixture.State, source);
            var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
            await queue.StartAsync(id); await source.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var authentication = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            source.SessionWait = authentication.Task;
            var blockedDiscovery = queue.GetJobsAsync();
            await source.SessionRequested.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (cancel) source.Principal = "odqp1_" + new string('b', 64); else source.Expiry = DateTimeOffset.UtcNow.AddSeconds(-1);
            var calls = source.SessionCalls;
            try {
                var stopping = cancel ? queue.CancelAsync(id) : queue.PauseAsync(id);
                await stopping.WaitAsync(TimeSpan.FromSeconds(2));
                Assert(source.Cancelled && source.SessionCalls == calls);
            } finally { authentication.TrySetResult(); }
            if (cancel) await Throws<AccessDeniedException>(() => blockedDiscovery);
            else await Throws<LoginRequiredException>(() => blockedDiscovery);
            source.SessionWait = null; source.Principal = Source.Owner; source.Expiry = DateTimeOffset.UtcNow.AddHours(1);
            Assert((await Job(queue, id)).State == (cancel ? QueuedTransferState.Cancelled : QueuedTransferState.Paused));
            Assert(!File.Exists(Path.Combine(fixture.Output, "map.bin")) && new FileInfo(Part(fixture)).Length == 7);
        }
    }

    private static async Task OfflineQueuedStop() {
        using var fixture = new Fixture(); var source = new Source(); Guid paused, cancelled;
        await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) {
            paused = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
            cancelled = await queue.EnqueueAsync("odqr1_resource_two", fixture.Output);
            var authentication = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            source.SessionWait = authentication.Task;
            using var discoveryCancellation = new CancellationTokenSource();
            var blockedDiscovery = queue.GetJobsAsync(discoveryCancellation.Token);
            await source.SessionRequested.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var calls = source.SessionCalls;
            try {
                await queue.PauseAsync(paused).WaitAsync(TimeSpan.FromSeconds(2));
                await queue.CancelAsync(cancelled).WaitAsync(TimeSpan.FromSeconds(2));
                Assert(source.SessionCalls == calls && !authentication.Task.IsCompleted && source.DownloadCalls == 0);
                // Verify committed state while discovery still owns the command
                // gate. A process exit now must not restore these jobs as Queued.
                var stored = JsonNode.Parse(await File.ReadAllTextAsync(State(fixture)))!["jobs"]!.AsArray();
                Assert(stored.Single(value => value!["jobId"]!.GetValue<Guid>() == paused)!["state"]!.GetValue<string>() == "Paused");
                Assert(stored.Single(value => value!["jobId"]!.GetValue<Guid>() == cancelled)!["state"]!.GetValue<string>() == "Cancelled");
            } finally { discoveryCancellation.Cancel(); authentication.TrySetResult(); }
            await Throws<OperationCanceledException>(() => blockedDiscovery);
            source.SessionWait = null;
        }
        await using var reopened = await TransferQueue.OpenAsync(fixture.State, source);
        Assert((await Job(reopened, paused)).State == QueuedTransferState.Paused);
        Assert((await Job(reopened, cancelled)).State == QueuedTransferState.Cancelled && source.DownloadCalls == 0);
        source.Expiry = DateTimeOffset.UtcNow.AddSeconds(-1);
        await Throws<LoginRequiredException>(() => reopened.RetryAsync(paused));
        Assert(source.DownloadCalls == 0);
    }

    private static async Task PendingStartStop() {
        foreach (var cancel in new[] { false, true }) {
            using var fixture = new Fixture(); var source = new Source();
            await using var queue = await TransferQueue.OpenAsync(fixture.State, source);
            var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
            var authentication = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            source.SessionWait = authentication.Task;
            var starting = queue.StartAsync(id);
            await source.SessionRequested.Task.WaitAsync(TimeSpan.FromSeconds(5));
            try {
                await (cancel ? queue.CancelAsync(id) : queue.PauseAsync(id)).WaitAsync(TimeSpan.FromSeconds(2));
                Assert(!authentication.Task.IsCompleted && source.DownloadCalls == 0);
            } finally { authentication.TrySetResult(); }
            await Throws<TransferException>(() => starting);
            source.SessionWait = null;
            Assert((await Job(queue, id)).State == (cancel ? QueuedTransferState.Cancelled : QueuedTransferState.Paused));
            Assert(source.DownloadCalls == 0 && !File.Exists(Path.Combine(fixture.Output, "map.bin")));
            if (!cancel) {
                await queue.RetryAsync(id); await queue.WaitForIdleAsync();
                Assert((await Job(queue, id)).State == QueuedTransferState.Completed && source.DownloadCalls == 1);
                Assert((await File.ReadAllBytesAsync(Path.Combine(fixture.Output, "map.bin"))).SequenceEqual(source.Bytes));
            }
        }
    }

    private static async Task PreparedStartStop() {
        foreach (var cancel in new[] { false, true }) {
            using var fixture = new Fixture(); var source = new Source();
            await using var queue = await TransferQueue.OpenAsync(fixture.State, source);
            var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
            var saved = await File.ReadAllBytesAsync(State(fixture)); var sessions = source.SessionCalls;
            var pending = queue.PrepareStart(id);
            var afterCapture = await File.ReadAllBytesAsync(State(fixture));
            Assert(source.SessionCalls == sessions && saved.SequenceEqual(afterCapture));
            // The host publishes this prepared intent, then a newer stop finishes before Begin is invoked.
            await (cancel ? queue.CancelAsync(id) : queue.PauseAsync(id));
            await Throws<TransferException>(() => queue.StartAsync(pending));
            Assert((await Job(queue, id)).State == (cancel ? QueuedTransferState.Cancelled : QueuedTransferState.Paused));
            Assert(source.DownloadCalls == 0 && !File.Exists(Path.Combine(fixture.Output, "map.bin")));
            if (!cancel) {
                await queue.StartAsync(queue.PrepareStart(id)); await queue.WaitForIdleAsync();
                Assert((await Job(queue, id)).State == QueuedTransferState.Completed && source.DownloadCalls == 1);
            }
        }
    }

    private static async Task PreparedStartOwner() {
        using var first = new Fixture(); using var second = new Fixture();
        var source = new Source(); var otherSource = new Source();
        await using var queue = await TransferQueue.OpenAsync(first.State, source);
        await using var other = await TransferQueue.OpenAsync(second.State, otherSource);
        var id = await queue.EnqueueAsync("odqr1_resource_one", first.Output);
        var pending = queue.PrepareStart(id); var sessions = otherSource.SessionCalls;
        await Throws<TransferException>(() => other.StartAsync(pending));
        Assert(otherSource.SessionCalls == sessions && otherSource.DownloadCalls == 0 && source.DownloadCalls == 0);
        Assert((await Job(queue, id)).State == QueuedTransferState.Queued);
    }

    private static async Task PreparedStartIdentity() {
        using var fixture = new Fixture(); var source = new Source();
        await using var queue = await TransferQueue.OpenAsync(fixture.State, source);
        var id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
        var pending = queue.PrepareStart(id);
        source.Principal = "odqp1_" + new string('b', 64);
        await Throws<AccessDeniedException>(() => queue.StartAsync(pending));
        Assert(source.DownloadCalls == 0 && !File.Exists(Path.Combine(fixture.Output, "map.bin")));
    }

    private static async Task MissingDestinations() {
        foreach (var scenario in new[] { "queued", "interrupted", "completed" }) {
            using var fixture = new Fixture(); var source = new Source();
            var available = Path.Combine(fixture.Root, "available"); Directory.CreateDirectory(available);
            var disconnected = Path.Combine(fixture.Root, "disconnected"); Guid missing, other; byte[]? running = null;
            await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) {
                missing = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
                other = await queue.EnqueueAsync("odqr1_resource_two", available);
                if (scenario == "interrupted") {
                    source.Mode = Mode.Block; await queue.StartAsync(missing);
                    await source.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    running = await File.ReadAllBytesAsync(State(fixture)); await queue.PauseAsync(missing);
                } else if (scenario == "completed") {
                    await queue.StartAsync(missing); await queue.WaitForIdleAsync(); await queue.PauseAsync(other);
                }
            }
            if (running is not null) await File.WriteAllBytesAsync(State(fixture), running);
            Directory.Move(fixture.Output, disconnected); source.Mode = Mode.Normal;
            await using var reopened = await TransferQueue.OpenAsync(fixture.State, source);
            var items = await reopened.GetJobsAsync(); Assert(items.Count == 2);
            var absent = items.Single(job => job.JobId == missing);
            Assert(absent.State == (scenario == "completed" ? QueuedTransferState.Completed : scenario == "interrupted" ? QueuedTransferState.Paused : QueuedTransferState.Queued));
            Assert(absent.RecoveryRequired == (scenario == "interrupted"));
            Assert(items.Single(job => job.JobId == other).State == (scenario == "completed" ? QueuedTransferState.Paused : QueuedTransferState.Queued));
            await reopened.StartAsync(other); await reopened.WaitForIdleAsync();
            Assert((await Job(reopened, other)).State == QueuedTransferState.Completed);
            Assert((await File.ReadAllBytesAsync(Path.Combine(available, "second.bin"))).SequenceEqual(source.Bytes));
            if (scenario == "completed") { Assert(!Directory.Exists(fixture.Output)); continue; }
            var downloads = source.DownloadCalls; var resolutions = source.Resolutions;
            await reopened.RetryAsync(missing); await reopened.WaitForIdleAsync();
            Assert((await Job(reopened, missing)).State == QueuedTransferState.Failed);
            Assert(source.DownloadCalls == downloads && source.Resolutions == resolutions && !Directory.Exists(fixture.Output));
            Assert((await Job(reopened, other)).State == QueuedTransferState.Completed);
            Directory.Move(disconnected, fixture.Output);
            await reopened.RetryAsync(missing); await reopened.WaitForIdleAsync();
            Assert((await Job(reopened, missing)).State == QueuedTransferState.Completed);
            Assert((await File.ReadAllBytesAsync(Path.Combine(fixture.Output, "map.bin"))).SequenceEqual(source.Bytes));
            Assert(source.LastOffset == (scenario == "interrupted" ? 7 : 0));
        }
    }

    private static async Task ReopenedDestinationReparse() {
        foreach (var interrupted in new[] { false, true }) {
            using var fixture = new Fixture(); var source = new Source(); Guid id; byte[]? running = null;
            await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) {
                id = await queue.EnqueueAsync("odqr1_resource_one", fixture.Output);
                if (interrupted) {
                    source.Mode = Mode.Block; await queue.StartAsync(id); await source.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    running = await File.ReadAllBytesAsync(State(fixture)); await queue.PauseAsync(id);
                }
            }
            if (running is not null) await File.WriteAllBytesAsync(State(fixture), running);
            var target = Path.Combine(fixture.Root, "renamed-output"); Directory.Move(fixture.Output, target);
            if (OperatingSystem.IsWindows()) {
                foreach (var path in new[] { fixture.Output, target }) Assert(System.Text.RegularExpressions.Regex.IsMatch(path, "\\A[A-Za-z]:[\\\\A-Za-z0-9._ -]+\\z"));
                var start = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    Arguments = "/d /c mklink /J \"" + fixture.Output + "\" \"" + target + "\"" };
                using var process = Process.Start(start)!; await process.WaitForExitAsync(); Assert(process.ExitCode == 0);
            } else Directory.CreateSymbolicLink(fixture.Output, target);
            try {
                source.Mode = Mode.Normal; var resolutions = source.Resolutions; var downloads = source.DownloadCalls;
                await using var reopened = await TransferQueue.OpenAsync(fixture.State, source);
                Assert((await Job(reopened, id)).RecoveryRequired == interrupted);
                await reopened.RetryAsync(id); await reopened.WaitForIdleAsync();
                Assert((await Job(reopened, id)).State == QueuedTransferState.Failed);
                Assert(source.Resolutions == resolutions && source.DownloadCalls == downloads);
                Assert(!File.Exists(Path.Combine(target, "map.bin")));
                if (interrupted) Assert(Directory.GetFiles(target, "*.part", SearchOption.AllDirectories).Length == 1);
            } finally { Directory.Delete(fixture.Output); } // Only the owned link, never its target.
        }
    }

    private static async Task DestinationSyntax() {
        using var fixture = new Fixture(); var source = new Source();
        await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) { await queue.EnqueueAsync("odqr1_resource_one", fixture.Output); }
        var original = JsonNode.Parse(await File.ReadAllTextAsync(State(fixture)))!;
        foreach (var destination in new[] { "relative", @"\\server\share\folder", "C:relative", fixture.Output + Path.DirectorySeparatorChar,
            Path.Combine(fixture.Output, "..", "output"), fixture.Output + "\0", @"\\?\C:\folder" }) {
            var state = original.DeepClone(); state["jobs"]![0]!["destination"] = destination;
            await File.WriteAllTextAsync(State(fixture), state.ToJsonString());
            await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(fixture.State, source); });
            Assert(source.DownloadCalls == 0);
        }
    }

    private static async Task Bounds() {
        using var fixture = new Fixture(); var source = new Source();
        await using (var queue = await TransferQueue.OpenAsync(fixture.State, source)) { await queue.EnqueueAsync("odqr1_resource_one", fixture.Output); }
        var initial = JsonNode.Parse(await File.ReadAllTextAsync(State(fixture)))!.AsObject();
        var template = initial["jobs"]![0]!.DeepClone().AsObject();
        JsonObject Item(int index, bool large = false) {
            var value = template.DeepClone().AsObject(); value["jobId"] = Guid.NewGuid().ToString("D");
            value["resourceReference"] = "odqr1_" + (large ? new string('x', 16372) : "r") + index.ToString("000000"); return value;
        }
        var oversized = initial.DeepClone().AsObject(); var tooMany = new JsonArray();
        for (var index = 0; index < 1001; index++) tooMany.Add(Item(index)); oversized["jobs"] = tooMany;
        await File.WriteAllTextAsync(State(fixture), oversized.ToJsonString());
        await Throws<TransferException>(async () => { await using var _ = await TransferQueue.OpenAsync(fixture.State, source); });
        tooMany.RemoveAt(1000); await File.WriteAllTextAsync(State(fixture), oversized.ToJsonString());
        await using (var full = await TransferQueue.OpenAsync(fixture.State, source)) {
            Assert((await full.GetJobsAsync()).Count == 1000);
            await Throws<TransferException>(() => full.EnqueueAsync("odqr1_extra", fixture.Output));
            Assert(source.DownloadCalls == 0);
        }
        var nearLimit = initial.DeepClone().AsObject(); nearLimit["jobs"] = new JsonArray();
        var baseline = Encoding.UTF8.GetByteCount(nearLimit.ToJsonString());
        var perItem = Encoding.UTF8.GetByteCount(Item(0, true).ToJsonString()) + 1;
        var count = (8 * 1024 * 1024 - baseline + 1) / perItem;
        var array = new JsonArray(); for (var index = 0; index < count; index++) array.Add(Item(index, true)); nearLimit["jobs"] = array;
        var bounded = Encoding.UTF8.GetBytes(nearLimit.ToJsonString()); Assert(bounded.Length <= 8 * 1024 * 1024);
        await File.WriteAllBytesAsync(State(fixture), bounded);
        await using (var full = await TransferQueue.OpenAsync(fixture.State, source)) {
            var before = SHA256.HashData(await File.ReadAllBytesAsync(State(fixture)));
            await Throws<QueueStorageException>(() => full.EnqueueAsync("odqr1_" + new string('y', 16378), fixture.Output));
            Assert((await full.GetJobsAsync()).Count == count && source.DownloadCalls == 0);
            Assert(SHA256.HashData(await File.ReadAllBytesAsync(State(fixture))).SequenceEqual(before));
        }
    }

    private enum Mode { Normal, Block }
    private sealed class Source : IQueuedDownloadSource {
        internal const string Owner = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        public string Alias => "employee-synthetic";
        public Uri Origin => new("https://ops.example.invalid");
        internal string Principal = Owner, Logical = "oef1_" + new string('a', 64);
        internal DateTimeOffset Expiry = DateTimeOffset.UtcNow.AddHours(1);
        internal byte[] Bytes = "synthetic queue bytes verify after resume"u8.ToArray();
        internal Mode Mode;
        internal int DownloadCalls, Resolutions;
        internal long LastOffset;
        internal bool Cancelled;
        internal TaskCompletionSource Blocked = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal Exception? ResolveError;
        internal Action? DuringResolve;
        internal Action? BeforeSession;
        internal Task? SessionWait;
        internal TaskCompletionSource SessionRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal int SessionCalls;
        internal Func<string, Task>? AfterCompleted;
        public async Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) {
            cancellationToken.ThrowIfCancellationRequested(); SessionCalls++; BeforeSession?.Invoke();
            if (SessionWait is not null) { SessionRequested.TrySetResult(); await SessionWait.WaitAsync(cancellationToken); }
            return new QueuedDownloadSession(Principal, Expiry);
        }
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default) {
            cancellationToken.ThrowIfCancellationRequested(); Resolutions++; if (ResolveError is not null) throw ResolveError; DuringResolve?.Invoke();
            var sha = Convert.ToHexStringLower(SHA256.HashData(Bytes));
            var logical = resourceReference.EndsWith("two", StringComparison.Ordinal) ? "oef1_" + new string('c', 64) : Logical;
            var spec = new DownloadSpec(logical + ":" + sha, new Uri(Origin, "/api/staff/files/downloads/eof1_secret_current_" + Resolutions),
                resourceReference.EndsWith("two", StringComparison.Ordinal) ? "second.bin" : "map.bin", Bytes.Length, "\"" + sha + "\"", sha);
            return Task.FromResult(new ResolvedQueuedDownload(Principal, logical, sha, spec));
        }
        public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) {
            DownloadCalls++;
            using var downloader = new Downloader(new Handler(request => {
                var offset = request.Headers.Range?.Ranges.Single().From ?? 0; LastOffset = offset;
                var bytes = Bytes; var response = new HttpResponseMessage(offset > 0 ? HttpStatusCode.PartialContent : HttpStatusCode.OK) {
                    Content = new StreamContent(Mode == Mode.Block ? new Blocking(bytes[(int)offset..], Blocked) : new MemoryStream(bytes[(int)offset..]))
                };
                response.Headers.ETag = EntityTagHeaderValue.Parse(spec.ETag); response.Content.Headers.ContentLength = bytes.Length - offset;
                if (offset > 0) response.Content.Headers.ContentRange = new ContentRangeHeaderValue(offset, bytes.Length - 1, bytes.Length);
                return response;
            }), [Origin]);
            try {
                var output = await downloader.DownloadAsync(spec, destination, cancellationToken, progress);
                if (AfterCompleted is not null) await AfterCompleted(output); return output;
            } catch (OperationCanceledException) { Cancelled = true; throw; }
        }
    }
    private sealed class Blocking(byte[] bytes, TaskCompletionSource blocked) : MemoryStream(bytes) {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
            if (Position >= 7) { blocked.TrySetResult(); await Task.Delay(Timeout.Infinite, cancellationToken); }
            return await base.ReadAsync(buffer[..Math.Min(buffer.Length, 7 - (int)Position)], cancellationToken);
        }
    }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> action) : HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(action(request));
    }
    private sealed class Observer(Action<DownloadProgress> action) : IProgress<DownloadProgress> { public void Report(DownloadProgress value) => action(value); }
    private sealed class Fixture : IDisposable {
        internal string Root = Path.Combine(Path.GetTempPath(), "ltds-queue-synthetic-" + Guid.NewGuid().ToString("N"));
        internal string State => Path.Combine(Root, "state");
        internal string Output => Path.Combine(Root, "output");
        internal Fixture() { Directory.CreateDirectory(State); Directory.CreateDirectory(Output); }
        public void Dispose() { Directory.Delete(Root, true); }
    }
}
