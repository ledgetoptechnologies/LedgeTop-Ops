using System.Threading.Channels;

namespace LedgeTop.Files.Explorer;

internal readonly record struct AvailabilityObservation(AvailabilityIntent Intent, bool Required);

// Manifest-bounded and fixed four workers: no task per scanned file. Neither this gate nor
// failed-intent suppression is used by FETCH_DATA callbacks or source authorization.
internal sealed class BoundedAvailabilityWorkers
{
    private sealed class Entry
    {
        internal readonly SemaphoreSlim Gate = new(1, 1);
        internal AvailabilityIntent Intent;
        internal long Generation;
        internal bool Scheduled;
        internal TaskCompletionSource? Joined;
    }
    private readonly record struct Job(string Path, AvailabilityIntent Intent, long Generation);
    private readonly record struct Completion(Job Job, bool Failed);
    private readonly object sync = new();
    private readonly Dictionary<string, Entry> entries;
    private readonly Queue<Completion> completed = new();
    private readonly FailedAvailabilityIntents failures;
    private readonly Channel<Job> queue;
    private readonly CancellationTokenSource stop = new();
    private readonly SemaphoreSlim admission = new(4, 4);
    private readonly Task[] workers;
    private readonly Func<string, AvailabilityObservation> inspect;
    private readonly Func<string, AvailabilityIntent, CancellationToken, Task> execute;
    private readonly Action<Exception> report;
    private bool stopped;
    private Task? closing;

    internal BoundedAvailabilityWorkers(IEnumerable<string> manifest, Func<string, AvailabilityObservation> inspect,
        Func<string, AvailabilityIntent, CancellationToken, Task> execute, Action<Exception> report)
    {
        entries = manifest.ToDictionary(path => path, _ => new Entry(), StringComparer.OrdinalIgnoreCase);
        if (entries.Count > 1000) throw new ArgumentException("Availability manifest is too large.");
        this.inspect = inspect; this.execute = execute; this.report = report;
        failures = new(entries.Keys);
        queue = Channel.CreateBounded<Job>(new BoundedChannelOptions(1000) {
            SingleWriter = true, SingleReader = false, FullMode = BoundedChannelFullMode.Wait
        });
        workers = [Task.Run(WorkerAsync), Task.Run(WorkerAsync), Task.Run(WorkerAsync), Task.Run(WorkerAsync)];
    }

    // The caller supplies paths only after validating the owning catalog transition.
    // This is not a filesystem operation or an authorization grant. Admission is atomic
    // with observation and shutdown, and never changes existing entries or their intents.
    internal void AddKnownPaths(IEnumerable<string> paths)
    {
        ArgumentNullException.ThrowIfNull(paths);
        lock (sync) if (stopped) throw new IOException("Availability changes are stopping.");
        // Do not hold the shutdown lock while enumerating caller-controlled input.
        // Bound the copy even for an unending enumerable and publish only after it completes.
        var additions = paths.Take(1001).ToArray();
        var unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (additions.Length > 1000 || additions.Any(path => string.IsNullOrWhiteSpace(path) || !unique.Add(path)))
            throw new ArgumentException("Availability additions are invalid or exceed the manifest limit.");
        lock (sync) {
            if (stopped) throw new IOException("Availability changes are stopping.");
            if (additions.Length > 1000 - entries.Count || additions.Any(entries.ContainsKey))
                throw new ArgumentException("Availability additions are invalid or exceed the manifest limit.");
            foreach (var path in additions) entries.Add(path, new Entry());
            failures.AddKnown(additions);
        }
    }

    // Called only by the single scanner. Completion records carry the attempted generation,
    // so an old failure cannot suppress a new intent observed while that attempt was active.
    internal bool Observe(string path, AvailabilityObservation observation)
    {
        lock (sync) {
            if (stopped) return false;
            if (!entries.TryGetValue(path, out var entry) || !Enum.IsDefined(observation.Intent))
                throw new ArgumentException("Availability observation is outside the manifest.");
            while (completed.TryDequeue(out var result)) {
                var attempted = entries[result.Job.Path];
                if (result.Failed && attempted.Generation == result.Job.Generation && attempted.Intent == result.Job.Intent)
                    failures.MarkFailed(result.Job.Path, result.Job.Intent);
            }
            if (observation.Intent != AvailabilityIntent.Unknown && entry.Intent != observation.Intent) { entry.Intent = observation.Intent; entry.Generation++; }
            var attempt = failures.ShouldAttempt(path, observation.Intent);
            if (!attempt || !observation.Required || entry.Scheduled) return false;
            entry.Scheduled = true; entry.Joined = new(TaskCreationOptions.RunContinuationsAsynchronously);
            if (!queue.Writer.TryWrite(new(path, observation.Intent, entry.Generation))) {
                entry.Scheduled = false; entry.Joined.TrySetResult();
                throw new IOException("Availability queue is at capacity.");
            }
            return true;
        }
    }

