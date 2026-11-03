// Pure in-memory model only: no files, OS handles, network, credentials or
// native sink. Fake receipts cannot establish physical cache ownership.
internal static class FakeCacheTransactionPrototypeTests {
    private const string Root = @"C:\synthetic\owned-cache";
    private sealed class Ledger {
        private readonly object sync = new();
        internal int Holds, Reservations, Releases;
        internal void Acquire(string entry) {
            lock (sync) {
                if (entry != "same-entry" || Holds != 0 || Reservations != 0) throw new IOException("Fake same-entry collision.");
                Holds = 1; Reservations = 100;
            }
        }
        internal bool Release(bool verified) {
            lock (sync) {
                if (!verified) return false; // retain fake ownership + durable accounting
                if (Holds != 1 || Reservations != 100 || Releases != 0) throw new IOException("Fake lease receipt mismatch.");
                Holds = 0; Reservations = 0; Releases++; return true;
            }
        }
    }
    private static async Task Expect<T>(Task task) where T : Exception {
        try { await task; } catch (T) { return; }
        throw new IOException("Expected " + typeof(T).Name);
    }
    internal static async Task RunAsync() {
        var registry = new OwnedRootExecutorPrototype.Registry(2, 2); var executor = registry.Create();
        var other = registry.Create(); var generation = registry.CreateGeneration(); var version = registry.ReadGeneration(generation);
        var ledger = new Ledger(); var sinklessPromotion = new OwnedRootExecutorPrototype.SyntheticCounter();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var ownerDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bool? lateAuthorized = null, lateCommit = null; var duplicateEntered = false;
        var owner = executor.RunAsync(Root, async scope => {
            ledger.Acquire("same-entry"); entered.SetResult();
            try {
                await release.Task;
                lateAuthorized = scope.TryAuthorize(generation, version);
                lateCommit = scope.TryCommitAuthorized(sinklessPromotion, generation, version);
            } finally { ledger.Release(verified: true); ownerDone.SetResult(); }
            return ledger.Holds == 0 && ledger.Reservations == 0 && ledger.Releases == 1;
        }, TimeSpan.FromSeconds(1));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var sameEntry = other.RunAsync(@"c:\synthetic\other\..\OWNED-CACHE\", _ => { duplicateEntered = true; return Task.FromResult(true); }, TimeSpan.FromSeconds(5));
        registry.BeginStop();
        await Expect<InvalidOperationException>(sameEntry);
        await Expect<TimeoutException>(owner);
        await Expect<TimeoutException>(registry.WaitForDrainAsync(TimeSpan.FromMilliseconds(100)));
        await Expect<InvalidOperationException>(other.RunAsync(Root, _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        if (duplicateEntered || ledger.Holds != 1 || ledger.Reservations != 100 || ledger.Releases != 0 || sinklessPromotion.Value != 0)
            throw new IOException("Timed-out fake preparation released or overlapped its resources.");
        release.SetResult(); await ownerDone.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await registry.WaitForDrainAsync(TimeSpan.FromSeconds(5));
        if (lateAuthorized != false || lateCommit != false || ledger.Holds != 0 || ledger.Reservations != 0 || ledger.Releases != 1 || sinklessPromotion.Value != 0)
            throw new IOException("Late fake authorization or commit escaped the stopped generation.");
        await Expect<TimeoutException>(owner); // late cleanup cannot change caller result

        // Timeout itself must fence authorization, independently of shutdown.
        var timedRegistry = new OwnedRootExecutorPrototype.Registry(1, 1); var timed = timedRegistry.Create();
        var timedGeneration = timedRegistry.CreateGeneration(); var timedVersion = timedRegistry.ReadGeneration(timedGeneration);
        var timedLedger = new Ledger(); var timedCounter = new OwnedRootExecutorPrototype.SyntheticCounter();
        var timedEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var timedRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var timedDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bool? timedAuth = null, timedPromotion = null;
        var timedOwner = timed.RunAsync(Root, async scope => {
            timedLedger.Acquire("same-entry"); timedEntered.SetResult();
            try { await timedRelease.Task; timedAuth = scope.TryAuthorize(timedGeneration, timedVersion); timedPromotion = scope.TryCommitAuthorized(timedCounter, timedGeneration, timedVersion); }
            finally { timedLedger.Release(verified: true); timedDone.SetResult(); }
            return timedLedger.Holds == 0 && timedLedger.Reservations == 0 && timedLedger.Releases == 1;
        }, TimeSpan.FromSeconds(1));
        await timedEntered.Task.WaitAsync(TimeSpan.FromSeconds(5)); await Expect<TimeoutException>(timedOwner);
        await Expect<InvalidOperationException>(timed.RunAsync(Root, _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        if (timedLedger.Holds != 1 || timedLedger.Reservations != 100 || timedLedger.Releases != 0) throw new IOException("Timed-out owner lost its fake resources.");
        timedRelease.SetResult(); await timedDone.Task.WaitAsync(TimeSpan.FromSeconds(5));
        timedRegistry.BeginStop(); await timedRegistry.WaitForDrainAsync(TimeSpan.FromSeconds(5));
        if (timedAuth != false || timedPromotion != false || timedCounter.Value != 0 || timedLedger.Releases != 1)
            throw new IOException("A timeout alone did not fence late fake work.");

        // Even an accepted authorization is invalidated if its source changes
        // while fake preparation is awaiting an operation before promotion.
        var nextRegistry = new OwnedRootExecutorPrototype.Registry(1, 1); var next = nextRegistry.Create();
        var nextGeneration = nextRegistry.CreateGeneration(); var nextVersion = nextRegistry.ReadGeneration(nextGeneration);
        var foreignGeneration = new OwnedRootExecutorPrototype.Registry(1, 1).CreateGeneration();
        var goodLedger = new Ledger(); var goodResult = new OwnedRootExecutorPrototype.SyntheticCounter();
        var good = await next.RunAsync(Root, scope => {
            goodLedger.Acquire("same-entry");
            try {
                if (!scope.TryAuthorize(nextGeneration, nextVersion) || !scope.TryCommitAuthorized(goodResult, nextGeneration, nextVersion))
                    throw new IOException("Valid fake preparation was rejected.");
            } finally { goodLedger.Release(verified: true); }
            return Task.FromResult(goodLedger.Holds == 0 && goodLedger.Reservations == 0 && goodLedger.Releases == 1);
        }, TimeSpan.FromSeconds(5));
        if (good != OwnedRootExecutorPrototype.Observation.Completed || goodResult.Value != 1 || goodLedger.Releases != 1)
            throw new IOException("Valid fake preparation failed.");
        var authorized = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var nextLedger = new Ledger(); var result = new OwnedRootExecutorPrototype.SyntheticCounter(); bool? promoted = null;
        var changed = next.RunAsync(Root, async scope => {
            nextLedger.Acquire("same-entry");
            try {
                if (scope.TryCommitAuthorized(result, nextGeneration, nextVersion) || scope.TryAuthorize(foreignGeneration, 0))
                    throw new IOException("Unverified or foreign synthetic authorization was accepted.");
                if (!scope.TryAuthorize(nextGeneration, nextVersion)) throw new IOException("Synthetic auth not admitted.");
                if (scope.TryAuthorize(foreignGeneration, 0) || scope.TryCommitAuthorized(result, nextGeneration, nextVersion) ||
                    !scope.TryAuthorize(nextGeneration, nextVersion)) throw new IOException("Failed synthetic authorization reused prior approval.");
                authorized.SetResult(); await resume.Task;
                promoted = scope.TryCommitAuthorized(result, nextGeneration, nextVersion);
            } finally { nextLedger.Release(verified: true); }
            return nextLedger.Holds == 0 && nextLedger.Reservations == 0 && nextLedger.Releases == 1;
        }, TimeSpan.FromSeconds(5));
        await authorized.Task.WaitAsync(TimeSpan.FromSeconds(5)); nextRegistry.AdvanceGeneration(nextGeneration); resume.SetResult();
        if (await changed != OwnedRootExecutorPrototype.Observation.Completed || promoted != false || result.Value != 0 || nextLedger.Releases != 1)
            throw new IOException("Changed synthetic source generation was promoted.");
        nextRegistry.BeginStop(); await nextRegistry.WaitForDrainAsync(TimeSpan.FromSeconds(5));

        // If ownership release cannot be verified, neither capacity nor shutdown
        // is reported recovered merely because the delegate has returned.
        var badRegistry = new OwnedRootExecutorPrototype.Registry(1, 1); var bad = badRegistry.Create(); var retained = new Ledger();
        await Expect<InvalidOperationException>(bad.RunAsync(Root, _ => { retained.Acquire("same-entry"); return Task.FromResult(retained.Release(verified: false)); }, TimeSpan.FromSeconds(5)));
        badRegistry.BeginStop(); await Expect<TimeoutException>(badRegistry.WaitForDrainAsync(TimeSpan.FromMilliseconds(100)));
        if (retained.Holds != 1 || retained.Reservations != 100 || retained.Releases != 0) throw new IOException("Unverified fake resources were discarded.");
        Console.WriteLine("PASS fake cache preparation retains ownership, fences source generations and accounts for shutdown.");
    }
}
