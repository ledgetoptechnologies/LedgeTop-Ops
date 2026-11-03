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
    private static async Task Expect<T>(Task task) where T : Exception
    { try { await task; } catch (T) { return; } throw new InvalidOperationException("Expected " + typeof(T).Name); }
    internal static async Task RunAsync()
    {
        var clock = new Clock(); using var fifo = new SyntheticFifoAdmission(2, 2, clock);
        clock.Throw = true; await Expect<IOException>(fifo.AcquireAsync("clock-failure", Guid.NewGuid())); clock.Throw = false;
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); var c = Guid.NewGuid();
        using var first = await fifo.AcquireAsync("root-a", a);
        Need(first.TryBegin() && !first.TryBegin(), "each granted lease begins at most once");
        var second = fifo.AcquireAsync("ROOT-A", b); var third = fifo.AcquireAsync("root-a", c);
        clock.Advance(TimeSpan.FromMinutes(180));
        Need(!second.IsCompleted && !third.IsCompleted && fifo.WaitingAge("root-a", b) == TimeSpan.FromMinutes(180), "elapsed time must not expire waiters");
        await Expect<InvalidOperationException>(fifo.AcquireAsync("root-a", Guid.NewGuid()));
        await Expect<InvalidOperationException>(fifo.AcquireAsync("root-a", b));
        using (var independent = await fifo.AcquireAsync("root-b", a)) {
            Need(independent.TryBegin(), "second root begins independently after failed clock observation");
            await Expect<InvalidOperationException>(fifo.AcquireAsync("root-c", Guid.NewGuid()));
        }
        first.Dispose(); using (var lease = await second) { Need(lease.TryBegin(), "second begins after grant"); Need(!third.IsCompleted, "FIFO grants only one and in request order"); }
        using (var lease = await third) Need(lease.TryBegin(), "third begins after second releases");
        // Disposed root state retires so bounded root capacity can be reused.
        using (await fifo.AcquireAsync("root-c", Guid.NewGuid())) { }

        using var stop = new SyntheticFifoAdmission(1, 3);
        using var active = await stop.AcquireAsync("root", Guid.NewGuid());
        Need(active.TryBegin(), "active operation starts before stop");
        using var cancelMiddle = new CancellationTokenSource();
        var waitingA = stop.AcquireAsync("root", Guid.NewGuid());
        var waitingB = stop.AcquireAsync("root", Guid.NewGuid(), cancelMiddle.Token);
        var waitingC = stop.AcquireAsync("root", Guid.NewGuid());
        cancelMiddle.Cancel(); await Expect<OperationCanceledException>(waitingB);
        active.Dispose(); using (var lease = await waitingA) { Need(lease.TryBegin(), "first remaining waiter begins"); Need(!waitingC.IsCompleted, "cancelled middle must not reorder remaining waiters"); }
        using (var lease = await waitingC) Need(lease.TryBegin(), "last remaining waiter begins");
        var held = await stop.AcquireAsync("root", Guid.NewGuid());
        var waitingOnClose = stop.AcquireAsync("root", Guid.NewGuid());
        stop.Dispose(); await Expect<ObjectDisposedException>(waitingOnClose);
        Need(!held.TryBegin(), "close prevents a previously granted but unstarted lease from beginning");
        await Expect<ObjectDisposedException>(stop.AcquireAsync("root", Guid.NewGuid()));
        held.Dispose(); // Closing admission never releases a caller's active lease early.

        using (var fence = new SyntheticFifoAdmission(1, 2)) {
            var before = await fence.AcquireAsync("root", Guid.NewGuid()); Need(before.TryBegin(), "head began");
            var grantBeforeClose = fence.AcquireAsync("root", Guid.NewGuid());
            before.Dispose(); // Grants the waiter; its continuation has not been awaited.
            fence.Dispose();
            using var tooLate = await grantBeforeClose;
            Need(!tooLate.TryBegin(), "grant racing close cannot start work after close");
        }
        using (var fence = new SyntheticFifoAdmission(1, 2)) {
            using var generation = new CancellationTokenSource();
            using var granted = await fence.AcquireAsync("root", Guid.NewGuid(), generation.Token);
            generation.Cancel();
            Need(!granted.TryBegin(), "cancelled owning generation cannot start through an uncancelled caller token");
        }
        using (var fence = new SyntheticFifoAdmission(1, 2)) {
            var begun = await fence.AcquireAsync("root", Guid.NewGuid()); Need(begun.TryBegin(), "operation begins before close");
            var queued = fence.AcquireAsync("root", Guid.NewGuid()); fence.Dispose();
            await Expect<ObjectDisposedException>(queued);
            begun.Dispose(); // A begun operation keeps its lease until its own release.
        }

        // Race each granted ticket against cancellation; if a caller receives a
        // lease it owns and releases it, otherwise admission must revoke it.
        for (var i = 0; i < 100; i++) {
            using var race = new SyntheticFifoAdmission(1, 2);
            var head = await race.AcquireAsync("root", Guid.NewGuid());
            Need(head.TryBegin(), "race head begins");
            using var cancellation = new CancellationTokenSource();
            var raced = race.AcquireAsync("root", Guid.NewGuid(), cancellation.Token);
            var tail = race.AcquireAsync("root", Guid.NewGuid());
            await Task.WhenAll(Task.Run(head.Dispose), Task.Run(cancellation.Cancel));
            try { using var acquired = await raced; if (!cancellation.IsCancellationRequested) Need(acquired.TryBegin(cancellation.Token), "uncancelled grant begins"); } catch (OperationCanceledException) { }
            using var last = await tail.WaitAsync(TimeSpan.FromSeconds(5));
            Need(last.TryBegin(), "tail begins after cancellation/grant race settles");
        }
        Console.WriteLine("PASS synthetic FIFO bounds, distinct identities, cancellation/grant races and disposal. No native or filesystem calls.");
    }
}
