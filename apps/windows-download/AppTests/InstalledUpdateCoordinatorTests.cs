using LedgeTop.Files.Updates;

internal static class InstalledUpdateCoordinatorTests
{
    internal static async Task Run()
    {
        foreach (var state in Enum.GetValues<InstalledUpdateStatus>()) {
            var fixture = new Fixture { Status = state };
            var result = await fixture.Owner.ApplyAsync(default);
            if (state is InstalledUpdateStatus.Available or InstalledUpdateStatus.Required) {
                Require(result == InstalledUpdateApplyStatus.RestartAccepted &&
                    string.Join(',', fixture.Log) == "check,stage,drain,restart", "only available updates stage, drain and restart in order");
                await fixture.Owner.ApplyAsync(default);
                Require(fixture.Log.Count == 4, "an accepted restart is not requested twice");
            } else Require(fixture.Log.SequenceEqual(new[] { "check" }) &&
                result == (state == InstalledUpdateStatus.Current ? InstalledUpdateApplyStatus.NoUpdate : InstalledUpdateApplyStatus.Unavailable),
                "unknown, error, unconfigured and unsupported states never look current or stop downloads");
        }
        var stageFailure = new Fixture { StageFailure = true };
        Require(await stageFailure.Owner.ApplyAsync(default) == InstalledUpdateApplyStatus.StageFailed &&
            string.Join(',', stageFailure.Log) == "check,stage", "stage failure keeps provider running");

        var drainFailure = new Fixture { DrainFailure = true };
        Require(await drainFailure.Owner.ApplyAsync(default) == InstalledUpdateApplyStatus.DrainFailed &&
            !drainFailure.Log.Contains("restart"), "failed drain prevents restart");
        drainFailure.DrainFailure = false;
        Require(await drainFailure.Owner.ApplyAsync(default) == InstalledUpdateApplyStatus.RestartAccepted &&
            drainFailure.Log.Count(item => item == "stage") == 1 && drainFailure.Log.Count(item => item == "drain") == 2,
            "failed drain retains staged handoff and can retry without redeployment");

        var restartRefused = new Fixture { RestartResult = false };
        Require(await restartRefused.Owner.ApplyAsync(default) == InstalledUpdateApplyStatus.RestartPostponed,
            "restart refusal never claims a running new version");
        restartRefused.RestartResult = true;
        Require(await restartRefused.Owner.ApplyAsync(default) == InstalledUpdateApplyStatus.RestartAccepted &&
            restartRefused.Log.Count(item => item == "stage") == 1, "postponed handoff can retry");

        var restartThrows = new Fixture { RestartFailure = true };
        Require(await restartThrows.Owner.ApplyAsync(default) == InstalledUpdateApplyStatus.RestartPostponed,
            "restart adapter failure leaves the drained handoff postponed");
        restartThrows.RestartFailure = false;
        Require(await restartThrows.Owner.ApplyAsync(default) == InstalledUpdateApplyStatus.RestartAccepted &&
            restartThrows.Log.Count(item => item == "stage") == 1, "restart exception releases the operation gate for retry");

        using var afterCheck = new CancellationTokenSource();
        var canceledCheck = new Fixture { AfterCheck = afterCheck.Cancel };
        await Canceled(() => canceledCheck.Owner.ApplyAsync(afterCheck.Token));
        Require(canceledCheck.Log.SequenceEqual(new[] { "check" }), "canceled availability result never starts deployment");

        using var beforeDrain = new CancellationTokenSource();
        var canceledStage = new Fixture { AfterStage = beforeDrain.Cancel };
        await Canceled(() => canceledStage.Owner.ApplyAsync(beforeDrain.Token));
        Require(!canceledStage.Log.Contains("drain"), "cancellation before drain preserves current provider");
        Require(await canceledStage.Owner.ApplyAsync(default) == InstalledUpdateApplyStatus.RestartAccepted &&
            canceledStage.Log.Count(item => item == "stage") == 1, "completed stage survives canceled drain boundary");

        using var duringDrain = new CancellationTokenSource();
        var drained = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var concurrent = new Fixture { DrainWork = async () => { drained.SetResult(); await release.Task; } };
        var first = concurrent.Owner.ApplyAsync(duringDrain.Token);
        await drained.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var second = concurrent.Owner.ApplyAsync(default);
        using var queuedCancellation = new CancellationTokenSource();
        var queued = concurrent.Owner.ApplyAsync(queuedCancellation.Token);
        queuedCancellation.Cancel();
        await Canceled(() => queued);
        duringDrain.Cancel();
        Require(!first.IsCompleted && !second.IsCompleted && !concurrent.Log.Contains("restart"),
            "cancellation observes pending drain and concurrent update waits");
        // Second drain uses an idempotent provider-disposal callback.
        concurrent.DrainWork = null; release.SetResult();
        Require(await first.WaitAsync(TimeSpan.FromSeconds(10)) == InstalledUpdateApplyStatus.RestartPostponed &&
            await second.WaitAsync(TimeSpan.FromSeconds(10)) == InstalledUpdateApplyStatus.RestartAccepted &&
            concurrent.Log.Count(item => item == "stage") == 1, "serialized retry restarts only after drained cancellation");

        var unconfigured = new WindowsInstalledUpdatePlatform(null);
        Require((await unconfigured.CheckAsync(default)).Status == InstalledUpdateStatus.NotConfigured,
            "unconfigured adapter performs no installed package or network calls");
        Console.WriteLine("Installed update lifecycle: status admission, stage failure, drain failure/retry, restart refusal/retry, cancellation and concurrent handoff passed. Fake deployment/restart only.");
    }

    private static async Task Canceled(Func<Task<InstalledUpdateApplyStatus>> work)
    {
        try { await work(); } catch (OperationCanceledException) { return; }
        throw new Exception("Expected cancellation.");
    }
    private static void Require(bool condition, string reason) { if (!condition) throw new Exception(reason); }

    private sealed class Fixture : IInstalledUpdatePlatform
    {
        internal readonly List<string> Log = [];
        internal InstalledUpdateStatus Status = InstalledUpdateStatus.Available;
        internal bool StageFailure, DrainFailure, RestartFailure, RestartResult = true;
        internal Action? AfterStage, AfterCheck;
        internal Func<Task>? DrainWork;
        internal InstalledUpdateCoordinator Owner { get; }
        internal Fixture() => Owner = new(this, async () => {
            Log.Add("drain"); if (DrainFailure) throw new IOException();
            if (DrainWork is { } work) await work();
        }, _ => { Log.Add("restart"); if (RestartFailure) throw new IOException(); return Task.FromResult(RestartResult); });
        public Task<InstalledUpdateCheck> CheckAsync(CancellationToken cancellationToken)
        { Log.Add("check"); AfterCheck?.Invoke(); return Task.FromResult(new InstalledUpdateCheck(Status, "1.0.0.0")); }
        public Task StageDeferredAsync(CancellationToken cancellationToken)
        { Log.Add("stage"); if (StageFailure) throw new IOException(); AfterStage?.Invoke(); return Task.CompletedTask; }
    }
}
