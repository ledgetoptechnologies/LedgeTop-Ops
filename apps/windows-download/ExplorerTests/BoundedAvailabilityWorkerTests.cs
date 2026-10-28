using System.Collections.Concurrent;
using LedgeTop.Files.Explorer;

internal static class BoundedAvailabilityWorkerTests
{
    internal static async Task<int> RunAsync()
    {
        await BoundDedupAndSupersession();
        await ExplicitAvailabilityBound();
        await FreshIntentAfterPathWait();
        await FailedIntentGenerations();
        await UnknownObservationDoesNotReleaseFailure();
        await SamePathKeepFreeGate();
        await StopDisconnectsBeforeJoiningBlockingWork();
        await ThrowingCancellationStillDisconnectsAndDrains();
        Console.WriteLine("PASS bounded availability workers: N2 barriers, path dedup, superseded queued intent, failed generation retry, same-path Keep/Free, disconnect-before-drain and no orphan jobs. Fake delegates only; no native/provider/source/root operations.");
        return 0;
    }
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static async Task Wait(Task task) => await task.WaitAsync(TimeSpan.FromSeconds(8));
    private static void Need(bool value, string message) { if (!value) throw new IOException(message); }

    private static async Task BoundDedupAndSupersession()
    {
        var attributes = new ConcurrentDictionary<string, AvailabilityObservation>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in new[] { "a", "b", "c" }) attributes[path] = new(AvailabilityIntent.Keep, true);
        var entered = new[] { Signal(), Signal(), Signal() }; var release = new[] { Signal(), Signal(), Signal() };
        var calls = new ConcurrentQueue<(string Path, AvailabilityIntent Intent)>(); var active = 0; var peak = 0;
        var workers = new BoundedAvailabilityWorkers(attributes.Keys, path => attributes[path], async (path, intent, _) => {
            var index = path[0] - 'a'; var count = Interlocked.Increment(ref active);
            int previous; do { previous = Volatile.Read(ref peak); } while (count > previous && Interlocked.CompareExchange(ref peak, count, previous) != previous);
            calls.Enqueue((path, intent)); entered[index].TrySetResult();
            try { await release[index].Task; } finally { Interlocked.Decrement(ref active); }
        }, _ => { });
        try {
            Need(workers.Observe("a", attributes["a"]) && workers.Observe("b", attributes["b"]), "first distinct jobs admitted");
            await Wait(Task.WhenAll(entered[0].Task, entered[1].Task));
            Need(active == 2 && peak == 2, "two distinct paths enter together through deterministic barriers");
            Need(workers.Observe("c", attributes["c"]) && !entered[2].Task.IsCompleted, "third path remains queued while exactly two workers are held");
            for (var n = 0; n < 100; n++) Need(!workers.Observe("A", attributes["a"]), "running path deduplicates case-insensitively");
            attributes["c"] = new(AvailabilityIntent.Free, true);
            Need(!workers.Observe("c", attributes["c"]), "queued path remains deduplicated when a newer intent arrives");
            release[0].TrySetResult();
            await Wait(workers.WhenJoinedAsync("c"));
            Need(!calls.Any(item => item.Path == "c"), "superseded queued Keep is discarded after fresh intent reread");
            Need(workers.Observe("c", attributes["c"]), "latest Free can be scheduled after superseded job joins");
            await Wait(entered[2].Task); release[2].TrySetResult(); release[1].TrySetResult();
            await Wait(Task.WhenAll(workers.WhenJoinedAsync("a"), workers.WhenJoinedAsync("b"), workers.WhenJoinedAsync("c")));
            Need(calls.Count(item => item.Path == "a") == 1 && calls.Single(item => item.Path == "c").Intent == AvailabilityIntent.Free && peak == 2,
                "no duplicate a job, no stale Keep, bounded two native operations");
        } finally {
            foreach (var signal in release) signal.TrySetResult();
            await workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask);
        }
    }

    private static async Task ExplicitAvailabilityBound()
    {
        var entered = new[] { Signal(), Signal(), Signal() }; var release = new[] { Signal(), Signal(), Signal() };
        var workers = new BoundedAvailabilityWorkers(["a", "b", "c"], _ => new(AvailabilityIntent.None, false), (_, _, _) => throw new Exception(), _ => { });
        var tasks = new List<Task>();
        try {
            for (var index = 0; index < 3; index++) {
                var item = index;
                tasks.Add(workers.RunExclusiveAsync(((char)('a' + item)).ToString(), async _ => { entered[item].TrySetResult(); await release[item].Task; }));
            }
            await Wait(Task.WhenAll(entered[0].Task, entered[1].Task));
            Need(!entered[2].Task.IsCompleted, "explicit operations share the same global two-operation bound");
            release[1].TrySetResult(); await Wait(entered[2].Task); release[2].TrySetResult(); release[0].TrySetResult(); await Wait(Task.WhenAll(tasks));
        } finally { foreach (var signal in release) signal.TrySetResult(); await workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.WhenAll(tasks)); }
    }

    private static async Task FreshIntentAfterPathWait()
    {
        var current = new AvailabilityObservation(AvailabilityIntent.Keep, true); var holding = Signal(); var release = Signal();
        var calls = new ConcurrentQueue<AvailabilityIntent>();
        var workers = new BoundedAvailabilityWorkers(["one"], _ => current, (_, intent, _) => { calls.Enqueue(intent); return Task.CompletedTask; }, _ => { });
        var explicitWork = workers.RunExclusiveAsync("one", async _ => { holding.TrySetResult(); await release.Task; });
        try {
            await Wait(holding.Task); Need(workers.Observe("one", current), "Keep queues behind same-path availability");
            // No scanner observation updates the generation: only the worker's fresh read
            // after the path wait can detect this change and prevent stale hydration.
            current = new(AvailabilityIntent.Free, true); release.TrySetResult(); await Wait(explicitWork);
            await Wait(workers.WhenJoinedAsync("one"));
            Need(calls.IsEmpty, "latest attributes are reread after availability waits, not just checked against scanner generation");
            Need(workers.Observe("one", current), "next scanner pass admits actual latest Free"); await Wait(workers.WhenJoinedAsync("one"));
            Need(calls.SequenceEqual([AvailabilityIntent.Free]), "fresh Free executes once with no stale Keep");
        } finally { release.TrySetResult(); await workers.StopAndDrainAsync(() => Task.CompletedTask, () => explicitWork); }
    }

    private static async Task FailedIntentGenerations()
    {
        var current = new AvailabilityObservation(AvailabilityIntent.Keep, true); var attempts = 0;
        var entered = Signal(); var release = Signal(); var failures = 0;
        var workers = new BoundedAvailabilityWorkers(["photo"], _ => current, async (_, _, _) => {
            var attempt = Interlocked.Increment(ref attempts);
            if (attempt == 1) throw new IOException("Synthetic native failure.");
            if (attempt == 3) { entered.TrySetResult(); await release.Task; throw new IOException("Older generation failed after intent changed."); }
        }, _ => Interlocked.Increment(ref failures));
        try {
            Need(workers.Observe("photo", current), "initial Keep admitted"); await Wait(workers.WhenJoinedAsync("photo"));
            for (var n = 0; n < 100; n++) Need(!workers.Observe("photo", current), "failed same intent suppressed");
            Need(!workers.Observe("photo", new(AvailabilityIntent.Unknown, false)), "unknown intent does not release failure");
            Need(!workers.Observe("photo", current), "failed Keep still suppressed after unknown observation");
            current = new(AvailabilityIntent.Free, true); Need(workers.Observe("photo", current), "observed Free releases failed Keep");
            await Wait(workers.WhenJoinedAsync("photo"));
            current = new(AvailabilityIntent.Keep, true); Need(workers.Observe("photo", current), "Keep can retry after real change"); await Wait(entered.Task);
            current = new(AvailabilityIntent.Free, true); Need(!workers.Observe("photo", current), "running path remains deduplicated");
            current = new(AvailabilityIntent.Keep, true); Need(!workers.Observe("photo", current), "new Keep generation does not overlap older Keep");
            release.TrySetResult(); await Wait(workers.WhenJoinedAsync("photo"));
            Need(workers.Observe("photo", current), "older generation failure cannot suppress new Keep generation");
            await Wait(workers.WhenJoinedAsync("photo")); Need(attempts == 4 && failures == 2, "exact retry counts without automatic failed-intent loop");
        } finally { release.TrySetResult(); await workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask); }
    }

    private static async Task UnknownObservationDoesNotReleaseFailure()
    {
        var entered = Signal(); var release = Signal(); var attempts = 0;
        var workers = new BoundedAvailabilityWorkers(["one"], _ => new(AvailabilityIntent.Keep, true), async (_, _, _) => {
            Interlocked.Increment(ref attempts); entered.TrySetResult(); await release.Task; throw new IOException("Synthetic failed Keep.");
        }, _ => { });
        try {
            workers.Observe("one", new(AvailabilityIntent.Keep, true)); await Wait(entered.Task);
            workers.Observe("one", new(AvailabilityIntent.Unknown, false)); workers.Observe("one", new(AvailabilityIntent.Keep, true));
            release.TrySetResult(); await Wait(workers.WhenJoinedAsync("one"));
            Need(!workers.Observe("one", new(AvailabilityIntent.Keep, true)) && attempts == 1,
                "unknown attributes during active Keep are not a concrete intent change and cannot release its eventual failure");
        } finally { release.TrySetResult(); await workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask); }
    }

    private static async Task SamePathKeepFreeGate()
    {
        var keepEntered = Signal(); var releaseKeep = Signal(); var freeEntered = Signal(); var otherEntered = Signal();
        var history = new ConcurrentQueue<string>();
        var workers = new BoundedAvailabilityWorkers(["same", "other"], _ => new(AvailabilityIntent.Keep, true), async (_, _, _) => {
            history.Enqueue("keep-start"); keepEntered.TrySetResult(); await releaseKeep.Task; history.Enqueue("keep-end");
        }, _ => { });
        Task? free = null; Task? other = null;
        try {
            workers.Observe("same", new(AvailabilityIntent.Keep, true)); await Wait(keepEntered.Task);
            free = workers.RunExclusiveAsync("same", _ => { history.Enqueue("free"); freeEntered.TrySetResult(); return Task.CompletedTask; });
            other = workers.RunExclusiveAsync("other", _ => { otherEntered.TrySetResult(); return Task.CompletedTask; });
            await Wait(otherEntered.Task);
            Need(!freeEntered.Task.IsCompleted, "same-path Free waits for Keep while unrelated availability can progress");
            releaseKeep.TrySetResult(); await Wait(Task.WhenAll(free, other, workers.WhenJoinedAsync("same")));
            Need(history.SequenceEqual(["keep-start", "keep-end", "free"]), "native Keep and Free for one path never overlap or invert");
        } finally {
            releaseKeep.TrySetResult();
            await workers.StopAndDrainAsync(() => Task.CompletedTask, async () => { if (free is not null) await free; if (other is not null) await other; });
        }
    }

    private static async Task ThrowingCancellationStillDisconnectsAndDrains()
    {
        var entered = Signal(); var disconnected = Signal(); var release = Signal(); var explicitJoined = false; var completed = false;
        var workers = new BoundedAvailabilityWorkers(["one"], _ => new(AvailabilityIntent.Keep, true), async (_, _, token) => {
            using var registration = token.Register(() => throw new IOException("Synthetic cancellation observer failure."));
            entered.TrySetResult(); await release.Task; completed = true;
        }, _ => { });
        workers.Observe("one", new(AvailabilityIntent.Keep, true)); await Wait(entered.Task);
        var stop = workers.StopAndDrainAsync(() => { disconnected.TrySetResult(); release.TrySetResult(); return Task.CompletedTask; },
            () => { explicitJoined = true; return Task.CompletedTask; });
        var refused = false;
        try { await Wait(stop); } catch (AggregateException) { refused = true; }
        Need(refused && disconnected.Task.IsCompleted && explicitJoined && completed && workers.WhenJoinedAsync("one").IsCompleted,
            "throwing cancellation notification still disconnects and joins native/explicit workers before preserving stop error");
    }

    private static async Task StopDisconnectsBeforeJoiningBlockingWork()
    {
        using var firstNative = new ManualResetEventSlim(); using var secondNative = new ManualResetEventSlim();
        var enteredA = Signal(); var enteredB = Signal(); var disconnected = Signal(); var explicitJoined = Signal();
        var explicitRelease = Signal(); var completed = 0; var queuedCalls = 0;
        var workers = new BoundedAvailabilityWorkers(["a", "b", "queued"], _ => new(AvailabilityIntent.Keep, true), (path, _, _) => {
            if (path == "queued") { Interlocked.Increment(ref queuedCalls); return Task.CompletedTask; }
            (path == "a" ? enteredA : enteredB).TrySetResult();
            (path == "a" ? firstNative : secondNative).Wait(); // Synchronous native-like block deliberately ignores cancellation.
            Interlocked.Increment(ref completed); return Task.CompletedTask;
        }, _ => { });
        workers.Observe("a", new(AvailabilityIntent.Keep, true)); workers.Observe("b", new(AvailabilityIntent.Keep, true));
        await Wait(Task.WhenAll(enteredA.Task, enteredB.Task)); workers.Observe("queued", new(AvailabilityIntent.Keep, true));
        var queuedExplicitCalls = 0;
        var queuedExplicit = workers.RunExclusiveAsync("queued", _ => { Interlocked.Increment(ref queuedExplicitCalls); return Task.CompletedTask; });
        var stopping = workers.StopAndDrainAsync(() => {
            disconnected.TrySetResult(); firstNative.Set(); return Task.CompletedTask;
        }, async () => {
            Need(disconnected.Task.IsCompleted, "callback disconnect precedes explicit join");
            try { await queuedExplicit; } catch (OperationCanceledException) { }
            explicitJoined.TrySetResult(); await explicitRelease.Task;
        });
        try {
            await Wait(explicitJoined.Task);
            Need(!stopping.IsCompleted && !workers.WhenJoinedAsync("b").IsCompleted, "cancel/disconnect never abandons remaining blocked native worker");
            Need(!workers.Observe("queued", new(AvailabilityIntent.Free, true)), "stop closes scanner admission");
            var rejected = false;
            try { await workers.RunExclusiveAsync("a", _ => throw new IOException("Must never run.")); } catch (IOException) { rejected = true; }
            Need(rejected, "stop closes explicit admission too");
            secondNative.Set(); explicitRelease.TrySetResult(); await Wait(stopping);
            Need(completed == 2 && queuedCalls == 0 && queuedExplicitCalls == 0 && queuedExplicit.IsCompleted && workers.WhenJoinedAsync("queued").IsCompleted, "all active workers and canceled queued jobs joined, with no orphan native task");
            Need(ReferenceEquals(stopping, workers.StopAndDrainAsync(() => throw new Exception("No repeated disconnect."), () => Task.CompletedTask)), "stop is exact-once/idempotent");
        } finally { firstNative.Set(); secondNative.Set(); explicitRelease.TrySetResult(); await stopping; }
    }
}
