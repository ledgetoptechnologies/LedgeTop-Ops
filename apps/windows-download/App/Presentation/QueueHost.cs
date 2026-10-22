using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Presentation;

/// <summary>A transfer as shown in the list: which source it belongs to plus the queue's own record.</summary>
public sealed record TransferItem(string SourceAlias, QueuedTransfer Job);

public enum EnqueueOutcome { Added, AlreadyQueued, NameTaken }

/// <summary>
/// Presents one durable <see cref="TransferQueue"/> per source as a single list for one signed-in person.
/// The queues never start work by themselves, so this runs exactly one transfer at a time across all
/// sources: waiting items start in order, and paused items start only after an explicit resume.
/// Stopping never waits for network or sign-in checks; it uses the transfers this host already owns.
/// </summary>
public sealed class QueueHost : IAsyncDisposable
{
    private readonly Dictionary<string, TransferQueue> queues;
    private readonly SemaphoreSlim pump = new(1, 1);
    private readonly object sync = new();
    /// <summary>Waiting items the person paused; never auto-started until resumed.</summary>
    private readonly HashSet<Guid> held = [];
    /// <summary>Paused items the person resumed, waiting their turn.</summary>
    private readonly List<Guid> wanted = [];
    private IReadOnlyList<TransferItem> known = [];
    private (string Alias, Guid Id)? active;
    private bool disposed;

    private QueueHost(Dictionary<string, TransferQueue> queues) => this.queues = queues;

    /// <summary>Raised (on any thread) after the list may have changed.</summary>
    public event Action? Changed;
    /// <summary>Raised (on any thread) with progress for the running transfer.</summary>
    public event Action<Guid, DownloadProgress>? Progress;

    /// <summary>
    /// Opens each source's queue for the person signed in now. Each person's queue lives in its own folder
    /// (named by the source's opaque principal ID), so another person never opens or sees it.
    /// </summary>
    public static async Task<QueueHost> OpenAsync(string stateDirectory, IEnumerable<IQueuedDownloadSource> sources, CancellationToken cancellationToken = default)
    {
        var opened = new Dictionary<string, TransferQueue>(StringComparer.Ordinal);
        try {
            foreach (var source in sources) {
                var principal = (await source.GetSessionAsync(cancellationToken)).PrincipalId;
                if (!System.Text.RegularExpressions.Regex.IsMatch(principal, @"\Aodqp1_[a-f0-9]{64}\z")) throw new AccessDeniedException();
                var folder = Path.Combine(stateDirectory, source.Alias, principal);
                Directory.CreateDirectory(folder);
                opened[source.Alias] = await TransferQueue.OpenAsync(folder, source, cancellationToken);
            }
        } catch {
            foreach (var queue in opened.Values) await queue.DisposeAsync();
            throw;
        }
        return new QueueHost(opened);
    }

    /// <summary>True while a transfer is running or being stopped; no network.</summary>
    public bool IsBusy { get { lock (sync) return active is not null; } }
    /// <summary>Waiting items held by Pause all that haven't been saved as paused yet.</summary>
    public bool IsHeld(Guid jobId) { lock (sync) return held.Contains(jobId); }
    public bool HasHeld { get { lock (sync) return held.Count > 0; } }
    /// <summary>Paused items the person resumed that are waiting their turn.</summary>
    public bool IsWanted(Guid jobId) { lock (sync) return wanted.Contains(jobId); }

    /// <summary>The list as last read; no network.</summary>
    public IReadOnlyList<TransferItem> Known { get { lock (sync) return known; } }