    // Explicit user request only. The next scan re-reads actual Windows pin
    // attributes; a previous in-flight failure cannot suppress the new request.
    internal bool RetryFailedIntents()
    {
        lock (sync) {
            if (stopped) return false;
            failures.Clear(); completed.Clear();
            foreach (var entry in entries.Values)
                if (entry.Intent is AvailabilityIntent.Keep or AvailabilityIntent.Free) entry.Generation++;
            return true;
        }
    }

    // Public availability operations use the same path gate; the native hydration callback
    // deliberately does not. Callers must track/join these operations before final drain.
    internal async Task RunExclusiveAsync(string path, Func<CancellationToken, Task> operation, CancellationToken token = default)
    {
        Entry entry; CancellationTokenSource linked;
        lock (sync) {
            if (stopped) throw new IOException("Availability changes are stopping.");
            if (!entries.TryGetValue(path, out entry!)) throw new IOException("Availability path is outside the manifest.");
            linked = CancellationTokenSource.CreateLinkedTokenSource(stop.Token, token);
        }
        using (linked) {
            await entry.Gate.WaitAsync(linked.Token).ConfigureAwait(false);
            var admitted = false;
            try {
                await admission.WaitAsync(linked.Token).ConfigureAwait(false); admitted = true;
                linked.Token.ThrowIfCancellationRequested(); await operation(linked.Token).ConfigureAwait(false);
            } finally { if (admitted) admission.Release(); entry.Gate.Release(); }
        }
    }

    private async Task WorkerAsync()
    {
        try {
            await foreach (var job in queue.Reader.ReadAllAsync(stop.Token).ConfigureAwait(false)) {
                Entry entry; lock (sync) entry = entries[job.Path];
                var acquired = false; var admitted = false; var inspecting = false; var executing = false; var failed = false;
                try {
                    await entry.Gate.WaitAsync(stop.Token).ConfigureAwait(false); acquired = true;
                    await admission.WaitAsync(stop.Token).ConfigureAwait(false); admitted = true;
                    stop.Token.ThrowIfCancellationRequested();
                    inspecting = true;
                    var current = inspect(job.Path); // Re-read AFTER the per-path availability wait.
                    inspecting = false;
                    lock (sync) {
                        if (stopped || current.Intent != job.Intent || !current.Required ||
                            entry.Intent != job.Intent || entry.Generation != job.Generation) continue;
                    }
                    executing = true;
                    // A synchronous CfHydratePlaceholder may block here. Never detach or
                    // stop awaiting it when cancellation arrives; disconnect must release it.
                    await execute(job.Path, job.Intent, stop.Token).ConfigureAwait(false);
                } catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
                catch (Exception error) {
                    failed = inspecting || executing;
                    try { report(error); } catch { }
                } finally {
                    if (admitted) admission.Release();
                    if (acquired) entry.Gate.Release();
                    lock (sync) {
                        entry.Scheduled = false;
                        // At most one completion per scheduled manifest entry; Observe drains
                        // before rescheduling. No unbounded activity/task history is retained.
                        completed.Enqueue(new(job, failed)); entry.Joined?.TrySetResult();
                    }
                }
            }
        } catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    // A join is only lifecycle evidence, never a native availability receipt.
    internal Task WhenJoinedAsync(string path)
    {
        lock (sync) return entries.TryGetValue(path, out var entry) ? entry.Joined?.Task ?? Task.CompletedTask
            : throw new ArgumentException("Availability path is outside the manifest.");
    }

    internal void StopAdmission()
    {
        lock (sync) { if (stopped) return; stopped = true; queue.Writer.TryComplete(); }
    }

    internal Task StopAndDrainAsync(Func<Task> disconnectCallbacks, Func<Task> joinExplicit)
    {
        TaskCompletionSource completion;
        lock (sync) {
            if (closing is not null) return closing;
            completion = new(TaskCreationOptions.RunContinuationsAsynchronously); closing = completion.Task;
        }
        _ = StopCoreAsync(disconnectCallbacks, joinExplicit, completion);
        return completion.Task;
    }
    private async Task StopCoreAsync(Func<Task> disconnectCallbacks, Func<Task> joinExplicit, TaskCompletionSource completion)
    {
        try {
            StopAdmission();
            Exception? cancellationFailure = null;
            try { stop.Cancel(); } catch (Exception error) { cancellationFailure = error; }
            // Cancellation callbacks are notifications, not permission to skip native
            // disconnect. Even a throwing callback must not strand a blocking worker.
            // Native hydrate workers can depend on callback disconnect; reversing these
            // awaits deadlocks shutdown. A failed disconnect retains uncertain ownership.
            await disconnectCallbacks().ConfigureAwait(false);
            await joinExplicit().ConfigureAwait(false);
            await Task.WhenAll(workers).ConfigureAwait(false);
            lock (sync) { while (queue.Reader.TryRead(out _)) { } foreach (var entry in entries.Values) { entry.Scheduled = false; entry.Joined?.TrySetResult(); } completed.Clear(); }
            foreach (var entry in entries.Values) entry.Gate.Dispose();
            admission.Dispose(); stop.Dispose();
            if (cancellationFailure is not null) completion.TrySetException(cancellationFailure);
            else completion.TrySetResult();
        } catch (Exception error) { completion.TrySetException(error); }
    }
}
