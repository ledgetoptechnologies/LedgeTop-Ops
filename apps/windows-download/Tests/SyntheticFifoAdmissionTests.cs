internal static class SyntheticFifoAdmissionTests
{
    private sealed class Clock : TimeProvider
    {
        internal long Now;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => Now;
        internal void Advance(TimeSpan duration) => Now += duration.Ticks;
    }
    private static void Need(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static async Task Expect<T>(Task task) where T : Exception
    { try { await task; } catch (T) { return; } throw new InvalidOperationException("Expected " + typeof(T).Name); }
    internal static async Task RunAsync()
    {
        var clock = new Clock(); using var fifo = new SyntheticFifoAdmission(2, 2, clock);
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); var c = Guid.NewGuid();
        using var first = await fifo.AcquireAsync("root-a", a);
        var second = fifo.AcquireAsync("ROOT-A", b); var third = fifo.AcquireAsync("root-a", c);
        clock.Advance(TimeSpan.FromMinutes(180));
        Need(!second.IsCompleted && !third.IsCompleted && fifo.WaitingAge("root-a", b) == TimeSpan.FromMinutes(180), "elapsed time must not expire waiters");
        await Expect<InvalidOperationException>(fifo.AcquireAsync("root-a", Guid.NewGuid()));
        await Expect<InvalidOperationException>(fifo.AcquireAsync("root-a", b));
        using (var independent = await fifo.AcquireAsync("root-b", a)) {
            await Expect<InvalidOperationException>(fifo.AcquireAsync("root-c", Guid.NewGuid()));
        }
        first.Dispose(); using (await second) Need(!third.IsCompleted, "FIFO grants only one and in request order");
        using (await third) { }
        // Disposed root state retires so bounded root capacity can be reused.
        using (await fifo.AcquireAsync("root-c", Guid.NewGuid())) { }

        using var stop = new SyntheticFifoAdmission(1, 3);
        using var active = await stop.AcquireAsync("root", Guid.NewGuid());
        using var cancelMiddle = new CancellationTokenSource();
        var waitingA = stop.AcquireAsync("root", Guid.NewGuid());
        var waitingB = stop.AcquireAsync("root", Guid.NewGuid(), cancelMiddle.Token);
        var waitingC = stop.AcquireAsync("root", Guid.NewGuid());
        cancelMiddle.Cancel(); await Expect<OperationCanceledException>(waitingB);
        active.Dispose(); using (await waitingA) Need(!waitingC.IsCompleted, "cancelled middle must not reorder remaining waiters");
        using (await waitingC) { }
        var held = await stop.AcquireAsync("root", Guid.NewGuid());
        var waitingOnClose = stop.AcquireAsync("root", Guid.NewGuid());
        stop.Dispose(); await Expect<ObjectDisposedException>(waitingOnClose);
        await Expect<ObjectDisposedException>(stop.AcquireAsync("root", Guid.NewGuid()));
        held.Dispose(); // Closing admission never releases a caller's active lease early.

        // Race each granted ticket against cancellation; if a caller receives a
        // lease it owns and releases it, otherwise admission must revoke it.
        for (var i = 0; i < 100; i++) {
            using var race = new SyntheticFifoAdmission(1, 2);
            var head = await race.AcquireAsync("root", Guid.NewGuid());
            using var cancellation = new CancellationTokenSource();
            var raced = race.AcquireAsync("root", Guid.NewGuid(), cancellation.Token);
            var tail = race.AcquireAsync("root", Guid.NewGuid());
            await Task.WhenAll(Task.Run(head.Dispose), Task.Run(cancellation.Cancel));
            try { using var acquired = await raced; } catch (OperationCanceledException) { }
            using var last = await tail.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Console.WriteLine("PASS synthetic FIFO bounds, distinct identities, cancellation/grant races and disposal. No native or filesystem calls.");
    }
}
