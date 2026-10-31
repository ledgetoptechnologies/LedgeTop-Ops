using LedgeTop.Files.Updates;

namespace LedgeTop.Files;

internal enum ExplorerUpdateScheduleState { Waiting, Disabled, Checking, Installing, NeedsReview, Stopped }
internal sealed record ExplorerUpdateScheduleStatus(ExplorerUpdateScheduleState State, bool AutoUpdatesEnabled, DateTimeOffset? NextDueUtc, string? Issue);
internal readonly record struct ExplorerUpdateScheduleEligibility(bool Connected, bool Busy, bool Maintenance, bool Quitting)
{ internal bool CanRun => Connected && !Busy && !Maintenance && !Quitting; }

internal static class ExplorerUpdateSchedulePolicy
{
    internal static readonly TimeSpan Interval = TimeSpan.FromHours(6);
    internal static readonly TimeSpan Retry = TimeSpan.FromHours(1);
    internal static DateTimeOffset Initial(DateTimeOffset now, TimeSpan jitter)
    {
        if (now.Offset != TimeSpan.Zero || jitter < TimeSpan.Zero || jitter > TimeSpan.FromMinutes(2)) throw new ArgumentOutOfRangeException(nameof(jitter));
        return now + TimeSpan.FromMinutes(2) + jitter;
    }
}

