using System.Runtime.InteropServices;
using LedgeTop.WindowsDownload;

internal static class CloudFilesConnectionTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static PlaceholderIdentity Identity => new("pilot", "portal", "https://source.example.invalid", Principal,
        "odqr1_dummy", "ondf1_" + new string('b', 64), "v1", "file.bin", 8192, "\"v1\"", new string('c', 64));
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("connection admission refusal settles fetch before dispatcher and retains ticket through hydration", FetchAdmission),
        ("connection trampolines copy borrowed identity before connect returns and root delegates through GC", CopyDuringConnect),
        ("connection rejects malformed and unmapped callbacks without authenticating or guessing zero completion", Rejections),
        ("connection cancellation preserves unsupported subsets and drains exact requests", Cancellation),
        ("connection stop drains hydration and reentrant disconnect callbacks before releasing roots", Stop),
        ("connection failed connect and disconnect quarantine roots and forbid retry", Failures),
        ("connection duplicate capacity cannot fail an admitted hydration", DuplicateCapacity),
        ("connection callback held across disconnect cannot issue late native rejection", HeldCallback),
        ("connection held rejection observer cannot fail a reused tuple", HeldRejectionReuse),
        ("connection rejection retires its tuple atomically before admission gate release", AtomicRetirement),
        ("connection synchronous cancel before connect returns prevents dispatcher admission", ConnectingCancel),
        ("connection bounds pending callbacks and never frees ambiguous connect resources", Capacity),
        ("operational connection expands requested bytes to aligned ranges without exceeding EOF", NativeRanges),
        ("operational connection refuses invalid and overflowing ranges before hydration", NativeRangeBounds),
        ("operational cancellation compares original intervals before cancelling aligned hydration", NativeRangeCancellation),
        ("operational EOF-rounded cancellation preserves full interval and fetch bounds", NativeEofCancellation),
        ("operational overlapping-page duplicates cannot turn partial cancellation into full cancellation", NativeRangeDuplicateCancellation),
        ("operational native failure followed by same-key fetch receives a new settlement after retirement", DeferredFailure),
        ("operational successful delivery followed by same-key fetch reauthorizes after retirement", DeferredSuccess),
        ("operational stop drops observed deferred fetch before any new hydration", DeferredStop),
        ("operational deferred callback storage is bounded and refuses missing or conflicting identity", DeferredBounds),
        ("operational cancellation orders deferred fetch intent without cancelling a later new callback", DeferredCancellationOrdering)
    ];
    private static void Check(bool value) { if (!value) throw new Exception("Connection ownership assertion failed."); }
    private static TaskCompletionSource Gate() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static async Task Until(Func<bool> predicate) {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!predicate()) await Task.Delay(5, timeout.Token);
    }
    private static async Task Reject(Func<Task> action) {
        try { await action(); } catch (TransferException) { return; }
        throw new Exception("Expected connection refusal.");
    }
    private static async Task CopyDuringConnect()
    {
        using var f = new Fixture(); var entered = Gate(); var release = Gate(); PlaceholderIdentity? captured = null;
        var owner = f.Owner(async (_, identity, _, token) => { captured = identity; entered.SetResult(); await release.Task.WaitAsync(token); });
        f.Native.OnConnect = () => {
            f.Native.Invoke(false, Identity.Encode()); // must return without waiting for hydration
            Check(!entered.Task.IsCompleted);
            GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        };
        owner.Connect(); await entered.Task; Check(captured == Identity); Check(owner.RootsRetained);
        release.SetResult(); await owner.StopAsync(); Check(!owner.RootsRetained && f.Native.Disconnects == 1);
        // Invoke the retained fake delegate, not a freed function pointer, after terminal drain.
        f.Native.Invoke(false, Identity.Encode()); Check(f.Hydrations == 1); GC.KeepAlive(owner);
    }
    private static async Task Rejections()
    {
        using var f = new Fixture(); var owner = f.Owner((_, _, _, _) => Task.CompletedTask); owner.Connect();
        f.Native.Invoke(false, "bad"u8.ToArray()); await Until(() => f.Native.Rejections.Count == 1);
        Check(f.Native.Rejections.Single().RequiredLength == 8192);
        f.Native.Invoke(false, Identity.Encode(), cookie: f.Native.Cookie + 1);
        f.Native.Invoke(false, Identity.Encode(), connection: 999, request: 2);
        f.Native.Invoke(false, Identity.Encode(), length: 0, request: 3);
        f.Native.Invoke(false, Identity.Encode(), identityLength: 4097, request: 4);
        f.Native.Invoke(false, Identity.Encode(), parameterSize: 24, request: 5);
        await Until(() => f.Native.Rejections.Count == 2);
        await owner.StopAsync(); Check(f.Hydrations == 0 && f.Native.Rejections.Count == 2);
        Check(f.Notices.Contains(CloudFilesConnectionNotice.Unmapped));
        Check(f.Native.RejectionStatuses.All(value => value == CloudFilesNativeTransfer.Unavailable));
        Check(f.Native.Rejections.All(value => value.ConnectionKey == 123 && value.RequiredLength > 0));
    }

    internal static async Task FetchAdmission()
    {
        using var f = new Fixture(); var allowed = false; var disposed = false; var entered = Gate(); var release = Gate();
        var owner = f.Owner(async (_, _, _, _) => { entered.TrySetResult(); await release.Task; }, admitFetch: () => {
            if (!allowed) throw new IOException("Pending authority.");
            return new TestTicket(() => disposed = true);
        });
        owner.Connect(); f.Native.Invoke(false, Identity.Encode());
        await Until(() => f.Native.Rejections.Count == 1);
        Check(f.Hydrations == 0 && !disposed && f.Native.RejectionStatuses.Single() == CloudFilesNativeTransfer.Unavailable);
        allowed = true; f.Native.Invoke(false, Identity.Encode(), request: 2);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); Check(!disposed);
        release.TrySetResult(); await Until(() => disposed);
        await owner.StopAsync().WaitAsync(TimeSpan.FromSeconds(5)); Check(f.Hydrations == 1);
    }
    private sealed class TestTicket(Action release) : IDisposable { public void Dispose() => release(); }

