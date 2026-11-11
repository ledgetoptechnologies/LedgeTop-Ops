using LedgeTop.Files;
using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;

internal static class ExplorerInstalledUpdateControllerTests
{
    internal static async Task Run()
    {
        var binding = new ConnectedExplorerUpdateBinding("pilot", "portal", "odqp1_" + new string('a', 64));
        var created = 0; var checks = 0;
        Task<WindowsAppReleaseCheck> Check(ConnectedExplorerUpdateBinding observed, CancellationToken token)
        {
            Require(observed == binding, "check receives freshly observed source identity");
            checks++; return Task.FromResult(new WindowsAppReleaseCheck(WindowsAppReleaseStatus.NoRelease, "0.5.3.0"));
        }
        ExeUpdateHandoffCoordinator UnexpectedCreate(ConnectedExplorerUpdateBinding _)
        { created++; throw new Exception("No adapter may be created before a successful binding."); }
        var held = new TaskCompletionSource<ConnectedExplorerUpdateBinding>(TaskCreationOptions.RunContinuationsAsynchronously);
        var actions = new ExplorerInstalledUpdateController(token => held.Task.WaitAsync(token), Check, UnexpectedCreate).Actions("0.5.3.0");
        using (var cancel = new CancellationTokenSource()) {
            var pending = actions.InstallAsync(cancel.Token);
            Require(!pending.IsCompleted, "install is waiting for fresh binding");
            cancel.Cancel(); var result = await pending;
            Require(result == new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.Postponed, false), "quit during binding is safe postponed, never uncertain helper");
        }
        actions = new ExplorerInstalledUpdateController(_ => Task.FromException<ConnectedExplorerUpdateBinding>(new IOException("private failure")), Check, UnexpectedCreate).Actions("0.5.3.0");
        Require(await actions.InstallAsync(default) == new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.PreparationFailed, false), "binding refusal returns only typed preparation failure");
        Require(created == 0 && checks == 0, "failed or cancelled binding never constructs platform or checks feed");

        var platform = new NeverEnteredPlatform();
        using (var cancel = new CancellationTokenSource()) {
            actions = new ExplorerInstalledUpdateController(_ => Task.FromResult(binding), Check, _ => {
                cancel.Cancel(); return new ExeUpdateHandoffCoordinator(platform);
            }).Actions("0.5.3.0");
            Require(await actions.InstallAsync(cancel.Token) == new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.Postponed, false) && platform.Calls == 0,
                "cancellation crossing coordinator creation returns safe postponed before any platform call");
        }
        actions = new ExplorerInstalledUpdateController(_ => Task.FromResult(binding), Check, UnexpectedCreate).Actions("0.5.3.0");
        Require((await actions.CheckAsync(default)).Status == WindowsAppReleaseStatus.NoRelease && checks == 1 && created == 0,
            "metadata check uses selected binding without creating install capability");
        Console.WriteLine("Installed update parent cancellation regressions passed; injected delegates only.");
    }
    private static void Require(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class NeverEnteredPlatform : IExeUpdateHandoffPlatform
    {
        internal int Calls;
        private Exception Unexpected() { Calls++; return new Exception("Cancelled coordinator entered platform."); }
        public Task<IAsyncDisposable?> TryEnterMaintenanceAsync(CancellationToken token) => throw Unexpected();
        public Task<ExeUpdatePreparation> PrepareFreshAsync(CancellationToken token) => throw Unexpected();
        public Task StageHandoffAsync(ExeUpdateHandoff handoff, CancellationToken token) => throw Unexpected();
        public Task DrainAndDisconnectAsync() => throw Unexpected();
        public Task<IExeUpdateBoundary?> VerifyBoundaryAsync(ExeUpdateCandidate candidate, CancellationToken token) => throw Unexpected();
        public Task<IExeUpdateHelperReservation?> LaunchHelperAsync(ExeUpdateHandoff handoff, IExeUpdateBoundary boundary, CancellationToken token) => throw Unexpected();
        public Task<ExeUpdateParentExitDecision> RequestParentExitAsync(ExeUpdateHandoff handoff) => throw Unexpected();
        public Task<bool> RecoverProviderAsync() => throw Unexpected();
        public Task RetireHandoffAsync(ExeUpdateHandoff handoff) => throw Unexpected();
    }
}