// No timer, authentication, staging or installation lives here. Runtime callbacks own their existing
// source/maintenance fences. Eligibility is sampled again after checking, before the install callback.
internal sealed class ExplorerUpdateScheduleController
{
    private readonly object gate = new();
    private readonly ExplorerUpdateScheduleSettingsStore store;
    private readonly Func<DateTimeOffset> utcNow;
    private readonly Func<ExplorerUpdateScheduleEligibility> eligibility;
    private readonly Func<CancellationToken, Task<bool>> check;
    private readonly Func<CancellationToken, Task<ExeUpdateHandoffResult>> install;
    private ExplorerUpdateScheduleStatus status;
    private CancellationTokenSource? cancellation;
    private Task active = Task.CompletedTask;
    private bool stopped, uncertain;
    internal ExplorerUpdateScheduleController(ExplorerUpdateScheduleSettingsStore store, Func<DateTimeOffset> utcNow, TimeSpan initialJitter,
        Func<ExplorerUpdateScheduleEligibility> eligibility, Func<CancellationToken, Task<bool>> check,
        Func<CancellationToken, Task<ExeUpdateHandoffResult>> install)
    {
        this.store = store; this.utcNow = utcNow; this.eligibility = eligibility; this.check = check; this.install = install;
        var loaded = store.Load();
        status = new(loaded.Issue is not null ? ExplorerUpdateScheduleState.NeedsReview : loaded.Settings.AutoUpdatesEnabled ? ExplorerUpdateScheduleState.Waiting : ExplorerUpdateScheduleState.Disabled,
            loaded.Settings.AutoUpdatesEnabled, loaded.Settings.NextDueUtc, loaded.Issue);
        if (loaded.Issue is null && !status.AutoUpdatesEnabled && status.NextDueUtc is null) {
            uncertain = true;
            status = status with { State = ExplorerUpdateScheduleState.NeedsReview, Issue = "An earlier update needs review. Automatic attempts are paused." };
        }
        if (loaded.Issue is null && status.AutoUpdatesEnabled && status.NextDueUtc is null) {
            try { Persist(true, ExplorerUpdateSchedulePolicy.Initial(Now(), initialJitter)); }
            catch { StorageFailed(); }
        }
    }
    internal ExplorerUpdateScheduleStatus Status { get { lock (gate) return status; } }
    internal Task TickAsync()
    {
        lock (gate) {
            if (stopped || uncertain || status.Issue is not null || !status.AutoUpdatesEnabled || !active.IsCompleted || status.NextDueUtc is not { } due || Now() < due || !eligibility().CanRun)
                return Task.CompletedTask;
            // Save the retry reservation BEFORE any callback, including across process restart.
            try { Persist(true, Now() + ExplorerUpdateSchedulePolicy.Retry); }
            catch { StorageFailed(); return Task.CompletedTask; }
            var source = cancellation = new();
            status = status with { State = ExplorerUpdateScheduleState.Checking };
            // Publish active before any callback can synchronously reenter Stop/SetEnabled/Tick.
            var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            active = completion.Task;
            _ = RunAsync(source, completion); return active;
        }
    }
    internal async Task SetEnabledAsync(bool enabled)
    {
        Task joining; CancellationTokenSource? source;
        lock (gate) {
            if (stopped || uncertain || status.Issue is not null) return;
            try { Persist(enabled, enabled ? ExplorerUpdateSchedulePolicy.Initial(Now(), TimeSpan.Zero) : status.NextDueUtc ?? ExplorerUpdateSchedulePolicy.Initial(Now(), TimeSpan.Zero)); }
            catch { StorageFailed(); return; }
            source = !enabled ? cancellation : null; joining = active;
        }
        Cancel(source);
        if (!enabled) await joining.ConfigureAwait(false);
    }
    internal async Task StopAsync()
    {
        Task joining; CancellationTokenSource? source;
        lock (gate) { stopped = true; joining = active; source = cancellation; }
        Cancel(source); await joining.ConfigureAwait(false);
        lock (gate) if (!uncertain && status.Issue is null) status = status with { State = ExplorerUpdateScheduleState.Stopped };
    }
    private async Task RunAsync(CancellationTokenSource source, TaskCompletionSource completion)
    {
        var enteredInstall = false;
        try {
            // Give TickAsync time to publish active and release its gate before invoking owner code.
            await Task.Yield();
            source.Token.ThrowIfCancellationRequested();
            var available = await check(source.Token);
            source.Token.ThrowIfCancellationRequested();
            lock (gate) {
                if (stopped || !status.AutoUpdatesEnabled || !eligibility().CanRun) return;
                if (available) { enteredInstall = true; status = status with { State = ExplorerUpdateScheduleState.Installing }; }
            }
            if (!available) { CompleteSafe(ExplorerUpdateSchedulePolicy.Interval); return; }
            var result = await install(source.Token);
            // A typed positive disarm/recovery result is required even when cancellation was requested.
            if (result.Status == ExeUpdateHandoffStatus.ParentExitRequested) {
                lock (gate) stopped = true; // Successful final exit: the next app retains the enabled reservation.
            } else if (!Enum.IsDefined(result.Status) || result.Status is ExeUpdateHandoffStatus.RecoveryBlocked or ExeUpdateHandoffStatus.ExitUncertain)
                MarkUncertain();
            else CompleteSafe(result.Status is ExeUpdateHandoffStatus.NoUpdate or ExeUpdateHandoffStatus.Postponed ? ExplorerUpdateSchedulePolicy.Interval : ExplorerUpdateSchedulePolicy.Retry);
        } catch (OperationCanceledException) when (!enteredInstall) { CompleteSafe(ExplorerUpdateSchedulePolicy.Retry); }
        catch {
            if (enteredInstall) MarkUncertain();
            else CompleteSafe(ExplorerUpdateSchedulePolicy.Retry);
        } finally {
            lock (gate) {
                if (ReferenceEquals(cancellation, source)) cancellation = null;
                if (!uncertain && status.Issue is null) status = status with { State = stopped ? ExplorerUpdateScheduleState.Stopped : status.AutoUpdatesEnabled ? ExplorerUpdateScheduleState.Waiting : ExplorerUpdateScheduleState.Disabled };
                source.Dispose(); completion.TrySetResult();
            }
        }
    }
    private void CompleteSafe(TimeSpan delay)
    {
        lock (gate) {
            if (uncertain || status.Issue is not null) return;
            try { Persist(status.AutoUpdatesEnabled, Now() + delay); }
            catch { StorageFailed(); }
        }
    }
    private void MarkUncertain()
    {
        lock (gate) {
            uncertain = true;
            // A diagnostic pause survives restart, but never substitutes for the actual helper gate.
            // false/null is reserved for this pause; ordinary disable always saves a nonnull due time.
            try { Persist(false, null); } catch { /* Keep the in-memory stop sticky even if the disk failed. */ }
            status = status with { State = ExplorerUpdateScheduleState.NeedsReview, AutoUpdatesEnabled = false,
                Issue = "The update needs review. Automatic attempts are paused. Keep this app open." };
        }
    }
    private void StorageFailed() => status = new(ExplorerUpdateScheduleState.NeedsReview, false, null, "Automatic update settings could not be saved. Automatic updates are paused.");
    private void Cancel(CancellationTokenSource? source)
    {
        try { source?.Cancel(); } catch (ObjectDisposedException) { /* The admitted callback finished before cancellation. */ }
        catch { MarkUncertain(); } // Cancellation callbacks can fail; still join the admitted operation.
    }
    private void Persist(bool enabled, DateTimeOffset? due)
    {
        store.Save(new(enabled, due));
        status = status with { AutoUpdatesEnabled = enabled, NextDueUtc = due, State = enabled ? ExplorerUpdateScheduleState.Waiting : ExplorerUpdateScheduleState.Disabled };
    }
    private DateTimeOffset Now()
    {
        var now = utcNow();
        if (now.Offset != TimeSpan.Zero || now < DateTimeOffset.UnixEpoch) throw new InvalidOperationException("Update clock refused.");
        return now;
    }
}