#if LEDGETOP_NATIVE_DIAGNOSTICS
    internal static async Task TraceFakeCallbackAsync()
    {
        using var f = new Fixture(); var entered = Gate();
        var owner = f.Owner((_, _, _, _) => { entered.TrySetResult(); return Task.CompletedTask; });
        var capture = NativeStallTrace.Enable(); var connected = false;
        try {
            owner.Connect(); connected = true; f.Native.Invoke(false, Identity.Encode());
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await owner.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
            var stages = NativeStallTrace.Snapshot(capture).Select(e => e.Kind).ToArray();
            foreach (var stage in new[] { NativeStallTrace.Stage.CallbackArrival, NativeStallTrace.Stage.CallbackHandling,
                NativeStallTrace.Stage.CallbackQueued, NativeStallTrace.Stage.WorkerStart })
                if (!stages.Contains(stage)) throw new Exception("Missing fake callback diagnostic stage: " + stage);
        } finally {
            try { if (connected) await owner.StopAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
            finally { NativeStallTrace.Disable(capture); }
        }
    }
    internal static async Task TraceSyntheticCallbackProcessAsync()
    {
        var previousProbe = Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE");
        var previousInfo = Environment.GetEnvironmentVariable("LEDGETOP_TEST_REQUIRE_PROCESS_INFO");
        Environment.SetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE", "1");
        Environment.SetEnvironmentVariable("LEDGETOP_TEST_REQUIRE_PROCESS_INFO", "1");
        using var f = new Fixture(); var owner = f.Owner((_, _, _, _) => Task.CompletedTask);
        var capture = NativeStallTrace.Enable(); var connected = false; var processInfo = Marshal.AllocHGlobal(8);
        try {
            Marshal.WriteInt32(processInfo, 0, 8); Marshal.WriteInt32(processInfo, 4, 4321);
            var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(new string('x', 100_000))));
            var identity = new PlaceholderIdentity("pilot", "synthetic", "https://source.example.invalid", "odqp1_" + new string('f', 64), "odqr1_0",
                "oef1_" + new string('a', 64), sha, "sample-0.bin", 100_000, "\"" + sha + "\"", sha);
            owner.Connect(); connected = true;
            f.Native.Invoke(false, identity.Encode(), request: 1, fileSize: 100_000, processInfo: processInfo);
            Marshal.FreeHGlobal(processInfo); processInfo = 0;
            // The worker runs after the callback-owned process-info buffer has gone.
            await Until(() => NativeStallTrace.Snapshot(capture).Any(e => e.Kind == NativeStallTrace.Stage.WorkerStart && e.CallbackId != 0));
            var events = NativeStallTrace.Snapshot(capture);
            var copied = events.Single(e => e.Kind == NativeStallTrace.Stage.SyntheticCallbackProcess);
            if (copied.ProcessId != 4321 || copied.ProcessInfoStatus != (byte)SyntheticCallbackProcessInfo.Status.Present ||
                !events.Any(e => e.Kind == NativeStallTrace.Stage.WorkerStart && e.CallbackId == copied.CallbackId))
                throw new Exception("Callback process prefix was not copied and correlated before return.");
        } finally {
            if (processInfo != 0) Marshal.FreeHGlobal(processInfo);
            try { if (connected) await owner.StopAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
            finally {
                NativeStallTrace.Disable(capture);
                Environment.SetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE", previousProbe);
                Environment.SetEnvironmentVariable("LEDGETOP_TEST_REQUIRE_PROCESS_INFO", previousInfo);
            }
        }
    }
