internal static class SyntheticFifoAdmissionTests
{
    private sealed class Clock : TimeProvider
    {
        internal long Now;
        internal bool Throw;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => Throw ? throw new IOException("Synthetic clock failure") : Now;
        internal void Advance(TimeSpan duration) => Now += duration.Ticks;
    }
    private static void Need(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static IDisposable Begin(SyntheticFifoAdmission.Lease lease) => lease.TryBegin() ?? throw new InvalidOperationException("Expected work admission.");
    private static async Task Expect<T>(Task task) where T : Exception
    { try { await task; } catch (T) { return; } throw new InvalidOperationException("Expected " + typeof(T).Name); }
    internal static async Task RunAsync()
    {
        var clock = new Clock(); using var fifo = new SyntheticFifoAdmission(2, 2, clock);
        clock.Throw = true; await Expect<IOException>(fifo.AcquireAsync("clock-failure", Guid.NewGuid())); clock.Throw = false;
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); var c = Guid.NewGuid();
        using var first = await fifo.AcquireAsync("root-a", a);
        var firstWork = Begin(first);
        Need(first.TryBegin() is null, "each granted lease begins at most once");
        var second = fifo.AcquireAsync("ROOT-A", b); var third = fifo.AcquireAsync("root-a", c);
        clock.Advance(TimeSpan.FromMinutes(180));
        Need(!second.IsCompleted && !third.IsCompleted && fifo.WaitingAge("root-a", b) == TimeSpan.FromMinutes(180), "elapsed time must not expire waiters");
        await Expect<InvalidOperationException>(fifo.AcquireAsync("root-a", Guid.NewGuid()));
        await Expect<InvalidOperationException>(fifo.AcquireAsync("root-a", b));
        using (var independent = await fifo.AcquireAsync("root-b", a)) {
            using var independentWork = Begin(independent);
            await Expect<InvalidOperationException>(fifo.AcquireAsync("root-c", Guid.NewGuid()));
        }
        first.Dispose(); Need(!second.IsCompleted, "release request cannot retire begun work");
        firstWork.Dispose();
        using (var lease = await second) { using var work = Begin(lease); Need(!third.IsCompleted, "FIFO grants only one and in request order"); }
        using (var lease = await third) using (Begin(lease)) { }
        // Disposed root state retires so bounded root capacity can be reused.
        using (await fifo.AcquireAsync("root-c", Guid.NewGuid())) { }

        using var stop = new SyntheticFifoAdmission(1, 3);
        using var active = await stop.AcquireAsync("root", Guid.NewGuid());
        var activeWork = Begin(active);
        using var cancelMiddle = new CancellationTokenSource();
        var waitingA = stop.AcquireAsync("root", Guid.NewGuid());
        var waitingB = stop.AcquireAsync("root", Guid.NewGuid(), cancelMiddle.Token);
        var waitingC = stop.AcquireAsync("root", Guid.NewGuid());
        cancelMiddle.Cancel(); await Expect<OperationCanceledException>(waitingB);
        active.Dispose(); activeWork.Dispose();
        using (var lease = await waitingA) { using var work = Begin(lease); Need(!waitingC.IsCompleted, "cancelled middle must not reorder remaining waiters"); }
        using (var lease = await waitingC) using (Begin(lease)) { }
        var held = await stop.AcquireAsync("root", Guid.NewGuid());
        var waitingOnClose = stop.AcquireAsync("root", Guid.NewGuid());
        stop.Dispose(); await Expect<ObjectDisposedException>(waitingOnClose);
        Need(held.TryBegin() is null, "close prevents a previously granted but unstarted lease from beginning");
        await Expect<ObjectDisposedException>(stop.AcquireAsync("root", Guid.NewGuid()));
        held.Dispose(); // Closing admission never releases a caller's active lease early.

        using (var fence = new SyntheticFifoAdmission(1, 2)) {
            var before = await fence.AcquireAsync("root", Guid.NewGuid()); var beforeWork = Begin(before);
            var grantBeforeClose = fence.AcquireAsync("root", Guid.NewGuid());
            before.Dispose(); beforeWork.Dispose(); // Grants waiter; its continuation has not been awaited.
            fence.Dispose();
            using var tooLate = await grantBeforeClose;
            Need(tooLate.TryBegin() is null, "grant racing close cannot start work after close");
        }
        using (var fence = new SyntheticFifoAdmission(1, 2)) {
            using var generation = new CancellationTokenSource();
            using var granted = await fence.AcquireAsync("root", Guid.NewGuid(), generation.Token);
            generation.Cancel();
            Need(granted.TryBegin() is null, "cancelled owning generation cannot start through an uncancelled caller token");
        }
        using (var fence = new SyntheticFifoAdmission(1, 2)) {
            var begun = await fence.AcquireAsync("root", Guid.NewGuid()); var work = Begin(begun);
            var queued = fence.AcquireAsync("root", Guid.NewGuid()); fence.Dispose();
            await Expect<ObjectDisposedException>(queued);
            begun.Dispose(); work.Dispose(); // Work owns the root through its actual join.
        }
        using (var fence = new SyntheticFifoAdmission(1, 2)) {
            var disposedFirst = await fence.AcquireAsync("root", Guid.NewGuid());
            disposedFirst.Dispose();
            Need(disposedFirst.TryBegin() is null, "release winning the lock prevents a later begin");
            using var next = await fence.AcquireAsync("root", Guid.NewGuid()); using var nextWork = Begin(next);
        }
        var grantEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var grantContinue = new ManualResetEventSlim(); var grantCount = 0;
        using (var fence = new SyntheticFifoAdmission(1, 2, beforeGrantCompletion: () => {
            if (Interlocked.Increment(ref grantCount) == 2) { grantEntered.TrySetResult(); if (!grantContinue.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException(); }
        })) {
            var head = await fence.AcquireAsync("root", Guid.NewGuid()); var work = Begin(head);
            var successor = fence.AcquireAsync("root", Guid.NewGuid()); head.Dispose();
            var finishing = Task.Run(work.Dispose);
            try {
                await grantEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                fence.Dispose(); // Grant state exists, but its completion has not yet run.
            } finally { grantContinue.Set(); }
            await finishing;
            using var afterClose = await successor;
            Need(afterClose.TryBegin() is null, "close between grant and completion fences later work");
        }

        // Race each granted ticket against cancellation; if a caller receives a
        // lease it owns and releases it, otherwise admission must revoke it.
        for (var i = 0; i < 100; i++) {
            using var race = new SyntheticFifoAdmission(1, 2);
            var head = await race.AcquireAsync("root", Guid.NewGuid());
            var headWork = Begin(head);
            using var cancellation = new CancellationTokenSource();
            var raced = race.AcquireAsync("root", Guid.NewGuid(), cancellation.Token);
            var tail = race.AcquireAsync("root", Guid.NewGuid());
            await Task.WhenAll(Task.Run(head.Dispose), Task.Run(cancellation.Cancel));
            Need(!tail.IsCompleted, "release racing cancellation cannot release running work");
            headWork.Dispose();
            try { using var acquired = await raced; if (!cancellation.IsCancellationRequested) using (acquired.TryBegin(cancellation.Token)) { } } catch (OperationCanceledException) { }
            using var last = await tail.WaitAsync(TimeSpan.FromSeconds(5));
            using var lastWork = Begin(last);
        }
        Console.WriteLine("PASS synthetic FIFO bounds, distinct identities, cancellation/grant races and disposal. No native or filesystem calls.");
    }
}
