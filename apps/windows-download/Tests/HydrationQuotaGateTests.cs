using LedgeTop.WindowsDownload;

internal static class HydrationQuotaGateTests
{
    private sealed class SharingError : IOException { internal SharingError() : base("synthetic sharing error") { HResult = unchecked((int)0x80070020); } }
    private sealed class CodeError : IOException { internal CodeError(int code) { HResult = code; } }
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("quota monitor wait times out and cancels without releasing another owner", Waiters),
        ("quota monitor executes once and preserves reentrant use", Reentrant),
        ("committed cleanup ignores cancellation while normal mutation refuses", CleanupCancellation),
        ("quota file sharing retry preserves deadline cancellation and single action", FileSharing),
        ("quota file lock retries exact HRESULT and respects cross-process timing", FileSharingEdgeCases),
        ("legacy lock retries peer contention without blocking other roots", LegacyPeerRetry)
    ];

    private static async Task Waiters()
    {
        var gate = new object(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var owner = Task.Run(() => { lock (gate) { entered.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("Test owner was not released."); } });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var mutations = 0;
        var observedWait = TimeSpan.Zero; var observedHeld = TimeSpan.Zero;
        try {
            var timeout = await Task.Run(() => {
                try { HydrationQuotaGate.Run(gate, () => Interlocked.Increment(ref mutations), wait: TimeSpan.FromMilliseconds(120), observe: (waited, held) => { observedWait = waited; observedHeld = held; }); return false; }
                catch (TransferException error) { return error.Reason == TransferFailureReason.LocalCacheBusy; }
            }).WaitAsync(TimeSpan.FromSeconds(5));
            if (!timeout || mutations != 0 || owner.IsCompleted || observedWait < TimeSpan.FromMilliseconds(100) || observedHeld != TimeSpan.Zero)
                throw new IOException("Quota timeout changed owner, ran mutation or omitted its wait measurement.");
            var display = HydrationFailureDiagnostic.FromException(HydrationStage.CachePreparation,
                new TransferException("busy", TransferFailureReason.LocalCacheBusy)).ActivityText;
            if (!display.Contains("local file cache is busy", StringComparison.Ordinal) || !display.Contains("LocalCacheBusy", StringComparison.Ordinal))
                throw new IOException("Quota timeout did not produce a local-cache Activity message.");

            using var cancel = new CancellationTokenSource();
            var cancellationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var waiter = Task.Run(() => {
                cancellationStarted.TrySetResult();
                try { HydrationQuotaGate.Run(gate, () => Interlocked.Increment(ref mutations), cancel.Token); return false; }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested) { return true; }
            });
            await cancellationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancel.Cancel();
            if (!await waiter.WaitAsync(TimeSpan.FromSeconds(5)) || mutations != 0 || owner.IsCompleted)
                throw new IOException("Quota cancellation changed owner or ran mutation.");
        } finally { release.Set(); }
        await owner.WaitAsync(TimeSpan.FromSeconds(5));
        HydrationQuotaGate.Run(gate, () => mutations++);
        if (mutations != 1) throw new IOException("Quota did not recover after the owner exited.");
    }

    private static Task Reentrant()
    {
        var gate = new object(); var calls = 0;
        HydrationQuotaGate.Run(gate, () => HydrationQuotaGate.Run(gate, () => calls++));
        if (calls != 1) throw new IOException("Reentrant quota operation did not complete exactly once.");
        return Task.CompletedTask;
    }
    private static Task CleanupCancellation()
    {
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        var calls = 0; var passedToken = new CancellationToken(true);
        using (HydrationMutationScope.Begin((action, token) => { passedToken = token; token.ThrowIfCancellationRequested(); action(); }, cancellation.Token)) {
            var rejected = false;
            try { HydrationMutationScope.Run(() => calls++, cancellation.Token); } catch (OperationCanceledException) { rejected = true; }
            if (!rejected || calls != 0) throw new IOException("Cancelled mutation was not refused.");
            HydrationMutationScope.Run(() => calls++, cancellation.Token, committedCleanup: true);
            if (calls != 1 || passedToken.CanBeCanceled) throw new IOException("Committed cleanup incorrectly inherited cancellation.");
        }
        return Task.CompletedTask;
    }
    private static async Task FileSharing()
    {
        if (!OperatingSystem.IsWindows()) return;
        var path = Path.Combine(Path.GetTempPath(), "lt-quota-test-" + Guid.NewGuid().ToString("N"));
        var gate = new object(); int opens = 0, calls = 0, checkedRoots = 0;
        FileStream Open() { Interlocked.Increment(ref opens); return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        try {
            using (var held = Open()) {
                opens = 0;
                var waiter = Task.Run(() => HydrationQuotaGate.RunWithFileLock(gate, Open, () => Interlocked.Increment(ref calls), wait: TimeSpan.FromSeconds(2), validate: () => Interlocked.Increment(ref checkedRoots)));
                var until = System.Diagnostics.Stopwatch.StartNew();
                while (Volatile.Read(ref opens) < 2 && until.Elapsed < TimeSpan.FromSeconds(1)) await Task.Delay(10);
                if (opens < 2 || calls != 0 || !Monitor.TryEnter(gate, TimeSpan.FromMilliseconds(200))) throw new IOException("Sharing wait did not release monitor.");
                Monitor.Exit(gate);
                held.Dispose(); await waiter.WaitAsync(TimeSpan.FromSeconds(3));
                if (calls != 1 || checkedRoots != opens) throw new IOException("Action count or repeated root validation differed.");
            }
            using (var held = Open()) {
                calls = 0; using var cancel = new CancellationTokenSource(100);
                try { await Task.Run(() => HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++, cancel.Token, TimeSpan.FromSeconds(2))); throw new IOException("Cancellation ignored."); }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested) { }
                if (calls != 0) throw new IOException("Cancelled action executed.");
                var capped = System.Diagnostics.Stopwatch.StartNew();
                try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++, wait: TimeSpan.FromSeconds(3)); throw new IOException("File retry cap was ignored."); }
                catch (TransferException e) when (e.Reason == TransferFailureReason.LocalCacheBusy) { }
                if (capped.Elapsed < TimeSpan.FromMilliseconds(350) || capped.Elapsed > TimeSpan.FromSeconds(2) || calls != 0) throw new IOException("File retry was not bounded independently of the monitor deadline.");
                try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++, wait: TimeSpan.FromMilliseconds(120)); throw new IOException("Contention did not time out."); }
                catch (TransferException e) when (e.Reason == TransferFailureReason.LocalCacheBusy) { }
            }
            opens = 0; calls = 0;
            try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => { calls++; throw new IOException("action failure"); }); throw new IOException("Action failure swallowed."); }
            catch (IOException e) when (e.Message == "action failure") { }
            if (opens != 1 || calls != 1) throw new IOException("Action was retried.");
            opens = 0; calls = 0;
            try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => { calls++; throw new SharingError(); }); throw new IOException("Action failure swallowed."); }
            catch (SharingError) { }
            if (opens != 1 || calls != 1) throw new IOException("Sharing-shaped action failure was retried.");
            opens = 0; var validations = 0;
            try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++, validate: () => { validations++; throw new SharingError(); }); throw new IOException("Validation failure swallowed."); }
            catch (SharingError) { }
            if (opens != 0 || validations != 1) throw new IOException("Validation failure was retried.");
            opens = 0;
            try { HydrationQuotaGate.RunWithFileLock(gate, () => { opens++; throw new UnauthorizedAccessException(); }, () => calls++); throw new IOException("Open failure swallowed."); }
            catch (UnauthorizedAccessException) { }
            if (opens != 1) throw new IOException("Non-sharing open failure retried.");
            lock (gate) { try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++); throw new IOException("Reentrant acquisition accepted."); } catch (InvalidOperationException) { } }
        } finally { if (File.Exists(path)) File.Delete(path); }
    }
    private static async Task FileSharingEdgeCases()
    {
        if (!OperatingSystem.IsWindows()) return;
        var gate = new object(); var path = Path.Combine(Path.GetTempPath(), "lt-quota-peer-" + Guid.NewGuid().ToString("N"));
        var opens = 0; var actions = 0;
        FileStream Open() { Interlocked.Increment(ref opens); return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        try {
            HydrationQuotaGate.RunWithFileLock(gate, () => { if (opens++ == 0) throw new CodeError(unchecked((int)0x80070021)); return new MemoryStream(); }, () => actions++, wait: TimeSpan.FromSeconds(2));
            if (opens != 2 || actions != 1) throw new IOException("Lock violation was not retried once.");
            opens = 0; actions = 0;
            try { HydrationQuotaGate.RunWithFileLock(gate, () => { opens++; throw new CodeError(unchecked((int)0x80040020)); }, () => actions++); throw new IOException("Wrong facility accepted."); }
            catch (CodeError) { }
            if (opens != 1 || actions != 0) throw new IOException("Wrong facility was retried.");
            using (var cancellation = new CancellationTokenSource()) {
                var stream = new MemoryStream();
                try { HydrationQuotaGate.RunWithFileLock(gate, () => { cancellation.Cancel(); return stream; }, () => actions++, cancellation.Token); throw new IOException("Post-open cancellation ignored."); }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
                if (stream.CanRead || actions != 0) throw new IOException("Cancellation leaked lock or ran action.");
            }
            var start = new System.Diagnostics.ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true };
            foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-Command", "$f=[IO.File]::Open($env:LT_QUOTA_TEST_PATH,'OpenOrCreate','ReadWrite','None'); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()" }) start.ArgumentList.Add(a);
            start.Environment["LT_QUOTA_TEST_PATH"] = path;
            using var child = System.Diagnostics.Process.Start(start) ?? throw new IOException("Peer did not start.");
            try {
                if (await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)) != "ready") throw new IOException("Peer did not acquire the lock.");
                opens = 0; var t = System.Diagnostics.Stopwatch.StartNew();
                try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => actions++, wait: TimeSpan.FromSeconds(2)); throw new IOException("Peer lock was ignored."); }
                catch (TransferException e) when (e.Reason == TransferFailureReason.LocalCacheBusy) { }
                if (opens < 2 || actions != 0 || t.Elapsed > TimeSpan.FromSeconds(2)) throw new IOException("Peer conflict did not time out safely.");
                var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                using var release = new ManualResetEventSlim();
                var monitorOwner = Task.Run(() => { lock (gate) { entered.SetResult(); if (!release.Wait(TimeSpan.FromSeconds(3))) throw new TimeoutException(); } });
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
                var total = System.Diagnostics.Stopwatch.StartNew();
                var bounded = Task.Run(() => { try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => actions++, wait: TimeSpan.FromMilliseconds(400)); return false; } catch (TransferException e) when (e.Reason == TransferFailureReason.LocalCacheBusy) { return true; } });
                await Task.Delay(240); release.Set();
                if (!await bounded.WaitAsync(TimeSpan.FromSeconds(2)) || total.Elapsed > TimeSpan.FromMilliseconds(625) || actions != 0) throw new IOException("Monitor and file did not share the original deadline.");
                await monitorOwner.WaitAsync(TimeSpan.FromSeconds(2));
                await child.StandardInput.WriteLineAsync("release"); await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                HydrationQuotaGate.RunWithFileLock(gate, Open, () => actions++);
                if (actions != 1 || child.ExitCode != 0) throw new IOException("Peer release did not recover.");
            } finally { if (!child.HasExited) { child.Kill(entireProcessTree: true); await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); } }
            using var second = System.Diagnostics.Process.Start(start) ?? throw new IOException("Second peer did not start.");
            Task? waiting = null;
            try {
                if (await second.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)) != "ready") throw new IOException("Second peer did not acquire the lock.");
                opens = 0; actions = 0;
                waiting = Task.Run(() => HydrationQuotaGate.RunWithFileLock(gate, Open, () => Interlocked.Increment(ref actions), wait: TimeSpan.FromSeconds(2)));
                var deadline = System.Diagnostics.Stopwatch.StartNew();
                while (Volatile.Read(ref opens) < 2 && deadline.Elapsed < TimeSpan.FromMilliseconds(300)) await Task.Delay(5);
                if (Volatile.Read(ref opens) < 2 || Volatile.Read(ref actions) != 0) throw new IOException("Retry did not encounter peer lock.");
                await second.StandardInput.WriteLineAsync("release");
                await second.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                await waiting.WaitAsync(TimeSpan.FromSeconds(2));
                if (actions != 1 || opens < 2 || second.ExitCode != 0) throw new IOException("Retry did not recover after peer release.");
            } finally {
                if (!second.HasExited) { second.Kill(entireProcessTree: true); await second.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
                if (waiting is not null) { try { await waiting.WaitAsync(TimeSpan.FromSeconds(3)); } catch (TransferException) { } }
            }
        } finally { if (File.Exists(path)) File.Delete(path); }
    }
    private static async Task LegacyPeerRetry()
    {
        if (!OperatingSystem.IsWindows()) return;
        var root = Path.Combine(Path.GetTempPath(), "lt-legacy-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var path = Path.Combine(root, ".hydration-cache.lock");
        var start = new System.Diagnostics.ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true };
        foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-Command", "$f=[IO.File]::Open($env:LT_LEGACY_TEST_PATH,'OpenOrCreate','ReadWrite','None'); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()" }) start.ArgumentList.Add(a);
        start.Environment["LT_LEGACY_TEST_PATH"] = path;
        using var peer = System.Diagnostics.Process.Start(start) ?? throw new IOException("Peer failed to start.");
        Task? pending = null;
        try {
            if (await peer.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)) != "ready") throw new IOException("Peer lock unavailable.");
            using var lease = await HydrationCacheConcurrency.AcquireAsync(root, "one", CancellationToken.None);
            var checks = 0;
            pending = Task.Run(() => lease.AcquireExclusiveLegacy(path, FileMode.Open, validate: () => Interlocked.Increment(ref checks)));
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while (Volatile.Read(ref checks) < 2 && clock.Elapsed < TimeSpan.FromMilliseconds(300)) await Task.Delay(5);
            if (checks < 2) throw new IOException("Peer conflict did not retry.");
            using (var unrelated = await HydrationCacheConcurrency.AcquireAsync(root + "-other", "other", CancellationToken.None)) { }
            await peer.StandardInput.WriteLineAsync("release"); await peer.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3));
            await pending.WaitAsync(TimeSpan.FromSeconds(2));
            if (peer.ExitCode != 0) throw new IOException("Peer did not release cleanly.");
            using var sameRoot = await HydrationCacheConcurrency.AcquireAsync(root, "two", CancellationToken.None);
            sameRoot.AcquireExclusiveLegacy(path, FileMode.Open);
        } finally {
            if (!peer.HasExited) { peer.Kill(entireProcessTree: true); await peer.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
            if (pending is not null) { try { await pending.WaitAsync(TimeSpan.FromSeconds(3)); } catch (TransferException) { } }
            if (File.Exists(path)) File.Delete(path); Directory.Delete(root);
        }
        var absentRoot = root + "-absent"; Directory.CreateDirectory(absentRoot);
        try {
            using var missing = await HydrationCacheConcurrency.AcquireAsync(absentRoot, "one", CancellationToken.None);
            try { missing.AcquireExclusiveLegacy(Path.Combine(absentRoot, "missing"), FileMode.Open); throw new IOException("Missing open accepted."); } catch (FileNotFoundException) { }
            var validations = 0;
            try { missing.AcquireExclusiveLegacy(Path.Combine(absentRoot, "missing"), FileMode.Open, validate: () => { validations++; throw new SharingError(); }); throw new IOException("Validation failure swallowed."); } catch (SharingError) { }
            if (validations != 1) throw new IOException("Sharing-shaped validation failure retried.");
        } finally { Directory.Delete(absentRoot); }
        var blockedRoot = root + "-blocked"; Directory.CreateDirectory(blockedRoot); var blockedPath = Path.Combine(blockedRoot, "lock");
        try {
            using var held = new FileStream(blockedPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            using var cancelled = new CancellationTokenSource();
            using var first = await HydrationCacheConcurrency.AcquireAsync(blockedRoot, "first", CancellationToken.None);
            var attempts = 0;
            var task = Task.Run(() => first.AcquireExclusiveLegacy(blockedPath, FileMode.Open, cancelled.Token, () => Interlocked.Increment(ref attempts)));
            var sw = System.Diagnostics.Stopwatch.StartNew(); while (Volatile.Read(ref attempts) < 2 && sw.Elapsed < TimeSpan.FromMilliseconds(300)) await Task.Delay(5);
            if (Volatile.Read(ref attempts) < 2) throw new IOException("Cancellation test did not enter retry.");
            cancelled.Cancel(); try { await task.WaitAsync(TimeSpan.FromSeconds(2)); throw new IOException("Cancellation was ignored."); } catch (OperationCanceledException) { }
            var second = await HydrationCacheConcurrency.AcquireAsync(blockedRoot, "second", CancellationToken.None); attempts = 0;
            var disposed = Task.Run(() => second.AcquireExclusiveLegacy(blockedPath, FileMode.Open, validate: () => Interlocked.Increment(ref attempts)));
            sw.Restart(); while (Volatile.Read(ref attempts) < 2 && sw.Elapsed < TimeSpan.FromMilliseconds(300)) await Task.Delay(5);
            if (Volatile.Read(ref attempts) < 2) throw new IOException("Disposal test did not enter retry.");
            second.Dispose(); try { await disposed.WaitAsync(TimeSpan.FromSeconds(2)); throw new IOException("Disposed admission was reused."); } catch (ObjectDisposedException) { }
        } finally { if (File.Exists(blockedPath)) File.Delete(blockedPath); Directory.Delete(blockedRoot); }
    }
}
