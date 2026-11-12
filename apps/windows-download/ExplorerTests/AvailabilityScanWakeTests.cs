using System.Collections.Concurrent;
using LedgeTop.Files.Explorer;

internal static class AvailabilityScanWakeTests
{
    internal static async Task<int> RunAsync()
    {
        await CoalescingAndFallback();
        await FallbackDeadlineWinsLatePulse();
        await CallerCancellationAndDispose();
        await NotificationFailuresUseFallback();
        await InFlightPulseScansOnlyManifest();
        await ProviderStopComposition();
        await SingleWaitAndStopDuringScan();
        await CommittedSnapshotCanAdvance();
        await AdmissionBeforeSnapshotComposition();
        await ConcurrentSnapshotMutationRetries();
        await FrozenManifestEnumerationIsBounded();
        Console.WriteLine("PASS availability scan wake: bounded burst/coalescing, unchanged fallback, cancellation/disposal, in-flight pulse, watcher failure and fixed-manifest/disconnect composition. Fake notifications and virtual clock only; no filesystem/provider/native/source operations.");
        return 0;
    }
    private static void Need(bool condition, string message) { if (!condition) throw new IOException(message); }
    private static async Task Wait(Task task) => await task.WaitAsync(TimeSpan.FromSeconds(8));
    private static async Task<T> Wait<T>(Task<T> task) => await task.WaitAsync(TimeSpan.FromSeconds(8));
    private static async Task Cancelled(Task task)
    {
        var cancelled = false; try { await Wait(task); } catch (OperationCanceledException) { cancelled = true; }
        Need(cancelled, "pending scanner wait must be cancelled and joined");
    }
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static async Task CommittedSnapshotCanAdvance()
    {
        var clock = new ManualClock(); var source = new Notifications();
        await using var wake = new AvailabilityScanWake(source.Bind, clock);
        using var cancel = new CancellationTokenSource();
        string[] paths = ["old"]; var first = Signal(); var added = Signal();
        var seen = new ConcurrentQueue<string>();
        var running = wake.RunScannerAsync(() => Volatile.Read(ref paths), path => {
            seen.Enqueue(path); if (path == "old") first.TrySetResult(); if (path == "new") added.TrySetResult();
        }, cancel.Token);
        try {
            await Wait(first.Task);
            Volatile.Write(ref paths, ["old", "new"]);
            source.Emit(); await clock.WaitForTimerAsync(AvailabilityScanWake.CoalescingInterval);
            clock.Advance(AvailabilityScanWake.CoalescingInterval); await Wait(added.Task);
            Need(seen.Contains("new"), "next scan did not observe committed catalog snapshot");
        } finally { cancel.Cancel(); await Wait(running); }
    }

