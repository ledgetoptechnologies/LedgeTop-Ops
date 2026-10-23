using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Presentation;

/// <summary>A transfer as shown in the list: which source it belongs to plus the queue's own record.</summary>
public sealed record TransferItem(string SourceAlias, QueuedTransfer Job);

public enum EnqueueOutcome { Added, AlreadyQueued, NameTaken, UnsafeName }

/// <summary>Deterministic pause points for tests. Production leaves every hook unset.</summary>
internal sealed class QueueHostHooks
{
    internal Func<string, bool>? Exists;
    internal Func<Task>? AfterSnapshot, BeforeRunningPause, BeforeHeldPersist, BeforeStart, AfterStartPublished;
    internal Action<Guid>? Starting;
    /// <summary>After Pause all's background save has finished its last item.</summary>
    internal Action? HeldSaveSettled;
    /// <summary>After a start attempt has either begun the transfer or been refused, superseded or failed.</summary>
    internal Action<Guid>? StartSettled;
}

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
    /// <summary>Background saves (Pause all) that closing must wait for before releasing the queues.</summary>
    private readonly HashSet<Task> background = [];
    private (string Alias, Guid Id)? active;
    /// <summary>Bumped by every Pause all, and per item by Pause and Cancel. A start remembers the values it was
    /// chosen or requested under and never begins once a newer stop has happened.</summary>
    private long pauseAlls;
    private readonly Dictionary<Guid, long> stops = [];
    private readonly record struct StartIntent(Guid Id, long PauseAlls, long Stops);
    private bool disposed;
    private Task? disposal;

    internal QueueHostHooks Hooks { get; } = new();

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
        // The listed name comes from the server. Check it is one plain name before it reaches any path:
        // a rooted or UNC name would otherwise make the existence check below touch another place.
        if (!IsPlainFileName(fileName)) return EnqueueOutcome.UnsafeName;
        // Never overwrite: an existing file of the same name is reported before anything is queued.
        if ((Hooks.Exists ?? Exists)(Path.Combine(destination, fileName))) return EnqueueOutcome.NameTaken;
        try { await Queue(sourceAlias).EnqueueAsync(reference, destination, cancellationToken); }
        catch (TransferException error) when (error.Message.Contains("already contains", StringComparison.Ordinal)) { return EnqueueOutcome.AlreadyQueued; }
        Changed?.Invoke();
        _ = PumpAsync();
        return EnqueueOutcome.Added;
    }

    /// <summary>Pauses one item. A running item is signalled at once; a waiting one stops being scheduled.</summary>
    public async Task PauseAsync(TransferItem item)
    {
        lock (sync) { held.Add(item.Job.JobId); wanted.Remove(item.Job.JobId); Stop(item.Job.JobId); }
        await Queue(item.SourceAlias).PauseAsync(item.Job.JobId);
        Changed?.Invoke();
        _ = PumpAsync();
    }

    public async Task CancelAsync(TransferItem item)
    {
        lock (sync) { held.Remove(item.Job.JobId); wanted.Remove(item.Job.JobId); Stop(item.Job.JobId); }
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
        // Registered under the same lock that closing uses, before any await or event: closing either waits for this
        // whole operation (stop and save) or this Pause all never starts.
        var operation = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (sync) {
            if (disposed) return;
            background.Add(operation.Task);
            pauseAlls++;
            running = active;
            waiting = known.Where(item => item.Job.State == QueuedTransferState.Queued || wanted.Contains(item.Job.JobId)).ToList();
            foreach (var item in waiting) held.Add(item.Job.JobId);
            if (running is { } current) held.Add(current.Id);
            wanted.Clear();
        }
        try {
            if (Hooks.BeforeRunningPause is { } before) await before();
            if (running is { } stop) await Queue(stop.Alias).PauseAsync(stop.Id);
            Changed?.Invoke();
        } catch { Settle(operation); throw; }
        // Saving the held items as paused happens afterwards and never delays the stop; the operation stays
        // registered until it finishes.
        _ = Task.Run(async () => {
            try {
                if (Hooks.BeforeHeldPersist is { } hold) await hold();
                foreach (var item in waiting.Where(item => item.Job.State == QueuedTransferState.Queued)) {
                    try {
                        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                        // Every start runs under the pump, so holding it through the save means a resume can't start
                        // this item in between. A resume that came first wins: the item is no longer held, so skip it.
                        await pump.WaitAsync(limit.Token);
                        try {
                            lock (sync) if (!held.Contains(item.Job.JobId) || active?.Id == item.Job.JobId) continue;
                            await Queue(item.SourceAlias).PauseAsync(item.Job.JobId, limit.Token);
                        } finally { pump.Release(); }
                    } catch (Exception) { /* still held in memory; the queue keeps it waiting */ }
                }
                Changed?.Invoke();
            } catch (Exception) { /* an observer failure can't undo the saves */ }
            finally { Hooks.HeldSaveSettled?.Invoke(); Settle(operation); }
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
        // This explicit request is the newest intent now; a Pause all or stop after it still wins.
        StartIntent intent;
        lock (sync) { held.Remove(item.Job.JobId); wanted.Remove(item.Job.JobId); intent = Intent(item.Job.JobId); }
        await pump.WaitAsync();
        try {
            (string Alias, Guid Id)? running; lock (sync) running = active;
            if (running is { } current && current.Id != item.Job.JobId) {
                lock (sync) { if (!wanted.Contains(current.Id)) wanted.Insert(0, current.Id); }
                await Queue(current.Alias).PauseAsync(current.Id);
            }
            await Start(item, intent);
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
            if (Hooks.AfterSnapshot is { } pause) await pause();
            TransferItem? next; StartIntent intent = default;
            lock (sync) {
                // Closing may have begun during the snapshot's sign-in check.
                if (disposed) return;
                if (items.Any(item => item.Job.State == QueuedTransferState.Running)) return;
                next = wanted.Select(id => items.FirstOrDefault(item => item.Job.JobId == id))
                        .FirstOrDefault(item => item is { Job.State: QueuedTransferState.Paused or QueuedTransferState.Queued })
                    ?? items.FirstOrDefault(item => item.Job.State == QueuedTransferState.Queued && !held.Contains(item.Job.JobId));
                wanted.RemoveAll(id => !items.Any(item => item.Job.JobId == id && item.Job.State is QueuedTransferState.Paused or QueuedTransferState.Queued));
                if (next is not null) intent = Intent(next.Job.JobId);
            }
            if (next is not null) await Start(next, intent);
        } catch (Exception) {
            // A session problem surfaces through the items' own states on the next refresh.
            Changed?.Invoke();
        } finally { pump.Release(); }
    }

    private async Task Start(TransferItem item, StartIntent intent)
    {
        try { await StartCore(item, intent); }
        finally { Hooks.StartSettled?.Invoke(item.Job.JobId); }
    }

    private async Task StartCore(TransferItem item, StartIntent intent)
    {
        var queue = Queue(item.SourceAlias); var id = item.Job.JobId;
        if (Hooks.BeforeStart is { } before) await before();
        // Under the lock that closing and every stop use: a stop or Pause all newer than this start's intent wins
        // and it never begins. Otherwise the queue's own stop order is captured before this start is published as
        // active, so a stop that sees it active still supersedes it if the queue hasn't begun yet.
        TransferQueue.StartReservation reservation;
        lock (sync) {
            if (disposed || held.Contains(id) || !IsCurrent(intent)) return;
            reservation = queue.PrepareStart(id);
            wanted.Remove(id); active = (item.SourceAlias, id);
        }
        Hooks.Starting?.Invoke(id);
        try {
            if (Hooks.AfterStartPublished is { } published) await published();
            await queue.StartAsync(reservation, new Relay(progress => Progress?.Invoke(id, progress)));
        } catch {
            bool superseded;
            lock (sync) { active = null; superseded = !IsCurrent(intent); }
            // A newer stop or Pause all already decided this item; that isn't a failure to report.
            if (superseded) { Changed?.Invoke(); return; }
            throw;
        }
        Changed?.Invoke();
        _ = Task.Run(async () => {
            try { await queue.WaitForIdleAsync(); } catch (Exception) { /* reported through the item's state */ }
            lock (sync) if (active?.Id == id) active = null;
            Changed?.Invoke();
            await PumpAsync();
        });
    }

    /// <summary>One plain file name: no folder, drive, device, hidden direction marks or Windows-reserved characters.</summary>
    internal static bool IsPlainFileName(string name)
    {
        if (string.IsNullOrEmpty(name) || name.Length > 150 || name is "." or ".." || name.EndsWith('.') || name.EndsWith(' ')
            || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.IndexOfAny(['/', '\\', ':', '<', '>', '"', '|', '?', '*']) >= 0) return false;
        for (var index = 0; index < name.Length;) {
            if (!System.Text.Rune.TryGetRuneAt(name, index, out var rune)) return false;
            if (System.Text.Rune.GetUnicodeCategory(rune) is System.Globalization.UnicodeCategory.Control or System.Globalization.UnicodeCategory.Format
                or System.Globalization.UnicodeCategory.LineSeparator or System.Globalization.UnicodeCategory.ParagraphSeparator) return false;
            index += rune.Utf16SequenceLength;
        }
        var stem = name.Split('.')[0].TrimEnd(' ').ToUpperInvariant();
        return stem is not ("CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$")
            && !System.Text.RegularExpressions.Regex.IsMatch(stem, @"\A(?:COM|LPT)[1-9¹²³]\z");
    }

    private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

    // Call under sync.
    private void Stop(Guid id) => stops[id] = stops.GetValueOrDefault(id) + 1;
    private StartIntent Intent(Guid id) => new(id, pauseAlls, stops.GetValueOrDefault(id));
    private bool IsCurrent(StartIntent intent) => intent.PauseAlls == pauseAlls && intent.Stops == stops.GetValueOrDefault(intent.Id);

    private void Settle(TaskCompletionSource operation)
    {
        lock (sync) background.Remove(operation.Task);
        operation.TrySetResult();
    }

    private TransferQueue Queue(string alias) =>
        queues.TryGetValue(alias, out var queue) ? queue : throw new InvalidOperationException("Unknown download source.");

    /// <summary>
    /// Stops and drains this person's transfers and releases their queues. The running transfer is signalled
    /// first, without any sign-in check, so it stops even while the session is unreachable.
    /// </summary>
    public ValueTask DisposeAsync()
    {
        // Every caller waits for the one real shutdown, not just the first.
        lock (sync) { if (!disposed) { disposed = true; disposal = DrainAndReleaseAsync(active); } }
        return new(disposal!);
    }

    private async Task DrainAndReleaseAsync((string Alias, Guid Id)? running)
    {
        await Task.Yield(); // Never run queue stops or callbacks while the caller holds sync.
        if (running is { } stop) {
            try { await Queue(stop.Alias).PauseAsync(stop.Id); } catch (Exception) { /* draining below still stops it */ }
        }
        // Pause all saves waiting items as paused in the background; finish that before the queues close,
        // or those items would wait as queued and start by themselves next time.
        Task[] saving; lock (sync) saving = background.ToArray();
        foreach (var save in saving) { try { await save; } catch (Exception) { /* each save handles its own failures */ } }
        // Release every source's queue even if one fails to save its final state; report the first failure.
        Exception? failure = null;
        foreach (var queue in queues.Values) {
            try { await queue.DisposeAsync(); } catch (Exception error) { failure ??= error; }
        }
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(failure);
    }

    /// <summary>Synchronous progress relay so updates aren't reordered by a captured context.</summary>
    private sealed class Relay(Action<DownloadProgress> report) : IProgress<DownloadProgress>
    {
        public void Report(DownloadProgress value) => report(value);
    }
}
