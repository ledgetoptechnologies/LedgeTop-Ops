using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Presentation;

/// <summary>A transfer as shown in the list: which source it belongs to plus the queue's own record.</summary>
public sealed record TransferItem(string SourceAlias, QueuedTransfer Job);

public enum EnqueueOutcome { Added, AlreadyQueued, NameTaken }

/// <summary>
/// Presents one durable <see cref="TransferQueue"/> per source as a single list. The queues never start
/// work by themselves, so this runs exactly one transfer at a time across all sources and starts the next
/// waiting one when it finishes. Paused, failed and sign-in-blocked items wait for an explicit action.
/// </summary>
public sealed class QueueHost : IAsyncDisposable
{
    private readonly Dictionary<string, TransferQueue> queues;
    private readonly SemaphoreSlim pump = new(1, 1);
    private bool disposed;

    private QueueHost(Dictionary<string, TransferQueue> queues) => this.queues = queues;

    /// <summary>Raised (on any thread) after the list may have changed.</summary>
    public event Action? Changed;
    /// <summary>Raised (on any thread) with progress for the running transfer.</summary>
    public event Action<Guid, DownloadProgress>? Progress;

    /// <summary>Opens each source's queue under its own app-owned folder. Requires a current signed-in session.</summary>
    public static async Task<QueueHost> OpenAsync(string stateDirectory, IEnumerable<IQueuedDownloadSource> sources, CancellationToken cancellationToken = default)
    {
        var opened = new Dictionary<string, TransferQueue>(StringComparer.Ordinal);
        try {
            foreach (var source in sources) {
                var folder = Path.Combine(stateDirectory, source.Alias);
                Directory.CreateDirectory(folder);
                opened[source.Alias] = await TransferQueue.OpenAsync(folder, source, cancellationToken);
            }
        } catch {
            foreach (var queue in opened.Values) await queue.DisposeAsync();
            throw;
        }
        return new QueueHost(opened);
    }

    public async Task<IReadOnlyList<TransferItem>> SnapshotAsync(CancellationToken cancellationToken = default)
    {
        var items = new List<TransferItem>();
        foreach (var (alias, queue) in queues)
            foreach (var job in await queue.GetJobsAsync(cancellationToken)) items.Add(new TransferItem(alias, job));
        return items;
    }

    /// <summary>Adds a file unless a file of that name is already in the folder or it's already waiting there.</summary>
    public async Task<EnqueueOutcome> EnqueueAsync(string sourceAlias, string reference, string fileName, string destination,
        CancellationToken cancellationToken = default)
    {
        // Never overwrite: an existing file of the same name is reported before anything is queued.
        if (File.Exists(Path.Combine(destination, fileName)) || Directory.Exists(Path.Combine(destination, fileName))) return EnqueueOutcome.NameTaken;
        try { await Queue(sourceAlias).EnqueueAsync(reference, destination, cancellationToken); }
        catch (TransferException error) when (error.Message.Contains("already contains", StringComparison.Ordinal)) { return EnqueueOutcome.AlreadyQueued; }
        Changed?.Invoke();
        _ = PumpAsync();
        return EnqueueOutcome.Added;
    }

    public Task PauseAsync(TransferItem item) => Act(item, (queue, id) => queue.PauseAsync(id));
    public Task CancelAsync(TransferItem item) => Act(item, (queue, id) => queue.CancelAsync(id));
    /// <summary>Resume and retry both start this item now, ahead of waiting items.</summary>
    public Task ResumeAsync(TransferItem item) => Begin(item);

    public async Task PauseAllAsync()
    {
        foreach (var item in await SnapshotAsync())
            if (item.Job.State is QueuedTransferState.Running or QueuedTransferState.Queued) await Queue(item.SourceAlias).PauseAsync(item.Job.JobId);
        Changed?.Invoke();
    }

    /// <summary>Puts paused items back in line; they start one at a time.</summary>
    public async Task ResumeAllAsync()
    {
        foreach (var item in await SnapshotAsync())
            if (item.Job.State == QueuedTransferState.Paused) { await Begin(item); return; }
    }

    private async Task Act(TransferItem item, Func<TransferQueue, Guid, Task> action)
    {
        await action(Queue(item.SourceAlias), item.Job.JobId);
        Changed?.Invoke();
        _ = PumpAsync();
    }

    private async Task Begin(TransferItem item)
    {
        await pump.WaitAsync();
        try {
            if (await RunningAsync() is { } running && running.Job.JobId != item.Job.JobId)
                await Queue(running.SourceAlias).PauseAsync(running.Job.JobId);
            await Start(item);
        } finally { pump.Release(); }
    }

    /// <summary>Starts the oldest waiting transfer when nothing is running.</summary>
    public async Task PumpAsync()
    {
        if (disposed) return;
        await pump.WaitAsync();
        try {
            if (disposed || await RunningAsync() is not null) return;
            var next = (await SnapshotAsync()).FirstOrDefault(item => item.Job.State == QueuedTransferState.Queued);
            if (next is not null) await Start(next);
        } catch (Exception) {
            // A session problem surfaces through the items' own states on the next refresh.
            Changed?.Invoke();
        } finally { pump.Release(); }
    }

    private async Task<TransferItem?> RunningAsync() =>
        (await SnapshotAsync()).FirstOrDefault(item => item.Job.State == QueuedTransferState.Running);

    private async Task Start(TransferItem item)
    {
        var queue = Queue(item.SourceAlias); var id = item.Job.JobId;
        await queue.StartAsync(id, new Relay(progress => Progress?.Invoke(id, progress)));
        Changed?.Invoke();
        _ = Task.Run(async () => {
            try { await queue.WaitForIdleAsync(); } catch (Exception) { /* reported through the item's state */ }
            Changed?.Invoke();
            await PumpAsync();
        });
    }

    private TransferQueue Queue(string alias) =>
        queues.TryGetValue(alias, out var queue) ? queue : throw new InvalidOperationException("Unknown download source.");

    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        foreach (var queue in queues.Values) await queue.DisposeAsync();
    }

    /// <summary>Synchronous progress relay so updates aren't reordered by a captured context.</summary>
    private sealed class Relay(Action<DownloadProgress> report) : IProgress<DownloadProgress>
    {
        public void Report(DownloadProgress value) => report(value);
    }
}