    /// <summary>Reads every queue (each read rechecks the signed-in person).</summary>
    public async Task<IReadOnlyList<TransferItem>> SnapshotAsync(CancellationToken cancellationToken = default)
    {
        var items = new List<TransferItem>();
        foreach (var (alias, queue) in queues)
            foreach (var job in await queue.GetJobsAsync(cancellationToken)) items.Add(new TransferItem(alias, job));
        lock (sync) known = items;
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

    /// <summary>Pauses one item. A running item is signalled at once; a waiting one stops being scheduled.</summary>
    public async Task PauseAsync(TransferItem item)
    {
        lock (sync) { held.Add(item.Job.JobId); wanted.Remove(item.Job.JobId); }
        await Queue(item.SourceAlias).PauseAsync(item.Job.JobId);
        Changed?.Invoke();
        _ = PumpAsync();
    }

    public async Task CancelAsync(TransferItem item)
    {
        lock (sync) { held.Remove(item.Job.JobId); wanted.Remove(item.Job.JobId); }
        await Queue(item.SourceAlias).CancelAsync(item.Job.JobId);
        Changed?.Invoke();
        _ = PumpAsync();
    }

    /// <summary>
    /// Stops everything without any network or sign-in check: the running transfer is cancelled through
    /// the queue's own stop signal, and every waiting item is held. Persisting the held items' paused state
    /// happens afterwards in the background and never delays the stop.
    /// </summary>
    public async Task PauseAllAsync()
    {
        (string Alias, Guid Id)? running; List<TransferItem> waiting;
        lock (sync) {
            running = active;
            waiting = known.Where(item => item.Job.State == QueuedTransferState.Queued || wanted.Contains(item.Job.JobId)).ToList();
            foreach (var item in waiting) held.Add(item.Job.JobId);
            if (running is { } current) held.Add(current.Id);
            wanted.Clear();
        }
        if (running is { } stop) await Queue(stop.Alias).PauseAsync(stop.Id);
        Changed?.Invoke();
        _ = Task.Run(async () => {
            foreach (var item in waiting.Where(item => item.Job.State == QueuedTransferState.Queued)) {
                try {
                    using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                    await Queue(item.SourceAlias).PauseAsync(item.Job.JobId, limit.Token);
                } catch (Exception) { /* still held in memory; the queue keeps it waiting */ }
            }
            Changed?.Invoke();
        });
    }

    /// <summary>Puts every paused item back in line; they run one at a time, in list order.</summary>
    public Task ResumeAllAsync()
    {
        lock (sync) {
            foreach (var item in known)
                if (item.Job.State == QueuedTransferState.Paused || held.Contains(item.Job.JobId))
                    if (!wanted.Contains(item.Job.JobId)) wanted.Add(item.Job.JobId);
            held.Clear();
        }
        Changed?.Invoke();
        return PumpAsync();
    }

    /// <summary>Starts this item now (resume or retry), pausing whatever is running.</summary>
    public async Task ResumeAsync(TransferItem item)
    {
        lock (sync) { held.Remove(item.Job.JobId); wanted.Remove(item.Job.JobId); }
        await pump.WaitAsync();
        try {
            (string Alias, Guid Id)? running; lock (sync) running = active;
            if (running is { } current && current.Id != item.Job.JobId) {
                lock (sync) { if (!wanted.Contains(current.Id)) wanted.Insert(0, current.Id); }
                await Queue(current.Alias).PauseAsync(current.Id);
            }
            await Start(item);
        } finally { pump.Release(); }
    }

    /// <summary>Starts the next item when nothing is running: resumed items first, then waiting ones.</summary>
    public async Task PumpAsync()
    {
        if (disposed) return;
        await pump.WaitAsync();
        try {
            lock (sync) if (disposed || active is not null) return;
            var items = await SnapshotAsync();
            TransferItem? next;
            lock (sync) {
                if (items.Any(item => item.Job.State == QueuedTransferState.Running)) return;
                next = wanted.Select(id => items.FirstOrDefault(item => item.Job.JobId == id))
                        .FirstOrDefault(item => item is { Job.State: QueuedTransferState.Paused or QueuedTransferState.Queued })
                    ?? items.FirstOrDefault(item => item.Job.State == QueuedTransferState.Queued && !held.Contains(item.Job.JobId));
                wanted.RemoveAll(id => !items.Any(item => item.Job.JobId == id && item.Job.State is QueuedTransferState.Paused or QueuedTransferState.Queued));
            }
            if (next is not null) await Start(next);
        } catch (Exception) {
            // A session problem surfaces through the items' own states on the next refresh.
            Changed?.Invoke();
        } finally { pump.Release(); }
    }

    private async Task Start(TransferItem item)
    {
        var queue = Queue(item.SourceAlias); var id = item.Job.JobId;
        lock (sync) { wanted.Remove(id); held.Remove(id); active = (item.SourceAlias, id); }
        try { await queue.StartAsync(id, new Relay(progress => Progress?.Invoke(id, progress))); }
        catch { lock (sync) active = null; throw; }
        Changed?.Invoke();
        _ = Task.Run(async () => {
            try { await queue.WaitForIdleAsync(); } catch (Exception) { /* reported through the item's state */ }
            lock (sync) if (active?.Id == id) active = null;
            Changed?.Invoke();
            await PumpAsync();
        });
    }

    private TransferQueue Queue(string alias) =>
        queues.TryGetValue(alias, out var queue) ? queue : throw new InvalidOperationException("Unknown download source.");

    /// <summary>
    /// Stops and drains this person's transfers and releases their queues. The running transfer is signalled
    /// first, without any sign-in check, so it stops even while the session is unreachable.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        (string Alias, Guid Id)? running;
        lock (sync) { if (disposed) return; disposed = true; running = active; }
        if (running is { } stop) {
            try { await Queue(stop.Alias).PauseAsync(stop.Id); } catch (Exception) { /* draining below still stops it */ }
        }
        foreach (var queue in queues.Values) await queue.DisposeAsync();
    }

    /// <summary>Synchronous progress relay so updates aren't reordered by a captured context.</summary>
    private sealed class Relay(Action<DownloadProgress> report) : IProgress<DownloadProgress>
    {
        public void Report(DownloadProgress value) => report(value);
    }
}