    private static async Task AdmissionBeforeSnapshotComposition()
    {
        var clock = new ManualClock(); var notifications = new Notifications();
        await using var wake = new AvailabilityScanWake(notifications.Bind, clock);
        using var cancel = new CancellationTokenSource();
        var first = Signal(); var completed = Signal(); var scans = 0;
        var paths = new List<string> { "old" };
        var workers = new BoundedAvailabilityWorkers(paths, _ => new(AvailabilityIntent.Keep, true),
            (path, _, _) => { if (path == "new") completed.TrySetResult(); return Task.CompletedTask; }, _ => { });
        var scanner = wake.RunScannerAsync(() => paths, path => {
            if (path == "old" && Interlocked.Increment(ref scans) == 1) first.TrySetResult();
            else if (path == "old" && scans == 2) paths.Add("not-in-this-scan");
            workers.Observe(path, new(AvailabilityIntent.Keep, path == "new"));
        }, cancel.Token);
        try {
            await Wait(first.Task);
            workers.AddKnownPaths(["new"]); // Must precede exposing the path in the scan snapshot.
            paths.Add("new"); notifications.Emit();
            await clock.WaitForTimerAsync(AvailabilityScanWake.CoalescingInterval); clock.Advance(AvailabilityScanWake.CoalescingInterval);
            await Wait(completed.Task); // Mutation inside the scan must not change that scan's private snapshot.
        } finally {
            cancel.Cancel(); await Wait(scanner);
            await Wait(workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask));
        }
        try { workers.AddKnownPaths(["after-stop"]); throw new IOException("admission after stop"); }
        catch (IOException error) when (error.Message == "Availability changes are stopping.") { }
    }

    private static async Task ConcurrentSnapshotMutationRetries()
    {
        var clock = new ManualClock(); var notifications = new Notifications();
        await using var wake = new AvailabilityScanWake(notifications.Bind, clock);
        using var cancel = new CancellationTokenSource();
        using var proceed = new ManualResetEventSlim(); var copying = Signal(); var seen = Signal();
        var mutable = new MutatingSnapshot(copying, proceed); var calls = 0;
        var scanner = Task.Run(() => wake.RunScannerAsync(() => Interlocked.Increment(ref calls) == 1 ? mutable : ["safe"],
            path => { if (path == "safe") seen.TrySetResult(); }, cancel.Token));
        try {
            await Wait(copying.Task); mutable.Add("changed"); proceed.Set();
            await clock.WaitForTimerAsync(AvailabilityScanWake.FallbackInterval);
            clock.Advance(AvailabilityScanWake.FallbackInterval); await Wait(seen.Task);
            Need(!scanner.IsFaulted && calls >= 2, "mutated snapshot should skip and retry");
        } finally { proceed.Set(); cancel.Cancel(); await Wait(scanner); }
    }
    private static async Task FrozenManifestEnumerationIsBounded()
    {
        var source = new Notifications(); await using var wake = new AvailabilityScanWake(source.Bind);
        var visited = 0;
        IEnumerable<string> Endless() { while (true) { visited++; yield return "p" + visited; } }
        try { await wake.RunScannerAsync(Endless(), _ => throw new IOException("unexpected scan"), CancellationToken.None); throw new IOException("oversized manifest accepted"); }
        catch (ArgumentException) { }
        Need(visited == 1001, "frozen manifest enumeration was not bounded");
    }
    private sealed class MutatingSnapshot(TaskCompletionSource copying, ManualResetEventSlim proceed) : IReadOnlyList<string>
    {
        private readonly List<string> paths = ["first", "second"];
        public int Count => paths.Count;
        public string this[int index] => paths[index];
        internal void Add(string path) => paths.Add(path);
        public IEnumerator<string> GetEnumerator()
        {
            foreach (var path in paths) {
                copying.TrySetResult(); if (!proceed.Wait(TimeSpan.FromSeconds(5))) throw new IOException("mutation test timed out");
                yield return path;
            }
        }
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private static async Task CoalescingAndFallback()
    {
        var clock = new ManualClock(); var source = new Notifications();
        await using var wake = new AvailabilityScanWake(source.Bind, clock);
        var waiting = wake.WaitForNextScanAsync();
        for (var n = 0; n < 10000; n++) source.Emit();
        await clock.WaitForTimerAsync(AvailabilityScanWake.CoalescingInterval);
        Need(clock.Created == 2, "event burst creates only one deadline and one coalescing timer, no per-event task/timer");
        clock.Advance(AvailabilityScanWake.CoalescingInterval);
        Need(await Wait(waiting) == AvailabilityScanTrigger.Notification && clock.Active == 0, "one coalesced notification wakes scanner and retires both timers");
        waiting = wake.WaitForNextScanAsync();
        Need(clock.CountDue(AvailabilityScanWake.CoalescingInterval) == 0, "burst leaves no unbounded or stale pending wakes");
        clock.Advance(AvailabilityScanWake.FallbackInterval);
        Need(await Wait(waiting) == AvailabilityScanTrigger.Fallback && clock.Active == 0, "without notifications exact original two-second fallback remains");
        source.Emit(); // Between waits, as while the scanner is inspecting the manifest.
        waiting = wake.WaitForNextScanAsync();
        await clock.WaitForTimerAsync(AvailabilityScanWake.CoalescingInterval); clock.Advance(AvailabilityScanWake.CoalescingInterval);
        Need(await Wait(waiting) == AvailabilityScanTrigger.Notification, "one pulse arriving outside an active wait is retained");
    }
    private static async Task FallbackDeadlineWinsLatePulse()
    {
        var clock = new ManualClock(); var source = new Notifications(); await using var wake = new AvailabilityScanWake(source.Bind, clock);
        var waiting = wake.WaitForNextScanAsync(); clock.Advance(TimeSpan.FromMilliseconds(1950)); source.Emit();
        await clock.WaitForTimerAsync(AvailabilityScanWake.CoalescingInterval); clock.Advance(TimeSpan.FromMilliseconds(50));
        Need(await Wait(waiting) == AvailabilityScanTrigger.Fallback && clock.Active == 0,
            "late pulse cannot extend the original two-second fallback deadline by coalescing");
    }
    private static async Task CallerCancellationAndDispose()
    {
        foreach (var coalescing in new[] { false, true }) {
            var clock = new ManualClock(); var source = new Notifications(); var wake = new AvailabilityScanWake(source.Bind, clock);
            using var cancel = new CancellationTokenSource(); var waiting = wake.WaitForNextScanAsync(cancel.Token);
            if (coalescing) { source.Emit(); await clock.WaitForTimerAsync(AvailabilityScanWake.CoalescingInterval); }
            cancel.Cancel(); await Cancelled(waiting);
            Need(clock.Active == 0, "caller cancellation joins the underlying semaphore and timer rather than abandoning timeout work");
            waiting = wake.WaitForNextScanAsync();
            if (coalescing) { source.Emit(); await clock.WaitForTimerAsync(AvailabilityScanWake.CoalescingInterval); }
            wake.Stop(); Need(source.Disposals == 0, "stop closes hint admission without blocking native disconnect on watcher disposal");
            var disposing = wake.DisposeAsync().AsTask(); await Cancelled(waiting); await Wait(disposing);
            Need(source.Disposals == 1 && clock.Active == 0, "final disposal joins pending wait and disposes watcher exactly once");
            source.Emit(); source.Fail(); // Simulate an already-delivered callback racing final disposal.
            await Cancelled(wake.WaitForNextScanAsync()); await wake.DisposeAsync();
            Need(source.Disposals == 1, "late in-flight callbacks cannot release disposed semaphore or restart watcher");
        }
    }
    private static async Task NotificationFailuresUseFallback()
    {
        var clock = new ManualClock(); await using (var failed = new AvailabilityScanWake((_, _) => throw new IOException("Synthetic watcher creation failure."), clock)) {
            Need(failed.FallbackOnly, "creation failure selects fallback without failing provider startup");
            var waiting = failed.WaitForNextScanAsync(); clock.Advance(AvailabilityScanWake.FallbackInterval);
            Need(await Wait(waiting) == AvailabilityScanTrigger.Fallback, "creation failure retains periodic reconciliation");
        }
        foreach (var inline in new[] { false, true }) {
            clock = new ManualClock(); var source = new Notifications { FailOnBind = inline };
            var wake = new AvailabilityScanWake(source.Bind, clock);
            if (!inline) source.Fail();
            Need(wake.FallbackOnly, "error including during watcher construction degrades safely");
            var waiting = wake.WaitForNextScanAsync(); for (var n = 0; n < 1000; n++) source.Emit();
            Need(clock.CountDue(AvailabilityScanWake.CoalescingInterval) == 0, "failed watcher hints are ignored, not retried or turned into scans");
            clock.Advance(AvailabilityScanWake.FallbackInterval); Need(await Wait(waiting) == AvailabilityScanTrigger.Fallback, "error leaves fallback active");
            await wake.DisposeAsync(); Need(source.Disposals == 1, "failed/partially-started watcher still has exact disposal ownership");
        }
        clock = new ManualClock(); var throwing = new Notifications { ThrowDispose = true }; var uncertain = new AvailabilityScanWake(throwing.Bind, clock);
        var pending = uncertain.WaitForNextScanAsync(); uncertain.Stop(); await Cancelled(pending);
        var refused = false; try { await uncertain.DisposeAsync(); } catch (IOException) { refused = true; }
        Need(refused && clock.Active == 0 && throwing.Disposals == 1, "watcher cleanup error is retained after wait is joined, not claimed successful");
    }
    private static async Task InFlightPulseScansOnlyManifest()
    {
        var clock = new ManualClock(); var source = new Notifications(); await using var wake = new AvailabilityScanWake(source.Bind, clock);
        using var cancel = new CancellationTokenSource(); var seen = new List<string>(); var second = Signal();
        var scanner = wake.RunScannerAsync(["known-a", "known-b"], relative => {
            seen.Add(relative);
            if (seen.Count == 1) for (var n = 0; n < 1000; n++) source.Emit(); // Hint arriving during the initial scan.
            if (seen.Count == 4) { second.TrySetResult(); cancel.Cancel(); }
        }, cancel.Token);
        await clock.WaitForTimerAsync(AvailabilityScanWake.CoalescingInterval); clock.Advance(AvailabilityScanWake.CoalescingInterval);
        await Wait(second.Task); await Wait(scanner);
        Need(seen.SequenceEqual(["known-a", "known-b", "known-a", "known-b"]) && clock.Active == 0,
            "provider's actual scanner seam retains in-flight pulse and rescans only frozen authorized manifest, never event paths/new files");
    }
    private static async Task ProviderStopComposition()
    {
        var clock = new ManualClock(); var source = new Notifications(); var wake = new AvailabilityScanWake(source.Bind, clock);
        var enteredA = Signal(); var enteredB = Signal(); var release = Signal(); var history = new ConcurrentQueue<string>();
        using var cancel = new CancellationTokenSource();
        var workers = new BoundedAvailabilityWorkers(["a", "b"], _ => new(AvailabilityIntent.Keep, true), async (relative, _, _) => {
            (relative == "a" ? enteredA : enteredB).TrySetResult(); await release.Task; history.Enqueue("worker-joined");
        }, _ => { });
        var scanner = wake.RunScannerAsync(["a", "b"], path => workers.Observe(path, new(AvailabilityIntent.Keep, true)), cancel.Token);
        await Wait(Task.WhenAll(enteredA.Task, enteredB.Task));
        wake.Stop(); cancel.Cancel();
        await workers.StopAndDrainAsync(() => { history.Enqueue("disconnect"); release.TrySetResult(); return Task.CompletedTask; }, () => scanner);
        Need(source.Disposals == 0 && history.First() == "disconnect", "watcher disposal and blocked native joins cannot precede callback disconnect");
        await wake.DisposeAsync();
        Need(source.Disposals == 1 && scanner.IsCompleted && clock.Active == 0 && history.Count(item => item == "worker-joined") == 2,
            "provider composition joins scanner, fixed native workers and watcher without orphan waits or early disposal");
    }

    private static async Task SingleWaitAndStopDuringScan()
    {
        var clock = new ManualClock(); var source = new Notifications(); var wake = new AvailabilityScanWake(source.Bind, clock);
        var pending = wake.WaitForNextScanAsync(); var refused = false;
        try { _ = wake.WaitForNextScanAsync(); } catch (InvalidOperationException) { refused = true; }
        Need(refused && clock.Created == 1, "single scanner contract prevents untracked competing semaphore waits/timers");
        await wake.DisposeAsync(); await Cancelled(pending);
        clock = new ManualClock(); source = new Notifications(); await using var stopped = new AvailabilityScanWake(source.Bind, clock);
        var inspected = new List<string>();
        await stopped.RunScannerAsync(["one", "two"], path => { inspected.Add(path); stopped.Stop(); }, CancellationToken.None);
        Need(inspected.SequenceEqual(["one"]) && clock.Active == 0, "Stop during inspection admits no later manifest work even without caller cancellation");
    }

    private sealed class Notifications : IDisposable
    {
        private Action? changed, failed;
        internal bool FailOnBind, ThrowDispose;
        internal int Disposals;
        internal IDisposable Bind(Action changed, Action failed) { this.changed = changed; this.failed = failed; if (FailOnBind) failed(); return this; }
        internal void Emit() => changed?.Invoke();
        internal void Fail() => failed?.Invoke();
        public void Dispose() { Disposals++; if (ThrowDispose) throw new IOException("Synthetic watcher cleanup uncertainty."); }
    }
    private sealed class ManualClock : TimeProvider
    {
        private readonly object sync = new();
        private readonly List<ManualTimer> timers = [];
        private readonly SemaphoreSlim changes = new(0);
        private long now;
        internal int Created { get { lock (sync) return timers.Count; } }
        internal int Active { get { lock (sync) return timers.Count(timer => !timer.Disposed && timer.Due != long.MaxValue); } }
        internal int CountDue(TimeSpan delay) { lock (sync) return timers.Count(timer => !timer.Disposed && timer.Due != long.MaxValue && timer.Delay == delay); }
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() { lock (sync) return now; }
        public override DateTimeOffset GetUtcNow() { lock (sync) return DateTimeOffset.UnixEpoch.AddTicks(now); }
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            lock (sync) { var timer = new ManualTimer(this, callback, state); timers.Add(timer); timer.Change(dueTime, period); return timer; }
        }
        internal void Advance(TimeSpan duration)
        {
            ManualTimer[] ready;
            lock (sync) { now += duration.Ticks; ready = timers.Where(timer => !timer.Disposed && timer.Due <= now).ToArray(); foreach (var timer in ready) timer.Due = timer.Period == Timeout.InfiniteTimeSpan ? long.MaxValue : now + timer.Period.Ticks; }
            foreach (var timer in ready) if (!timer.Disposed) timer.Callback(timer.State);
        }
        internal async Task WaitForTimerAsync(TimeSpan delay)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            while (CountDue(delay) == 0) await changes.WaitAsync(deadline.Token);
        }
        private sealed class ManualTimer(ManualClock owner, TimerCallback callback, object? state) : ITimer
        {
            internal readonly TimerCallback Callback = callback;
            internal readonly object? State = state;
            internal bool Disposed;
            internal long Due = long.MaxValue;
            internal TimeSpan Delay, Period;
            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                lock (owner.sync) {
                    if (Disposed) return false;
                    Delay = dueTime; Period = period; Due = dueTime == Timeout.InfiniteTimeSpan ? long.MaxValue : owner.now + dueTime.Ticks;
                    owner.changes.Release(); return true;
                }
            }
            public void Dispose() { lock (owner.sync) Disposed = true; }
            public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
        }
    }
}