#endif

    // Diagnostic only: emulate a synchronous native rejection which asks a different
    // callback thread to finish before it returns. Both waits are strictly bounded.
    internal static async Task ObserveCrossThreadRejectionAsync()
    {
        using var f = new Fixture();
        using var nestedStarted = new ManualResetEventSlim();
        using var nestedReturned = new ManualResetEventSlim();
        Task? nested = null; var waitedForNested = false; var rejectionDone = Gate();
        var owner = f.Owner((_, _, _, _) => Task.CompletedTask);
        f.Native.OnReject = () => {
            nested = Task.Factory.StartNew(() => {
                nestedStarted.Set();
                try { f.Native.Invoke(false, Identity.Encode(), request: 2); }
                finally { nestedReturned.Set(); }
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            try {
                if (!nestedStarted.Wait(TimeSpan.FromSeconds(2))) throw new TimeoutException("Nested callback did not start.");
                waitedForNested = !nestedReturned.Wait(TimeSpan.FromMilliseconds(500));
            } finally { rejectionDone.TrySetResult(); }
        };
        owner.Connect();
        try {
            f.Native.Invoke(false, "bad"u8.ToArray(), request: 1);
            await rejectionDone.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Check(f.Native.Rejections.Count == 1);
            Check(nested is not null);
            await nested!.WaitAsync(TimeSpan.FromSeconds(5));
            Check(waitedForNested && nestedReturned.IsSet);
            Console.WriteLine("Observed: a cross-thread callback was blocked until RejectFetch returned and released settlementGate. Fake native only; no Windows API calls.");
        } finally {
            f.Native.OnReject = null;
            if (nested is not null) await nested.WaitAsync(TimeSpan.FromSeconds(5));
            await owner.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
    }
    private static async Task Cancellation()
    {
        using var f = new Fixture(); var entered = Gate(); var stopped = Gate(); var terminal = Gate();
        var owner = f.Owner(async (_, _, _, token) => {
            entered.SetResult();
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { stopped.SetResult(); await terminal.Task; throw; }
        });
        owner.Connect(); f.Native.Invoke(false, Identity.Encode()); await entered.Task;
        f.Native.Invoke(true, [], length: 4096);
        await Until(() => f.Notices.Contains(CloudFilesConnectionNotice.SubsetUnsupported));
        Check(!stopped.Task.IsCompleted && f.Native.Rejections.Count == 0);
        f.Native.Invoke(true, [], length: 8192); await stopped.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var stop = owner.StopAsync(); Check(!stop.IsCompleted && owner.RootsRetained && f.Native.Disconnects == 0);
        terminal.SetResult(); await stop;
        Check(!owner.RootsRetained && f.Native.Disconnects == 1);
    }
    private static async Task Stop()
    {
        using var f = new Fixture(); var entered = Gate(); var cancelled = Gate(); var drain = Gate();
        var owner = f.Owner(async (_, _, _, token) => {
            entered.SetResult();
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { cancelled.SetResult(); await drain.Task; throw; }
        });
        owner.Connect(); f.Native.Invoke(false, Identity.Encode()); await entered.Task;
        var stop = owner.StopAsync(); await cancelled.Task;
        using var wait = new CancellationTokenSource(); wait.Cancel();
        try { await owner.StopAsync(wait.Token); throw new Exception("Expected cancelled waiter."); } catch (OperationCanceledException) { }
        Check(owner.RootsRetained && !stop.IsCompleted && f.Native.Disconnects == 0);
        f.Native.OnDisconnect = () => {
            Check(owner.RootsRetained);
            f.Native.Invoke(false, Identity.Encode(), request: 77);
            Check(!f.Native.Rejections.Any(value => value.RequestKey == 77)); // disconnect owns platform failure; never a late CfExecute
            f.Native.Invoke(false, Identity.Encode(), cookie: f.Native.Cookie + 1, request: 78);
            GC.Collect(); GC.WaitForPendingFinalizers();
        };
        drain.SetResult(); await Task.WhenAll(stop, owner.StopAsync());
        Check(!owner.RootsRetained && f.Native.Disconnects == 1 && f.Hydrations == 1);
        Check(f.Native.Rejections.Count == 0 && f.Notices.Contains(CloudFilesConnectionNotice.Stopping));
        await Reject(() => { owner.Connect(); return Task.CompletedTask; });
    }
    private static async Task Failures()
    {
        using var connect = new Fixture(); var first = connect.Owner((_, _, _, _) => Task.CompletedTask);
        connect.Native.ConnectStatus = -1;
        await Reject(() => { first.Connect(); return Task.CompletedTask; });
        Check(first.RootsRetained); await Reject(() => first.StopAsync());
        await Reject(() => { first.Connect(); return Task.CompletedTask; });
        using var disconnect = new Fixture(); var second = disconnect.Owner((_, _, _, _) => Task.CompletedTask); second.Connect();
        disconnect.Native.DisconnectStatus = -1;
        await Reject(() => second.StopAsync()); Check(second.RootsRetained);
        await Reject(() => second.StopAsync()); Check(disconnect.Native.Disconnects == 1);
        disconnect.Native.Invoke(false, Identity.Encode()); Check(disconnect.Hydrations == 0);
        using var unused = new Fixture(); var third = unused.Owner((_, _, _, _) => Task.CompletedTask);
        await third.StopAsync(); Check(!third.RootsRetained && unused.Native.Connects == 0);
        await Reject(() => { third.Connect(); return Task.CompletedTask; });
    }
    private static async Task DuplicateCapacity()
    {
        using var f = new Fixture(); var entered = Gate(); var cancelled = Gate(); var release = Gate();
        var owner = f.Owner(async (_, _, _, token) => {
            entered.SetResult();
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { cancelled.SetResult(); await release.Task; throw; }
        }, capacity: 1);
        owner.Connect(); f.Native.Invoke(false, Identity.Encode()); await entered.Task;
        f.Native.Invoke(false, Identity.Encode());
        f.Native.Invoke(false, Identity.Encode(), length: 4096); // conflicting duplicate never owns terminal settlement
        Check(f.Native.Rejections.Count == 0 && f.Hydrations == 1);
        f.Native.Invoke(true, [], length: 4096);
        Check(!cancelled.Task.IsCompleted && f.Notices.Contains(CloudFilesConnectionNotice.SubsetUnsupported));
        f.Native.Invoke(true, [], length: 8192); // exact cancellation bypasses full fetch capacity
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var stop = owner.StopAsync(); Check(!stop.IsCompleted);
        release.SetResult(); await stop; Check(f.Native.Rejections.Count == 0);
    }
    private static async Task HeldCallback()
    {
        using var f = new Fixture(); using var entered = new ManualResetEventSlim(); using var release = new ManualResetEventSlim();
        var disconnected = Gate(); Task? callback = null;
        var owner = f.Owner((_, _, _, _) => Task.CompletedTask, observer: value => {
            if (value == CloudFilesConnectionNotice.Stopping) { entered.Set(); release.Wait(); }
        });
        owner.Connect();
        f.Native.OnDisconnect = () => {
            callback = Task.Run(() => f.Native.Invoke(false, Identity.Encode()));
            Check(entered.Wait(TimeSpan.FromSeconds(5))); disconnected.SetResult();
        };
        var stop = owner.StopAsync(); await disconnected.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Check(!stop.IsCompleted && owner.RootsRetained);
        release.Set(); await callback!; await stop;
        Check(!owner.RootsRetained && f.Native.Rejections.Count == 0 && f.Native.RejectionsAfterDisconnect == 0);
    }
    private static async Task HeldRejectionReuse()
    {
        using var f = new Fixture(); using var reported = new ManualResetEventSlim(); using var releaseReport = new ManualResetEventSlim();
        var entered = Gate(); var releaseHydration = Gate(); var reportCalls = 0;
        var owner = f.Owner(async (_, _, _, token) => { entered.SetResult(); await releaseHydration.Task.WaitAsync(token); }, observer: value => {
            if (value == CloudFilesConnectionNotice.Malformed && Interlocked.Increment(ref reportCalls) == 1) {
                reported.Set(); releaseReport.Wait();
            }
        });
        owner.Connect(); f.Native.Invoke(false, "bad"u8.ToArray());
        Check(reported.Wait(TimeSpan.FromSeconds(5)) && f.Native.Rejections.Count == 1);
        f.Native.Invoke(false, Identity.Encode()); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        releaseReport.Set(); releaseHydration.SetResult(); await owner.StopAsync();
        Check(f.Hydrations == 1 && f.Native.Rejections.Count == 1 && f.Native.RejectionsAfterDisconnect == 0);
    }
    private static async Task AtomicRetirement()
    {
        using var f = new Fixture(); using var entered = new ManualResetEventSlim(); var release = Gate();
        var seamRan = Gate(); var observed = false;
        var owner = f.Owner(async (_, _, _, token) => { entered.Set(); await release.Task.WaitAsync(token); }, rejectionGateReleased: () => {
            // This callback runs after gate release, before observer delivery; no test callback
            // is injected under a lock. A new same-tuple fetch must now obtain fresh admission.
            f.Native.Invoke(false, Identity.Encode()); observed = entered.Wait(TimeSpan.FromSeconds(5)); seamRan.SetResult();
        });
        owner.Connect(); f.Native.Invoke(false, "bad"u8.ToArray());
        await seamRan.Task.WaitAsync(TimeSpan.FromSeconds(10));
        release.SetResult(); await owner.StopAsync();
        Check(observed && f.Hydrations == 1 && f.Native.Rejections.Count == 1);
    }
    private static async Task ConnectingCancel()
    {
        using var f = new Fixture(); var owner = f.Owner((_, _, _, _) => Task.CompletedTask, capacity: 1);
        f.Native.OnConnect = () => { f.Native.Invoke(false, Identity.Encode()); f.Native.Invoke(true, [], length: 8192); };
        owner.Connect(); await Until(() => f.Notices.Contains(CloudFilesConnectionNotice.CancelledBeforeAdmission));
        await owner.StopAsync(); Check(f.Hydrations == 0 && f.Native.Rejections.Count == 0);
    }
    private static async Task Capacity()
    {
        using var f = new Fixture(); var owner = f.Owner((_, _, _, _) => Task.CompletedTask, capacity: 1);
        f.Native.OnConnect = () => { f.Native.Invoke(false, Identity.Encode()); f.Native.Invoke(false, Identity.Encode(), request: 2); };
        await Reject(() => { owner.Connect(); return Task.CompletedTask; });
        Check(owner.RootsRetained && f.Hydrations == 0 && f.Notices.Contains(CloudFilesConnectionNotice.Capacity));
        await Reject(() => owner.StopAsync());
    }

    private static async Task NativeRanges()
    {
        using var f = new Fixture();
        var captured = new System.Collections.Concurrent.ConcurrentBag<CloudFilesOperationContext>();
        var owner = f.Owner((_, identity, context, _) => {
            Check(identity.PrincipalId == Principal && identity.Length == context.FileSize);
            captured.Add(context); return Task.CompletedTask;
        }, normalizeNativeRanges: true);
        owner.Connect();
        f.Native.Invoke(false, Identity.Encode(), request: 1, offset: 137, length: 1);
        f.Native.Invoke(false, Identity.Encode(), request: 2, offset: 0, length: 27);
        f.Native.Invoke(false, Identity.Encode(), request: 3, offset: 4095, length: 2);
        f.Native.Invoke(false, Identity.Encode(), request: 4, offset: 8191, length: -1);
        var last = Identity with { Length = 8951 };
        f.Native.Invoke(false, last.Encode(), request: 5, offset: 8950, length: 1, fileSize: 8951);
        await Until(() => captured.Count == 5);
        await owner.StopAsync();
        var expected = new (long Offset, long Length)[] { (0, 4096), (0, 4096), (0, 8192), (4096, 4096), (8192, 759) };
        foreach (var context in captured) {
            var item = expected[checked((int)context.RequestKey) - 1];
            Check(context.ConnectionKey == 123 && context.TransferKey == 456 && context.RequiredOffset == item.Offset
                && context.RequiredLength == item.Length && context.RequiredOffset + context.RequiredLength <= context.FileSize);
        }
        Check(f.Native.Rejections.Count == 0 && !owner.RootsRetained);

        // The opt-in is deliberate: injected protocol-rehearsal callers retain strict behavior.
        using var strict = new Fixture(); var strictOwner = strict.Owner((_, _, _, _) => Task.CompletedTask);
        strictOwner.Connect(); strict.Native.Invoke(false, Identity.Encode(), offset: 137, length: 1);
        await Until(() => strict.Notices.Contains(CloudFilesConnectionNotice.Malformed));
        await strictOwner.StopAsync(); Check(strict.Hydrations == 0);
    }

    private static async Task NativeRangeBounds()
    {
        using var f = new Fixture(); var owner = f.Owner((_, _, _, _) => Task.CompletedTask, normalizeNativeRanges: true);
        owner.Connect();
        var invalid = new (long Offset, long Length, long Size)[] {
            (-1, 1, 8192), (8192, 1, 8192), (0, long.MaxValue, 8192),
            (long.MaxValue - 1, 4, long.MaxValue), (1, -2, 8192), (0, 0, 8192),
            (0, -1, 0), (0, 8193, 8192), (0, 1, -1), (0, 1, (1L << 40) + 1)
        };
        for (var index = 0; index < invalid.Length; index++) {
            var item = invalid[index];
            f.Native.Invoke(false, Identity.Encode(), request: index, offset: item.Offset, length: item.Length, fileSize: item.Size);
            f.Native.Invoke(true, [], request: index, offset: item.Offset, length: item.Length, fileSize: item.Size);
        }
        await owner.StopAsync();
        Check(f.Hydrations == 0 && f.Native.Rejections.Count == 0
            && f.Notices.Count(notice => notice == CloudFilesConnectionNotice.Malformed) == invalid.Length * 2);
    }

    private static async Task NativeRangeCancellation()
    {
        using var f = new Fixture(); var entered = Gate(); var cancelled = Gate();
        var owner = f.Owner(async (_, _, context, token) => {
            Check(context.RequiredOffset == 0 && context.RequiredLength == 4096);
            entered.SetResult();
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
        }, normalizeNativeRanges: true);
        owner.Connect(); f.Native.Invoke(false, Identity.Encode(), offset: 137, length: 100);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        f.Native.Invoke(true, [], offset: 137, length: 1); // Same padded page, but still only a subset of needed IO.
        await Until(() => f.Notices.Contains(CloudFilesConnectionNotice.SubsetUnsupported));
        Check(!cancelled.Task.IsCompleted);
        f.Native.Invoke(true, [], offset: 137, length: 100);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await owner.StopAsync(); Check(f.Native.Rejections.Count == 0);

        using var connecting = new Fixture();
        var beforeAdmission = connecting.Owner((_, _, _, _) => Task.CompletedTask, normalizeNativeRanges: true);
        connecting.Native.OnConnect = () => {
            connecting.Native.Invoke(false, Identity.Encode(), offset: 4097, length: -1);
            connecting.Native.Invoke(true, [], offset: 4097, length: 4095);
        };
        beforeAdmission.Connect();
        await Until(() => connecting.Notices.Contains(CloudFilesConnectionNotice.CancelledBeforeAdmission));
        await beforeAdmission.StopAsync(); Check(connecting.Hydrations == 0);
    }

    private static async Task NativeRangeDuplicateCancellation()
    {
        using var f = new Fixture(); var entered = Gate(); var cancelled = Gate();
        var owner = f.Owner(async (_, _, _, token) => {
            entered.SetResult();
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
        }, normalizeNativeRanges: true);
        owner.Connect(); f.Native.Invoke(false, Identity.Encode(), offset: 100, length: 10);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        f.Native.Invoke(false, Identity.Encode(), offset: 110, length: 10); // Another needed interval in the same page.
        Check(f.Notices.Contains(CloudFilesConnectionNotice.Malformed));
        f.Native.Invoke(true, [], offset: 100, length: 10);
        Check(f.Notices.Contains(CloudFilesConnectionNotice.SubsetUnsupported) && !cancelled.Task.IsCompleted);
        await owner.StopAsync(); Check(cancelled.Task.IsCompleted && f.Hydrations == 1 && f.Native.Rejections.Count == 0);
    }

    private static async Task NativeEofCancellation()
    {
        const long size = 100000, rounded = 102400;
        async Task Exercise(long finalCancelLength) {
            using var f = new Fixture(); var entered = Gate(); var cancelled = Gate();
            var owner = f.Owner(async (_, _, _, token) => {
                entered.TrySetResult();
                try { await Task.Delay(Timeout.Infinite, token); }
                catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
            }, normalizeNativeRanges: true);
            owner.Connect();
            var identity = Identity with { Length = size };
            // FETCH remains strictly within EOF even if the end is page-rounded.
            f.Native.Invoke(false, identity.Encode(), request: 10, length: rounded, fileSize: size);
            Check(f.Notices.Count(x => x == CloudFilesConnectionNotice.Malformed) == 1 && f.Hydrations == 0);
            f.Native.Invoke(false, identity.Encode(), request: 11, length: size, fileSize: size);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var invalid = new (long Offset, long Length)[] {
                (-1, 1), (size, 1), (long.MaxValue - 1, 4), (0, long.MaxValue),
                (0, 0), (0, -2), (0, size + 1), (0, rounded - 1), (0, rounded + 1)
            };
            foreach (var item in invalid)
                f.Native.Invoke(true, [], request: 11, offset: item.Offset, length: item.Length, fileSize: size);
            Check(f.Notices.Count(x => x == CloudFilesConnectionNotice.Malformed) == invalid.Length + 1 && !cancelled.Task.IsCompleted);
            // Even after clipping a rounded end, a different start remains a subset.
            f.Native.Invoke(true, [], request: 11, offset: 4096, length: rounded - 4096, fileSize: size);
            Check(f.Notices.Contains(CloudFilesConnectionNotice.SubsetUnsupported) && !cancelled.Task.IsCompleted);
            f.Native.Invoke(true, [], request: 11, length: finalCancelLength, fileSize: size);
            await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await owner.StopAsync(); Check(f.Native.Rejections.Count == 0 && f.Hydrations == 1);
        }
        await Exercise(size);
        await Exercise(rounded);
        await Exercise(-1);

        // Nonzero start must match the unaligned fetch interval through EOF.
        using (var f = new Fixture()) {
            var entered = Gate(); var cancelled = Gate();
            var owner = f.Owner(async (_, _, _, token) => {
                entered.TrySetResult();
                try { await Task.Delay(Timeout.Infinite, token); }
                catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
            }, normalizeNativeRanges: true);
            owner.Connect(); var identity = Identity with { Length = size };
            f.Native.Invoke(false, identity.Encode(), offset: 137, length: size - 137, fileSize: size);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            f.Native.Invoke(true, [], offset: 137, length: rounded - 137, fileSize: size);
            await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await owner.StopAsync(); Check(f.Native.Rejections.Count == 0);
        }

        // An already aligned EOF has no allowed rounded tail.
        using (var f = new Fixture()) {
            var entered = Gate(); var cancelled = Gate();
            var owner = f.Owner(async (_, _, _, token) => {
                entered.TrySetResult();
                try { await Task.Delay(Timeout.Infinite, token); }
                catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
            }, normalizeNativeRanges: true);
            owner.Connect(); f.Native.Invoke(false, Identity.Encode(), length: 8192);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            f.Native.Invoke(true, [], length: 8193);
            Check(f.Notices.Contains(CloudFilesConnectionNotice.Malformed) && !cancelled.Task.IsCompleted);
            f.Native.Invoke(true, [], length: 8192);
            await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await owner.StopAsync();
        }

        // Rounded cancellation cannot cancel coalesced, ambiguous request intervals.
        using (var f = new Fixture()) {
            var entered = Gate(); var cancelled = Gate();
            var owner = f.Owner(async (_, _, _, token) => {
                entered.TrySetResult();
                try { await Task.Delay(Timeout.Infinite, token); }
                catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
            }, normalizeNativeRanges: true);
            owner.Connect(); var identity = Identity with { Length = size };
            f.Native.Invoke(false, identity.Encode(), offset: 0, length: size, fileSize: size);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            f.Native.Invoke(false, identity.Encode(), offset: 1, length: size - 1, fileSize: size);
            Check(f.Notices.Contains(CloudFilesConnectionNotice.Malformed));
            f.Native.Invoke(true, [], length: rounded, fileSize: size);
            Check(f.Notices.Contains(CloudFilesConnectionNotice.SubsetUnsupported) && !cancelled.Task.IsCompleted);
            await owner.StopAsync(); Check(cancelled.Task.IsCompleted);
        }
    }

    private static async Task DeferredFailure()
    {
        using var f = new Fixture(); var nativeTerminal = Gate(); var retire = Gate(); var second = Gate(); var invocations = 0;
        var owner = f.Owner(async (_, _, _, token) => {
            var invocation = Interlocked.Increment(ref invocations);
            if (invocation == 1) {
                // Simulate the OS asking again after failure was settled natively but before
                // the managed hydrator has returned and released its dispatcher/work entries.
                nativeTerminal.SetResult();
                f.Native.Invoke(false, Identity.Encode());
                await retire.Task.WaitAsync(token);
                throw new TransferException("Synthetic first native failure was already settled.");
            }
            Check(invocation == 2); second.SetResult();
        }, normalizeNativeRanges: true);
        owner.Connect(); f.Native.Invoke(false, Identity.Encode());
        await nativeTerminal.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Check(f.Hydrations == 1 && !second.Task.IsCompleted);
        retire.SetResult(); await second.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await owner.StopAsync();
        Check(f.Hydrations == 2 && f.Native.Rejections.Count == 0 && !owner.RootsRetained);
    }

    private static async Task DeferredSuccess()
    {
        using var f = new Fixture(); var delivered = Gate(); var retire = Gate(); var second = Gate(); var invocations = 0;
        var owner = f.Owner(async (_, _, _, token) => {
            var invocation = Interlocked.Increment(ref invocations);
            if (invocation == 1) {
                // Successful native data can be read and dehydrated before managed cleanup ends.
                // A real subsequent callback still needs a separately authorized response.
                delivered.SetResult(); f.Native.Invoke(false, Identity.Encode());
                await retire.Task.WaitAsync(token);
            } else { Check(invocation == 2); second.SetResult(); }
        }, normalizeNativeRanges: true);
        owner.Connect(); f.Native.Invoke(false, Identity.Encode());
        await delivered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Check(f.Hydrations == 1 && !second.Task.IsCompleted);
        retire.SetResult(); await second.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await owner.StopAsync(); Check(f.Hydrations == 2 && f.Native.Rejections.Count == 0);
    }

    private static async Task DeferredStop()
    {
        using var f = new Fixture(); var entered = Gate(); var cancelled = Gate(); var retire = Gate();
        var owner = f.Owner(async (_, _, _, token) => {
            entered.SetResult();
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { cancelled.SetResult(); await retire.Task; throw; }
        }, normalizeNativeRanges: true);
        owner.Connect(); f.Native.Invoke(false, Identity.Encode()); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        f.Native.Invoke(false, Identity.Encode());
        var stop = owner.StopAsync(); await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Check(f.Hydrations == 1 && !stop.IsCompleted);
        retire.SetResult(); await stop;
        Check(f.Hydrations == 1 && !owner.RootsRetained && f.Native.Disconnects == 1);
    }

    private static async Task DeferredBounds()
    {
        using var f = new Fixture(); var entered = Gate(); var retire = Gate(); var second = Gate(); var secondRetire = Gate(); var invocations = 0;
        var owner = f.Owner(async (_, _, _, token) => {
            var invocation = Interlocked.Increment(ref invocations);
            if (invocation == 1) { entered.SetResult(); await retire.Task.WaitAsync(token); }
            else { Check(invocation == 2); second.SetResult(); await secondRetire.Task.WaitAsync(token); }
        }, capacity: 2, normalizeNativeRanges: true);
        owner.Connect(); f.Native.Invoke(false, Identity.Encode()); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        for (var i = 0; i < 100; i++) f.Native.Invoke(false, Identity.Encode());
        Check(f.Hydrations == 1 && f.Native.Rejections.Count == 0);
        retire.SetResult(); await second.Task.WaitAsync(TimeSpan.FromSeconds(5));
        secondRetire.SetResult(); await owner.StopAsync(); Check(f.Hydrations == 2);

        // At saturated callback capacity the borrowed identity is intentionally not copied.
        // Never create a deferred request by inheriting the admitted request's old identity.
        using var saturated = new Fixture(); var saturatedEntered = Gate(); var saturatedRelease = Gate();
        var one = saturated.Owner(async (_, _, _, token) => {
            saturatedEntered.SetResult(); await saturatedRelease.Task.WaitAsync(token);
        }, capacity: 1, normalizeNativeRanges: true);
        one.Connect(); saturated.Native.Invoke(false, Identity.Encode()); await saturatedEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        saturated.Native.Invoke(false, Identity.Encode()); saturatedRelease.SetResult();
        await one.StopAsync(); Check(saturated.Hydrations == 1);

        using var conflict = new Fixture(); var conflictEntered = Gate(); var conflictRelease = Gate();
        var original = conflict.Owner(async (_, _, _, token) => {
            conflictEntered.SetResult(); await conflictRelease.Task.WaitAsync(token);
        }, normalizeNativeRanges: true);
        original.Connect(); conflict.Native.Invoke(false, Identity.Encode()); await conflictEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        conflict.Native.Invoke(false, (Identity with { RemoteVersion = "another-version" }).Encode());
        Check(conflict.Notices.Contains(CloudFilesConnectionNotice.Malformed));
        conflictRelease.SetResult(); await original.StopAsync(); Check(conflict.Hydrations == 1);
    }

    private static async Task DeferredCancellationOrdering()
    {
        using var f = new Fixture(); var entered = Gate(); var cancelled = Gate(); var retire = Gate();
        var owner = f.Owner(async (_, _, _, token) => {
            entered.SetResult();
            try { await Task.Delay(Timeout.Infinite, token); }
            catch (OperationCanceledException) { cancelled.SetResult(); await retire.Task; throw; }
        }, normalizeNativeRanges: true);
        owner.Connect(); f.Native.Invoke(false, Identity.Encode()); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        f.Native.Invoke(false, Identity.Encode());
        f.Native.Invoke(true, [], length: 8192);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        retire.SetResult();
        await Until(() => f.Notices.Contains(CloudFilesConnectionNotice.CancelledBeforeAdmission));
        await owner.StopAsync(); Check(f.Hydrations == 1);

        using var newer = new Fixture(); var originalEntered = Gate(); var originalCancelled = Gate(); var originalRetire = Gate(); var fresh = Gate(); var invocations = 0;
        var afterCancel = newer.Owner(async (_, _, _, token) => {
            if (Interlocked.Increment(ref invocations) == 1) {
                originalEntered.SetResult();
                try { await Task.Delay(Timeout.Infinite, token); }
                catch (OperationCanceledException) { originalCancelled.SetResult(); await originalRetire.Task; throw; }
            } else fresh.SetResult();
        }, normalizeNativeRanges: true);
        afterCancel.Connect(); newer.Native.Invoke(false, Identity.Encode()); await originalEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        newer.Native.Invoke(true, [], length: 8192); await originalCancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        newer.Native.Invoke(false, Identity.Encode()); // New IO AFTER cancellation must not inherit its cancelled signal.
        originalRetire.SetResult(); await fresh.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await afterCancel.StopAsync(); Check(newer.Hydrations == 2);
    }
    private sealed class Fixture : IDisposable
    {
        internal readonly Native Native = new();
        internal readonly System.Collections.Concurrent.ConcurrentBag<CloudFilesConnectionNotice> Notices = [];
        internal int Hydrations;
        private readonly string state = Path.Combine(Path.GetTempPath(), "ltfiles-connection-" + Guid.NewGuid().ToString("N"));
        internal Fixture() => Directory.CreateDirectory(state);
        internal CloudFilesConnectionOwner Owner(CloudFilesCallbackHydrator hydrator, int capacity = 64, Action<CloudFilesConnectionNotice>? observer = null,
            Action? rejectionGateReleased = null, bool normalizeNativeRanges = false, Func<IDisposable?>? admitFetch = null) =>
            new(Native, key => new(new Source(), "pilot", Principal, key, state, (coordinator, identity, context, token) => {
                Interlocked.Increment(ref Hydrations); return hydrator(coordinator, identity, context, token);
            }), value => { Notices.Add(value); observer?.Invoke(value); }, capacity, rejectionGateReleased, normalizeNativeRanges, admitFetch);
        public void Dispose() { /* Retain owned test cache; quarantined fixtures intentionally retain callback roots. */ }
    }
    private sealed class Native : ICloudFilesConnectionNative
    {
        internal int Connects, Disconnects, ConnectStatus, DisconnectStatus, RejectionsAfterDisconnect;
        private bool disconnected;
        internal nint Cookie;
        internal Action? OnConnect, OnDisconnect, OnReject;
        internal readonly System.Collections.Concurrent.ConcurrentBag<CloudFilesOperationContext> Rejections = [];
        internal readonly System.Collections.Concurrent.ConcurrentBag<int> RejectionStatuses = [];
        private WeakReference<CloudFilesNativeCallback>? fetch, cancel;
        public int Connect(nint table, nint cookie, out long key) {
            Connects++; Cookie = cookie;
            var f = Marshal.PtrToStructure<CloudCallbackRegistration>(table);
            var c = Marshal.PtrToStructure<CloudCallbackRegistration>(table + 16);
            var end = Marshal.PtrToStructure<CloudCallbackRegistration>(table + 32);
            Check(f.Type == 0 && c.Type == 2 && end.Type == -1 && end.Callback == 0);
            fetch = new(Marshal.GetDelegateForFunctionPointer<CloudFilesNativeCallback>(f.Callback));
            cancel = new(Marshal.GetDelegateForFunctionPointer<CloudFilesNativeCallback>(c.Callback));
            OnConnect?.Invoke(); key = 123; return ConnectStatus;
        }
        public int Disconnect(long key) { Check(key == 123); Disconnects++; OnDisconnect?.Invoke(); disconnected = true; return DisconnectStatus; }
        public void RejectFetch(CloudFilesOperationContext context, int status) { if (disconnected) Interlocked.Increment(ref RejectionsAfterDisconnect); Rejections.Add(context); RejectionStatuses.Add(status); OnReject?.Invoke(); }
        internal void Invoke(bool isCancel, byte[] identity, long? connection = null, nint? cookie = null, long request = 0,
            long length = -1, uint? identityLength = null, uint parameterSize = 32, long offset = 0, long fileSize = 8192, nint processInfo = 0)
        {
            var data = Marshal.AllocHGlobal(Math.Max(1, identity.Length));
            var info = Marshal.AllocHGlobal(152); var parameters = Marshal.AllocHGlobal(32);
            try {
                if (identity.Length > 0) Marshal.Copy(identity, 0, data, identity.Length);
                Marshal.StructureToPtr(new CloudCallbackInfo { StructSize = 152, ConnectionKey = connection ?? 123, CallbackContext = cookie ?? Cookie,
                    FileSize = fileSize, FileIdentity = data, FileIdentityLength = identityLength ?? (uint)identity.Length,
                    TransferKey = 456, ProcessInfo = processInfo, RequestKey = request }, info, false);
                Marshal.WriteInt32(parameters, unchecked((int)parameterSize));
                Marshal.WriteInt32(parameters, 8, 0); Marshal.WriteInt64(parameters, 16, offset); Marshal.WriteInt64(parameters, 24, length);
                Check((isCancel ? cancel! : fetch!).TryGetTarget(out var callback));
                callback!(info, parameters);
                // Make all callback-owned allocations unusable after return. Queued processing must
                // rely on copied fields/identity, not any retained pointer.
                Marshal.Copy(new byte[Math.Max(1, identity.Length)], 0, data, Math.Max(1, identity.Length));
            } finally { Marshal.FreeHGlobal(parameters); Marshal.FreeHGlobal(info); Marshal.FreeHGlobal(data); }
        }
    }
    private sealed class Source : IQueuedDownloadSource, IHydrationMutationAwareSource
    {
        bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => true;
        public string Alias => "portal";
        public Uri Origin => new("https://source.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) => throw new Exception("No auth/network in ownership tests.");
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }
}
