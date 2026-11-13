using LedgeTop.Files.Explorer;

// Explicit red regression, never selected by the normal app test suite. It models
// selector loss between the retry precheck and postcheck using the real bounded
// scanner/worker admission class, but performs no native or filesystem work.
internal static class FreshRetrySelectorRaceTests
{
    internal static async Task Run()
    {
        var selectorCurrent = 1;
        var executions = 0;
        var executedAfterLoss = 0;
        var observation = new AvailabilityObservation(AvailabilityIntent.Keep, true);
        var workers = new BoundedAvailabilityWorkers(["sample"], _ => observation, (_, _, _) => {
            if (Interlocked.Increment(ref executions) == 1) throw new IOException("synthetic first failure");
            if (Volatile.Read(ref selectorCurrent) == 0) Interlocked.Increment(ref executedAfterLoss);
            return Task.CompletedTask;
        }, _ => { });
        try {
            if (!workers.Observe("sample", observation)) throw new Exception("Initial action not admitted.");
            await workers.WhenJoinedAsync("sample").WaitAsync(TimeSpan.FromSeconds(5));
            if (workers.Observe("sample", observation)) throw new Exception("Failed intent was not suppressed.");
            if (Volatile.Read(ref selectorCurrent) != 1) throw new Exception("Precheck not current.");
            if (!workers.RetryFailedIntents()) throw new Exception("Retry admission refused.");
            // A different actor replaces/invalidates the selector here, before
            // retry's postcheck. The scanner then observes the same Keep intent.
            Volatile.Write(ref selectorCurrent, 0);
            if (!workers.Observe("sample", observation)) throw new Exception("Retry scan not scheduled.");
            await workers.WhenJoinedAsync("sample").WaitAsync(TimeSpan.FromSeconds(5));
            Console.WriteLine($"Synthetic race: executions={executions}; executedAfterSelectorLoss={executedAfterLoss}; postcheckCurrent={Volatile.Read(ref selectorCurrent) == 1}");
            if (executedAfterLoss != 0) throw new InvalidOperationException("Availability action ran after selector proof was lost.");
        } finally {
            await workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask).WaitAsync(TimeSpan.FromSeconds(5));
        }
    }
}
