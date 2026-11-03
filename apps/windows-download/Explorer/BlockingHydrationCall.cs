namespace LedgeTop.Files.Explorer;

// CfHydratePlaceholder with no OVERLAPPED blocks until FETCH_DATA is settled.
// Run this only after BoundedAvailabilityWorkers grants a slot: at most four
// calls may hold dedicated threads, leaving pool workers available to serve FETCH_DATA.
internal static class BlockingHydrationCall
{
    internal static Task RunAsync(Action hydrate, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(hydrate);
        return Task.Factory.StartNew(() => {
            // Cancellation prevents a new call, but never abandons one already in flight.
            cancellationToken.ThrowIfCancellationRequested();
            hydrate();
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }
}
