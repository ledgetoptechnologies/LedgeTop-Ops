using System.Collections.Concurrent;
using LedgeTop.Files.Explorer;

// Run only via its dedicated CLI switch: constraining the pool is process-wide.
internal static class DedicatedHydrationWorkerTests
{
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static void Need(bool value, string message) { if (!value) throw new IOException(message); }
    private static async Task Wait(Task task) => await task.WaitAsync(TimeSpan.FromSeconds(12));

    internal static async Task<int> RunAsync()
    {
        ThreadPool.GetMinThreads(out var originalMin, out var minIo);
        ThreadPool.GetMaxThreads(out var originalMax, out var maxIo);
        try {
            if (!ThreadPool.SetMinThreads(1, minIo) || !ThreadPool.SetMaxThreads(1, maxIo))
                throw new IOException("Could not constrain the synthetic test's worker pool.");
            await FourCallsAllowPoolCallback();
            await ExceptionsAndCancellation();
            await DisconnectBeforeRunningCallsDrain();
            Console.WriteLine("PASS dedicated hydration: constrained pool callback, four-slot admission, exceptions, cancellation and disconnect-before-drain; fake native calls only.");
            return 0;
        } finally {
            ThreadPool.SetMaxThreads(originalMax, maxIo);
            ThreadPool.SetMinThreads(originalMin, minIo);
        }
    }

    private static async Task FourCallsAllowPoolCallback()
    {
        var names = new[] { "a", "b", "c", "d", "e" };
        var release = new ManualResetEventSlim(); var entered = Signal();
        var callback = Signal(); var threads = new ConcurrentDictionary<int, byte>();
        var running = 0; var maximum = 0; var starts = 0;
        var workers = new BoundedAvailabilityWorkers(names, _ => new(AvailabilityIntent.Keep, true),
            (_, _, token) => BlockingHydrationCall.RunAsync(() => {
                Need(!Thread.CurrentThread.IsThreadPoolThread, "Native work used the worker pool.");
                threads.TryAdd(Environment.CurrentManagedThreadId, 0);
                var active = Interlocked.Increment(ref running);
                int prior; do { prior = Volatile.Read(ref maximum); if (prior >= active) break; }
                while (Interlocked.CompareExchange(ref maximum, active, prior) != prior);
                if (Interlocked.Increment(ref starts) == 4) {
                    entered.TrySetResult();
                    ThreadPool.QueueUserWorkItem(_ => { callback.TrySetResult(); release.Set(); });
                }
                try { if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("Callback did not release native calls."); }
                finally { Interlocked.Decrement(ref running); }
            }, token), _ => { });
        try {
            foreach (var name in names) Need(workers.Observe(name, new(AvailabilityIntent.Keep, true)), "Could not queue fake hydration.");
            await Wait(entered.Task); await Wait(callback.Task);
            await Wait(Task.WhenAll(names.Select(workers.WhenJoinedAsync)));
            Need(starts == 5 && maximum <= 4 && threads.Count >= 4, "The four-slot limit or dedicated starts failed.");
        } finally {
            release.Set();
            await Wait(workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask));
            release.Dispose();
        }
    }

    private static async Task ExceptionsAndCancellation()
    {
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel(); var called = false;
        try { await BlockingHydrationCall.RunAsync(() => called = true, cancelled.Token); throw new IOException("Cancelled work ran."); }
        catch (OperationCanceledException) { }
        Need(!called, "Cancelled native work must not start.");
        try { await BlockingHydrationCall.RunAsync(() => throw new InvalidOperationException("synthetic"), CancellationToken.None); throw new IOException("Exception was lost."); }
        catch (InvalidOperationException error) when (error.Message == "synthetic") { }
    }

    private static async Task DisconnectBeforeRunningCallsDrain()
    {
        var names = new[] { "a", "b", "c", "d" }; var entered = names.Select(_ => Signal()).ToArray();
        var release = names.Select(_ => new ManualResetEventSlim()).ToArray(); var disconnected = Signal(); var count = 0;
        var workers = new BoundedAvailabilityWorkers(names, _ => new(AvailabilityIntent.Keep, true),
            (path, _, token) => BlockingHydrationCall.RunAsync(() => {
                var index = Array.IndexOf(names, path); entered[index].TrySetResult();
                if (!release[index].Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("Synthetic native call was not released.");
                Interlocked.Increment(ref count);
            }, token), _ => { });
        Task? stopping = null;
        try {
            foreach (var name in names) Need(workers.Observe(name, new(AvailabilityIntent.Keep, true)), "Could not queue fake hydration.");
            await Wait(Task.WhenAll(entered.Select(x => x.Task)));
            stopping = workers.StopAndDrainAsync(() => { disconnected.TrySetResult(); foreach (var item in release.Take(3)) item.Set(); return Task.CompletedTask; }, () => Task.CompletedTask);
            await Wait(disconnected.Task);
            Need(!stopping.IsCompleted && !workers.WhenJoinedAsync("d").IsCompleted, "Drain did not await the running native call.");
            release[3].Set(); await Wait(stopping); Need(count == 4, "A running call was abandoned after cancellation.");
        } finally {
            foreach (var item in release) item.Set();
            await Wait(stopping ?? workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask));
            foreach (var item in release) item.Dispose();
        }
    }
}
