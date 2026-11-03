#if LEDGETOP_NATIVE_DIAGNOSTICS
using LedgeTop.WindowsDownload;

internal static class NativeStallTraceTests
{
    internal static async Task RunAsync()
    {
        ProcessInfoTests();
        NativeStallTrace.Record(NativeStallTrace.Stage.CallbackArrival);
        var capture = NativeStallTrace.Enable();
        try {
            if (NativeStallTrace.Snapshot(capture).Length != 0) throw new Exception("Disabled trace recorded an event.");
            var workers = Enumerable.Range(0, 4).Select(_ => Task.Run(() => {
                for (var i = 0; i < 1000; i++) NativeStallTrace.Record(NativeStallTrace.Stage.WorkerStart);
            })).ToArray();
            await Task.WhenAll(workers).WaitAsync(TimeSpan.FromSeconds(10));
            var events = NativeStallTrace.Snapshot(capture);
            if (events.Length != 2048 || NativeStallTrace.Attempted(capture) != 4000 || NativeStallTrace.Dropped(capture) != 1952 ||
                events.Any(e => e.Kind != NativeStallTrace.Stage.WorkerStart || e.Timestamp <= 0 || e.ThreadId <= 0) ||
                events.Select(e => e.Sequence).Distinct().Count() != events.Length)
                throw new Exception("Trace must publish at most its bounded capacity with unique, nonidentifying events.");
        } finally { NativeStallTrace.Disable(capture); }
        var shortCapture = NativeStallTrace.Enable();
        NativeStallTrace.Record(NativeStallTrace.Stage.CallbackArrival);
        NativeStallTrace.Disable(shortCapture);
        NativeStallTrace.Record(NativeStallTrace.Stage.CallbackArrival);
        if (NativeStallTrace.Snapshot(shortCapture).Length != 1) throw new Exception("Disabled trace accepted an event.");
        var delayed = NativeStallTrace.Enable();
        try {
            // Reserve sequence 1, then let a second writer publish sequence 2.
            var first = NativeStallTrace.ReserveSlot(delayed);
            if (first != 0) throw new Exception("First reserved slot was not zero.");
            NativeStallTrace.Record(NativeStallTrace.Stage.WorkerStart);
            var seen = new HashSet<long>();
            foreach (var item in NativeStallTrace.Snapshot(delayed)) seen.Add(item.Sequence);
            if (!seen.SetEquals([2L])) throw new Exception("The second slot must be observable before the delayed first slot.");
            NativeStallTrace.Disable(delayed);
            // A writer that reserved before Disable may publish afterward.
            NativeStallTrace.PublishSlot(delayed, first, NativeStallTrace.Stage.CallbackArrival);
            var newEvents = NativeStallTrace.Snapshot(delayed).Where(item => seen.Add(item.Sequence)).ToArray();
            if (newEvents.Length != 1 || newEvents[0].Sequence != 1 || !seen.SetEquals([1L, 2L]))
                throw new Exception("Per-slot tracking must include a late publication after Disable.");
        } finally { NativeStallTrace.Disable(delayed); }
        var mutationCapture = NativeStallTrace.Enable();
        try {
            var changed = false;
            using (HydrationMutationScope.Begin(action => action(), CancellationToken.None))
                HydrationMutationScope.Run(() => changed = true);
            var stages = NativeStallTrace.Snapshot(mutationCapture).Select(e => e.Kind).ToArray();
            if (!changed || !stages.SequenceEqual([NativeStallTrace.Stage.CacheMutationEnter, NativeStallTrace.Stage.CacheMutationExit]))
                throw new Exception("Mutation trace must surround the gated action.");
        } finally { NativeStallTrace.Disable(mutationCapture); }
        var blockedCapture = NativeStallTrace.Enable();
        using var releaseMutation = new ManualResetEventSlim();
        var mutationEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        try {
            var worker = Task.Run(() => {
                using (HydrationMutationScope.Begin(action => { mutationEntered.TrySetResult(); releaseMutation.Wait(); action(); }, CancellationToken.None))
                    HydrationMutationScope.Run(() => { });
            });
            try {
                await mutationEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
                var waiting = NativeStallTrace.Snapshot(blockedCapture).Select(e => e.Kind).ToArray();
                if (!waiting.SequenceEqual([NativeStallTrace.Stage.CacheMutationEnter]))
                    throw new Exception("A blocked mutation must show an entry without an exit.");
            } finally { releaseMutation.Set(); await worker.WaitAsync(TimeSpan.FromSeconds(10)); }
            if (!NativeStallTrace.Snapshot(blockedCapture).Select(e => e.Kind).SequenceEqual([NativeStallTrace.Stage.CacheMutationEnter, NativeStallTrace.Stage.CacheMutationExit]))
                throw new Exception("A released mutation must publish its exit.");
        } finally { NativeStallTrace.Disable(blockedCapture); }
        await CloudFilesConnectionTests.TraceFakeCallbackAsync();
        await CloudFilesConnectionTests.TraceSyntheticCallbackProcessAsync();
        await AssertStageCoverageAsync(CloudFilesNativeTransferTests.Groups.First(g => g.Name.StartsWith("native x64 ABI", StringComparison.Ordinal)).Run,
            NativeStallTrace.Stage.ProgressEnter, NativeStallTrace.Stage.ProgressExit,
            NativeStallTrace.Stage.AdmissionEnter, NativeStallTrace.Stage.AdmissionAcquired,
            NativeStallTrace.Stage.AuthorizationEnter, NativeStallTrace.Stage.AuthorizationExit,
            NativeStallTrace.Stage.CacheLegacyLeaseEnter, NativeStallTrace.Stage.CacheLegacyLeaseAcquired,
            NativeStallTrace.Stage.CacheQuotaEnter, NativeStallTrace.Stage.CacheQuotaAcquired, NativeStallTrace.Stage.CacheQuotaExit,
            NativeStallTrace.Stage.CacheDirectoryEnter, NativeStallTrace.Stage.CacheDirectoryExit,
            NativeStallTrace.Stage.CacheScopeCheckEnter, NativeStallTrace.Stage.CacheScopeCheckExit,
            NativeStallTrace.Stage.CacheEntryCheckEnter, NativeStallTrace.Stage.CacheEntryCheckExit,
            NativeStallTrace.Stage.CacheReservationDirCheckEnter, NativeStallTrace.Stage.CacheReservationDirCheckExit,
            NativeStallTrace.Stage.CacheReservedBytesEnter, NativeStallTrace.Stage.CacheReservedBytesExit,
            NativeStallTrace.Stage.CacheCapacityEnter, NativeStallTrace.Stage.CacheCapacityExit,
            NativeStallTrace.Stage.CacheWalkEnter, NativeStallTrace.Stage.CacheWalkExit,
            NativeStallTrace.Stage.CacheScopeOwnEnter, NativeStallTrace.Stage.CacheScopeOwnExit,
            NativeStallTrace.Stage.CacheEntryOwnEnter, NativeStallTrace.Stage.CacheEntryOwnExit,
            NativeStallTrace.Stage.OwnedSafeEnter, NativeStallTrace.Stage.OwnedSafeExit,
            NativeStallTrace.Stage.OwnedDirectoryExistsEnter, NativeStallTrace.Stage.OwnedDirectoryExistsExit,
            NativeStallTrace.Stage.OwnedFileExistsEnter, NativeStallTrace.Stage.OwnedFileExistsExit,
            NativeStallTrace.Stage.OwnedCreateEnter, NativeStallTrace.Stage.OwnedCreateExit,
            NativeStallTrace.Stage.OwnedMarkerOpenEnter, NativeStallTrace.Stage.OwnedMarkerOpenExit,
            NativeStallTrace.Stage.OwnedMarkerWriteEnter, NativeStallTrace.Stage.OwnedMarkerWriteExit,
            NativeStallTrace.Stage.OwnedMarkerFlushEnter, NativeStallTrace.Stage.OwnedMarkerFlushExit,
            NativeStallTrace.Stage.OwnedMarkerSafeEnter, NativeStallTrace.Stage.OwnedMarkerSafeExit,
            NativeStallTrace.Stage.OwnedMarkerVerifyEnter, NativeStallTrace.Stage.OwnedMarkerVerifyExit,
            NativeStallTrace.Stage.OwnedVerifyExistsEnter, NativeStallTrace.Stage.OwnedVerifyExistsExit,
            NativeStallTrace.Stage.OwnedVerifyLengthEnter, NativeStallTrace.Stage.OwnedVerifyLengthExit,
            NativeStallTrace.Stage.OwnedVerifyReadEnter, NativeStallTrace.Stage.OwnedVerifyReadExit,
            NativeStallTrace.Stage.CacheEntryPathSafeEnter, NativeStallTrace.Stage.CacheEntryPathSafeExit,
            NativeStallTrace.Stage.CacheFilePathSafeEnter, NativeStallTrace.Stage.CacheFilePathSafeExit,
            NativeStallTrace.Stage.CacheEntryLeaseEnter, NativeStallTrace.Stage.CacheEntryLeaseOpenExit, NativeStallTrace.Stage.CacheEntryLeaseAcquired,
            NativeStallTrace.Stage.CacheReserveEnter, NativeStallTrace.Stage.CacheReserveAcquired,
            NativeStallTrace.Stage.CacheReleaseEnter, NativeStallTrace.Stage.CacheReleaseExit,
            NativeStallTrace.Stage.CacheDownloadEnter, NativeStallTrace.Stage.CacheDownloadExit,
            NativeStallTrace.Stage.CacheVerifyEnter, NativeStallTrace.Stage.CacheVerifyExit,
            NativeStallTrace.Stage.AuthorizationAfterEnter, NativeStallTrace.Stage.AuthorizationAfterExit,
            NativeStallTrace.Stage.TransferEnter, NativeStallTrace.Stage.TransferExit,
            NativeStallTrace.Stage.ExecuteEnter, NativeStallTrace.Stage.ExecuteExit);
        await CloudFilesNativeTransferTests.TraceBlockedExecuteAsync();
        await AssertStageCoverageAsync(CloudFilesNativeTransferTests.Groups.First(g => g.Name.StartsWith("native HRESULT and thrown failure", StringComparison.Ordinal)).Run,
            NativeStallTrace.Stage.ExecuteEnter, NativeStallTrace.Stage.ExecuteExit);
        await AssertStageCoverageAsync(CloudFilesNativeTransferTests.Groups.First(g => g.Name.StartsWith("native post-download authorization", StringComparison.Ordinal)).Run,
            NativeStallTrace.Stage.AuthorizationAfterEnter, NativeStallTrace.Stage.AuthorizationAfterExit);
        await AssertStageCoverageAsync(CloudFilesConnectionTests.Groups.First(g => g.Name.StartsWith("connection rejects malformed", StringComparison.Ordinal)).Run,
            NativeStallTrace.Stage.RejectEnter, NativeStallTrace.Stage.RejectExit);
        await AssertStageCoverageAsync(CloudFilesNativeTransferTests.Groups.First(g => g.Name.StartsWith("native progress heartbeat", StringComparison.Ordinal)).Run,
            NativeStallTrace.Stage.ProgressEnter, NativeStallTrace.Stage.ProgressExit);
        await AssertStageCoverageAsync(QueuedDownloadSourceTests.Groups.First(g => g.Name.StartsWith("Company resolve bounded busy retry rechecks", StringComparison.Ordinal)).Run,
            NativeStallTrace.Stage.MetadataAttemptEnter, NativeStallTrace.Stage.MetadataAttemptExit,
            NativeStallTrace.Stage.MetadataBusy, NativeStallTrace.Stage.RetryDelayEnter, NativeStallTrace.Stage.RetryDelayExit);
        Console.WriteLine("PASS bounded diagnostic capture, disabled state and fake callback markers; no native API or network.");
    }
    private static void ProcessInfoTests()
    {
        CloudFilesConnectionOwner.AssertAbi();
        var ptr = System.Runtime.InteropServices.Marshal.AllocHGlobal(8);
        var capture = NativeStallTrace.Enable();
        SyntheticCallbackProcessInfo.Observation copy;
        try {
            if (SyntheticCallbackProcessInfo.CopyPrefix(0).Status != SyntheticCallbackProcessInfo.Status.Missing) throw new Exception("Null process info was not missing.");
            System.Runtime.InteropServices.Marshal.WriteInt32(ptr, 0, 7);
            System.Runtime.InteropServices.Marshal.WriteInt32(ptr, 4, 12345);
            if (SyntheticCallbackProcessInfo.CopyPrefix(ptr) != new SyntheticCallbackProcessInfo.Observation(SyntheticCallbackProcessInfo.Status.TooShort, 0))
                throw new Exception("Short process info was accepted.");
            System.Runtime.InteropServices.Marshal.WriteInt32(ptr, 0, 8);
            copy = SyntheticCallbackProcessInfo.CopyPrefix(ptr);
            NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticCallbackProcess, 23, copy.ProcessId, (byte)copy.Status);
        } finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(ptr); NativeStallTrace.Disable(capture); }
        var saved = NativeStallTrace.Snapshot(capture).Single();
        if (copy.Status != SyntheticCallbackProcessInfo.Status.Present || copy.ProcessId != 12345 || saved.CallbackId != 23 || saved.ProcessId != 12345 ||
            saved.ProcessInfoStatus != (byte)SyntheticCallbackProcessInfo.Status.Present)
            throw new Exception("Process prefix was not copied before its allocation ended.");
        if (typeof(NativeStallTrace.Event).GetProperties().Any(p => p.PropertyType == typeof(string) || p.PropertyType == typeof(nint)))
            throw new Exception("Trace events must not retain pointers or strings.");
        var probe = Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE");
        var process = Environment.GetEnvironmentVariable("LEDGETOP_TEST_REQUIRE_PROCESS_INFO");
        try {
            var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(new string('x', 100_000))));
            var id = new PlaceholderIdentity("pilot", "synthetic", "https://source.example.invalid", "odqp1_" + new string('f', 64), "odqr1_0",
                "oef1_" + new string('a', 64), sha, "sample-0.bin", 100_000, "\"" + sha + "\"", sha);
            Environment.SetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE", "1");
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_REQUIRE_PROCESS_INFO", "1");
            if (!SyntheticCallbackProcessInfo.Eligible(id.Encode()) || SyntheticCallbackProcessInfo.Eligible((id with { FileName = "other.bin" }).Encode()) ||
                SyntheticCallbackProcessInfo.Eligible([1, 2, 3])) throw new Exception("Synthetic identity filter is incorrect.");
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_REQUIRE_PROCESS_INFO", null);
            if (SyntheticCallbackProcessInfo.Eligible(id.Encode())) throw new Exception("Process capture did not require explicit opt-in.");
        } finally {
            Environment.SetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE", probe);
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_REQUIRE_PROCESS_INFO", process);
        }
        var capped = NativeStallTrace.Enable();
        try {
            for (var i = 0; i < 2050; i++) NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticCallbackProcess, i + 1, 12345, (byte)SyntheticCallbackProcessInfo.Status.Present);
            if (NativeStallTrace.Snapshot(capped).Length != 2048 || NativeStallTrace.Dropped(capped) != 2)
                throw new Exception("Process observations bypassed trace capacity.");
        } finally { NativeStallTrace.Disable(capped); }
    }

    private static async Task AssertStageCoverageAsync(Func<Task> operation, params NativeStallTrace.Stage[] expected)
    {
        var capture = NativeStallTrace.Enable();
        try {
            await operation().WaitAsync(TimeSpan.FromSeconds(30));
            var events = NativeStallTrace.Snapshot(capture).Select(e => e.Kind).ToArray();
            var stages = events.ToHashSet();
            foreach (var stage in expected)
                if (!stages.Contains(stage)) throw new Exception("Missing fake diagnostic stage: " + stage);
            if (NativeStallTrace.Dropped(capture) != 0) throw new Exception("Synthetic stage test exceeded trace capacity.");
            foreach (var (enter, exit) in new[] {
                (NativeStallTrace.Stage.CacheEntryPathSafeEnter, NativeStallTrace.Stage.CacheEntryPathSafeExit),
                (NativeStallTrace.Stage.CacheFilePathSafeEnter, NativeStallTrace.Stage.CacheFilePathSafeExit),
                (NativeStallTrace.Stage.CacheEntryLeaseEnter, NativeStallTrace.Stage.CacheEntryLeaseOpenExit) })
                if (events.Count(x => x == enter) != events.Count(x => x == exit)) throw new Exception("Unbalanced fake diagnostic stages: " + enter);
        } finally { NativeStallTrace.Disable(capture); }
    }
}
#endif
